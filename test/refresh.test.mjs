import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { refresh, readOptions } from '../src/refresh-news.mjs';
import { timestampUtc, resolutionCache } from '../src/results.mjs';

const instant = '2026-11-04T12:00:00Z';
const now = () => new Date(instant);
const document = () => ({ schemaVersion: 1, timezone: 'America/New_York', queries: [
  { id: 'one', query: 'first search' },
  { id: 'temporary', query: 'temporary search', activeUntil: '2026-11-04' },
  { id: 'expired', query: 'expired search', activeUntil: '2026-11-03' },
] });
const article = { title: 'Article', publisher: 'Publisher', publishedAt: '2026-11-04T11:00:00Z',
  googleArticleId: 'A', rssUrl: 'https://news.google.com/rss/articles/A' };
const resolved = { publisherUrl: 'https://publisher.example/article', method: 'rpc' };
const client = () => ({ feed: async () => [article], resolve: async () => resolved });
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const options = (id, extra = []) => readOptions(['--request-id', id, ...extra], {});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'scs-refresh-'));
  await writeFile(path.join(root, 'queries.json'), JSON.stringify(document()));
  return root;
}

function mockStore(initial = new Map()) {
  const data = structuredClone(initial), commits = [];
  return { data, commits, transaction: async (message, update) => {
    const changes = await update(async (file, fallback) => structuredClone(data.has(file) ? data.get(file) : fallback));
    for (const [file, value] of changes) data.set(file, structuredClone(value));
    commits.push([...changes.keys()]);
    return { commit: 'mock-commit', changed: true };
  } };
}

test('UTC timestamps are independent of local timezone and reject invalid values', () => {
  assert.equal(timestampUtc('2026-11-03T12:34:56-05:00'), '20261103173456');
  assert.throws(() => timestampUtc('invalid'));
});

test('refresh writes one complete batch plus a pointer and deletes expired configuration entries', async () => {
  const root = await fixture();
  const summary = await refresh(root, options('combined', ['--lookback-hours', '72']), { now, client: client() });
  const output = path.join(root, '.local/output');
  assert.deepEqual((await readdir(output)).sort(), ['latest.json', 'results']);
  assert.deepEqual(await readdir(path.join(output, 'results')), ['20261104120000-combined.json']);
  const batch = await readJson(path.join(output, summary.resultsPath));
  assert.equal(batch.schemaVersion, 3);
  assert.equal(batch.lookbackHours, 72);
  assert.equal(batch.status, 'completed');
  assert.equal(batch.uniqueArticles, 1);
  assert.equal(batch.newResolutions, 1);
  assert.deepEqual(batch.results.map(q => q.queryId), ['one', 'temporary']);
  assert.ok(batch.results.every(q => q.articles[0].publisherUrl === resolved.publisherUrl));
  assert.ok(batch.results.every(q => !q.path));
  assert.deepEqual(await readJson(path.join(output, 'latest.json')), {
    schemaVersion: 3, path: summary.resultsPath, startedAt: batch.startedAt, status: 'completed',
  });
  assert.deepEqual((await readJson(path.join(root, 'queries.json'))).queries.map(q => q.id), ['one', 'temporary']);
  assert.deepEqual(summary.expiredQueries, ['expired']);
  assert.equal(summary.publication, null);
});

test('validation reports expired entries without changing configuration or writing output', async () => {
  const root = await fixture(), before = await readFile(path.join(root, 'queries.json'), 'utf8');
  const summary = await refresh(root, options('validate', ['--validate']), { now,
    client: { feed: async () => assert.fail('Validation must not fetch feeds') } });
  assert.equal(summary.validation, true);
  assert.equal(summary.activeQueries, 2);
  assert.deepEqual(summary.expiredQueries, ['expired']);
  assert.equal(await readFile(path.join(root, 'queries.json'), 'utf8'), before);
  assert.deepEqual(await readdir(root), ['queries.json']);
});

test('latest advances for selected, custom, partial, and empty refreshes', async () => {
  const root = await fixture();
  const store = mockStore(new Map([['queries.json', document()]]));
  let tick = 0;
  for (const [id, args, currentClient, expectedStatus] of [
    ['selected', ['--mode', 'selected', '--query-ids', '["one"]'], client(), 'completed'],
    ['custom', ['--mode', 'custom', '--query', 'custom search'], client(), 'completed'],
    ['partial', [], { feed: async () => { throw Object.assign(new Error(), { code: 'InvalidFeed' }); } }, 'partial'],
    ['empty', [], { feed: async () => [] }, 'completed'],
  ]) {
    const time = new Date(Date.parse(instant) + tick++ * 60000);
    const summary = await refresh(root, options(id, ['--publish', ...args]), { now: () => time, client: currentClient, store });
    const pointer = store.data.get('latest.json');
    assert.equal(pointer.path, summary.resultsPath);
    assert.equal(pointer.status, expectedStatus);
    assert.equal(store.data.get(pointer.path).results.length, id === 'selected' || id === 'custom' ? 1 : 2);
    assert.ok(store.commits.at(-1).every(file => file === 'latest.json' || file.startsWith('results/') || file === 'queries.json'));
  }
});

