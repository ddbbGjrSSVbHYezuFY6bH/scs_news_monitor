import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { timestampUtc, validateTimestamp, latestStandard } from '../src/batch-index-v2.mjs';
import { refreshV2 } from '../src/refresh-news-v2.mjs';

test('timestamps are exactly 14 UTC digits and invalid calendar values are rejected', () => {
  assert.equal(timestampUtc('2026-11-03T12:34:56-05:00'), '20261103173456');
  assert.equal(validateTimestamp('20261103173456'), '20261103173456');
  for (const value of ['20260230000000', '202611031734', '../20261103173456']) assert.throws(() => validateTimestamp(value));
});

const config = normalizeConfig({ schemaVersion: 1, queries: [{ id: 'one', query: 'news' }] }, { schemaVersion: 1, queries: [] });
const batch = () => ({ request: { mode: 'active', status: 'completed', requestId: 'r1', runTimestamp: '20261103120000',
  startedAt: '2026-11-03T12:00:00Z', completedAt: '2026-11-03T12:01:00Z', manifestPath: 'runs/v2/20261103120000/r1.json' },
  results: [{ queryId: 'one', configHash: config.queries[0].configHash, status: 'completed' }] });

test('only a complete, nonempty, current standard batch updates the daily pointer', () => {
  assert.equal(latestStandard(null, batch(), config).requestId, 'r1');
  for (const change of [b => b.request.mode = 'custom', b => b.request.status = 'partial',
    b => b.results = [], b => b.results[0].configHash = 'old', b => b.results[0].status = 'failed']) {
    const candidate = batch(); change(candidate);
    assert.equal(latestStandard(null, candidate, config), null);
  }
  const previous = { startedAt: '2026-11-04T12:00:00Z', requestId: 'newer' };
  assert.equal(latestStandard(previous, batch(), config), previous);
});

test('v2 writes timestamped manifests plus a compatible request-ID alias', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scs-v2-'));
  await mkdir(path.join(root, 'queries'));
  await writeFile(path.join(root, 'queries/standard.json'), JSON.stringify({ schemaVersion: 1, queries: [{ id: 'one', query: 'news' }] }));
  await writeFile(path.join(root, 'queries/temporary.json'), JSON.stringify({ schemaVersion: 1, queries: [] }));
  const request = await refreshV2(root, [], { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }, {
    now: () => new Date('2026-11-03T12:34:56Z'), client: { feed: async () => [], resolve: async () => {} },
  });
  assert.equal(request.requestId, '20261103123456-123-1');
  assert.equal(request.runTimestamp, '20261103123456');
  assert.equal(request.manifestPath, 'runs/v2/20261103123456/20261103123456-123-1.json');
  const alias = JSON.parse(await readFile(path.join(root, '.local/output/runs', `${request.requestId}.json`), 'utf8'));
  assert.equal(alias.batchType, 'standard');
  assert.equal(alias.schemaVersion, 2);
});

test('publication atomically writes timestamped results and updates the standard pointer only for active runs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scs-v2-publish-'));
  await mkdir(path.join(root, 'queries'));
  const standard = {schemaVersion: 1, queries: [{id: 'one', query: 'news'}]};
  const temporary = {schemaVersion: 1, queries: []};
  await writeFile(path.join(root, 'queries/standard.json'), JSON.stringify(standard));
  await writeFile(path.join(root, 'queries/temporary.json'), JSON.stringify(temporary));
  const data = new Map([['queries/standard.json', standard], ['queries/temporary.json', temporary]]);
  const deps = {now: () => new Date('2026-11-03T12:34:56Z'), client: {feed: async () => [], resolve: async () => {}},
    store: {transaction: async (message, update) => {
      const changes = await update(async (file, fallback) => data.has(file) ? data.get(file) : fallback);
      for (const [file, value] of changes) data.set(file, value);
      return {commit: 'mock'};
    }}};
  const env = {GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1'};
  const first = await refreshV2(root, ['--publish', '--lookback-hours', '72'], env, deps);
  assert.equal(data.get('data/latest-standard.json').requestId, first.requestId);
  assert.equal(data.get('data/latest-standard.json').lookbackHours, 72);
  assert.equal(data.get('data/v2/index.json').topics.one.latestUsable.lookbackHours, 72);
  assert.equal(data.get(`results/v2/20261103123456/${first.requestId}/one.json`).query, '(news) when:3d');
  assert.ok(data.has(`results/v2/20261103123456/${first.requestId}/one.json`));
  assert.ok(data.has(first.manifestPath));
  assert.ok(data.has(`runs/${first.requestId}.json`));
  const pointer = data.get('data/latest-standard.json');
  await refreshV2(root, ['--publish', '--mode', 'custom', '--query', 'Other news'], {...env, GITHUB_RUN_ID: '124'}, deps);
  assert.equal(data.get('data/latest-standard.json'), pointer);
  await assert.rejects(refreshV2(root, ['--publish'], env, deps), /Request ID already exists/);
});
