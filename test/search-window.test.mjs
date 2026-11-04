import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig, selectQueries } from '../src/config.mjs';
import { readOptions } from '../src/refresh-news.mjs';
import { runBatch } from '../src/runner.mjs';
import { rssUrl } from '../src/google-news.mjs';
import { withSearchWindow } from '../src/search-window.mjs';

test('lookback accepts only 24 or 72 hours, defaults to 24, and CLI overrides the environment', () => {
  assert.equal(readOptions([], {}).lookbackHours, 24);
  assert.equal(readOptions([], { SCS_LOOKBACK_HOURS: '72' }).lookbackHours, 72);
  assert.equal(readOptions(['--lookback-hours', '24'], { SCS_LOOKBACK_HOURS: '72' }).lookbackHours, 24);
  for (const value of ['0', '48', '1d', '72h', '', 'invalid']) {
    assert.throws(() => readOptions(['--lookback-hours', value], {}), /24 or 72/);
    assert.throws(() => readOptions([], { SCS_LOOKBACK_HOURS: value }), /24 or 72/);
  }
});

test('run windows replace old operators without changing quoted phrases or OR grouping', () => {
  assert.equal(withSearchWindow('UN when:2d OR peacekeepers WHEN:5h', 72),
    '(UN  OR peacekeepers) when:3d');
  assert.equal(withSearchWindow('"when:2d" OR UN', 24), '("when:2d" OR UN) when:1d');
  assert.throws(() => withSearchWindow('when:2d', 24), /search terms/);
});

test('all saved topics use the selected window without changing their configuration hashes', async () => {
  const config = await loadConfig(fileURLToPath(new URL('..', import.meta.url)));
  const saved = JSON.stringify(config);
  for (const lookbackHours of [24, 72]) {
    const selected = selectQueries(config);
    const seen = [];
    const batch = await runBatch({ queries: selected, requestId: `window-${lookbackHours}`, mode: 'active', lookbackHours,
      client: { feed: async query => { seen.push(new URL(rssUrl(query)).searchParams.get('q')); return []; } } });
    assert.equal(seen.length, config.queries.length);
    assert.ok(seen.length > 0);
    for (const search of seen) {
      assert.equal((search.match(/when:/g) ?? []).length, 1);
      assert.ok(search.endsWith(`when:${lookbackHours / 24}d`));
    }
    assert.equal(batch.lookbackHours, lookbackHours);
    assert.deepEqual(batch.results.map(result => result.configHash), selected.map(query => query.configHash));
    assert.ok(batch.results.every(result => result.lookbackHours === lookbackHours));
  }
  assert.equal(JSON.stringify(config), saved);
});

test('selected and custom queries override existing windows too; invalid windows fail before feed calls', async () => {
  const config = await loadConfig(fileURLToPath(new URL('..', import.meta.url)));
  for (const options of [
    { mode: 'selected', queryIds: [config.queries[0].id] },
    { mode: 'custom', customQueries: [{ id: 'custom-window', query: 'UN when:2d' }] },
  ]) {
    const queries = selectQueries(config, options);
    const batch = await runBatch({ queries, mode: options.mode, requestId: 'window', lookbackHours: 72,
      client: { feed: async query => { assert.match(query.query, /when:3d$/); assert.doesNotMatch(query.query, /when:2d/); return []; } } });
    assert.equal(batch.results[0].lookbackHours, 72);
    assert.equal(batch.results[0].status, 'empty');
  }
  let calls = 0;
  await assert.rejects(runBatch({ queries: config.queries, lookbackHours: 48,
    client: { feed: async () => { calls++; return []; } } }), /24 or 72/);
  assert.equal(calls, 0);
});