test('publication prunes the latest query document and preserves concurrent edits and expiry extensions', async () => {
  const root = await fixture();
  const store = mockStore(new Map([['queries.json', document()]]));
  const edited = document();
  edited.queries[0].query = 'edited while refresh was fetching';
  edited.queries[2].activeUntil = '2026-11-10';
  edited.queries.push({ id: 'new', query: 'newly added query' },
    { id: 'stale', query: 'remove this entry', activeUntil: '2026-10-31' });
  const summary = await refresh(root, options('publish', ['--publish']), { now, store,
    client: { ...client(), feed: async () => { store.data.set('queries.json', edited); return [article]; } } });
  assert.equal(summary.publication.commit, 'mock-commit');
  assert.deepEqual(store.commits[0].sort(), ['latest.json', 'queries.json', summary.resultsPath].sort());
  const saved = store.data.get('queries.json');
  assert.equal(saved.queries[0].query, edited.queries[0].query);
  assert.equal(saved.queries.find(q => q.id === 'expired').activeUntil, '2026-11-10');
  assert.ok(saved.queries.some(q => q.id === 'new'));
  assert.ok(!saved.queries.some(q => q.id === 'stale'));
});

test('older publication preserves a newer pointer and duplicate publication does not change stored results', async () => {
  const root = await fixture();
  const pointer = { schemaVersion: 3, path: 'results/newer.json', startedAt: '2026-11-05T12:00:00.000Z', status: 'partial' };
  const store = mockStore(new Map([['queries.json', document()], ['latest.json', pointer]]));
  const summary = await refresh(root, options('older', ['--publish']), { now, client: client(), store });
  assert.deepEqual(store.data.get('latest.json'), pointer);
  assert.ok(store.data.has(summary.resultsPath));
  assert.ok(!store.commits[0].includes('latest.json'));
  const before = structuredClone(store.data);
  await assert.rejects(refresh(root, options('older', ['--publish', '--output', '.local/retry']),
    { now, client: client(), store }), /Results file already exists/);
  assert.deepEqual(store.data, before);
  await assert.rejects(refresh(root, options('older'), { now, client: client(), store }), /Results file already exists/);
});

test('refresh reuses repository and local results without a separate cache and force resolve bypasses reuse', async () => {
  const root = await fixture();
  let resolutions = 0;
  const currentClient = { ...client(), resolve: async () => { resolutions++; return resolved; } };
  await refresh(root, options('repository', ['--output', '.']), { now, client: currentClient });
  const second = await refresh(root, options('local'), { now, client: currentClient });
  const batch = await readJson(path.join(root, '.local/output', second.resultsPath));
  assert.equal(resolutions, 1);
  assert.ok(batch.results.every(q => q.articles[0].cacheHit));
  await refresh(root, options('repeat'), { now, client: currentClient });
  assert.equal(resolutions, 1);
  await refresh(root, options('forced', ['--force-resolve']), { now, client: currentClient });
  assert.equal(resolutions, 2);
});

test('unresolved and invalid publisher URLs in previous results are never reused', () => {
  const cache = resolutionCache({ results: [{ articles: [
    { ...article, ...resolved, resolutionStatus: 'resolved' },
    { ...article, googleArticleId: 'B', publisherUrl: 'javascript:alert(1)', resolutionStatus: 'resolved' },
    { ...article, ...resolved, googleArticleId: 'C', resolutionStatus: 'unresolved' },
  ] }] });
  assert.deepEqual(Object.keys(cache.entries), ['A']);
});

test('latest pointers cannot cause reads outside the flat results folder', async () => {
  const root = await fixture();
  for (const unsafe of ['../outside.json', 'results/../../outside.json', '/absolute.json', 'results/nested/file.json']) {
    await writeFile(path.join(root, 'latest.json'), JSON.stringify({ path: unsafe }));
    await assert.rejects(refresh(root, options('unsafe'), { now, client: client() }), /directly inside results/);
  }
});
