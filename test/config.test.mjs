import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, selectQueries, localDate, pruneExpiredQueries } from '../src/config.mjs';
import { readOptions } from '../src/refresh-news.mjs';

const document = () => ({ schemaVersion: 1, timezone: 'America/New_York', queries: [
  { id: 'permanent', query: 'regular search' },
  { id: 'temporary', query: 'extra search', activeUntil: '2026-11-16' },
] });

test('expiry is inclusive and uses New York dates, including daylight saving changes', () => {
  const config = normalizeConfig(document());
  assert.equal(localDate(new Date('2026-11-03T04:59:59Z'), config.timezone), '2026-11-02');
  assert.equal(selectQueries(config, {}, new Date('2026-11-03T04:59:59Z')).length, 2);
  assert.equal(selectQueries(config, {}, new Date('2026-11-17T04:59:59Z')).length, 2);
  assert.equal(selectQueries(config, {}, new Date('2026-11-17T05:00:00Z')).length, 1);
  const summer = document(); summer.queries[1].activeUntil = '2026-07-10';
  assert.equal(pruneExpiredQueries(summer, new Date('2026-07-11T03:59:59Z')).expiredIds.length, 0);
  assert.equal(pruneExpiredQueries(summer, new Date('2026-07-11T04:00:00Z')).expiredIds.length, 1);
});

test('cleanup removes expired entries and preserves permanent, unexpired, and disabled queries', () => {
  const input = document();
  input.queries.push({ id: 'disabled', query: 'disabled search', enabled: false });
  const before = structuredClone(input);
  const cleaned = pruneExpiredQueries(input, new Date('2026-11-17T05:00:00Z'));
  assert.deepEqual(cleaned.expiredIds, ['temporary']);
  assert.deepEqual(cleaned.document.queries.map(q => q.id), ['permanent', 'disabled']);
  assert.deepEqual(input, before);
  assert.deepEqual(pruneExpiredQueries(cleaned.document, new Date('2026-11-18')).expiredIds, []);
});

test('invalid dates, duplicate IDs, invalid revisions and path traversal fail before network access', () => {
  for (const patch of [{ activeUntil: '2026-02-30' }, { activeUntil: '' }, { id: 'permanent' },
    { revision: 0 }, { id: '../secret' }]) {
    const input = document(); Object.assign(input.queries[1], patch);
    assert.throws(() => normalizeConfig(input));
  }
});

test('editing query text changes its hash without requiring a revision bump', () => {
  const input = document();
  const before = normalizeConfig(input).queries[0];
  input.queries[0].query = 'changed search';
  const after = normalizeConfig(input).queries[0];
  assert.equal(before.revision, after.revision);
  assert.notEqual(before.configHash, after.configHash);
});

test('selected mode refuses unknown, disabled and expired queries', () => {
  const config = normalizeConfig(document());
  assert.throws(() => selectQueries(config, { mode: 'selected', queryIds: ['missing'] }));
  assert.throws(() => selectQueries(config, { mode: 'selected', queryIds: ['temporary'] }, new Date('2026-11-18')));
  config.queries[0].enabled = false;
  assert.throws(() => selectQueries(config, { mode: 'selected', queryIds: ['permanent'] }));
});

test('custom queries remain runtime inputs and do not modify saved configuration', () => {
  const config = normalizeConfig(document()), before = structuredClone(config);
  const selected = selectQueries(config, { mode: 'custom', customQueries: [
    { id: 'first', query: 'one "quoted" query', maxArticles: 50 }, { id: 'second', query: 'another query' },
  ] });
  assert.equal(selected.length, 2);
  assert.equal(selected[0].maxArticles, 50);
  assert.deepEqual(config, before);
});

test('runtime arguments accept JSON and preserve shell metacharacters as plain text', () => {
  const query = 'trade "talks" $(whoami); `echo` & region';
  const options = readOptions(['--mode', 'custom', '--query', query, '--request-id', 'safe-id'], {});
  assert.equal(options.customQueries[0].query, query);
  assert.equal(options.requestId, 'safe-id');
  assert.equal(readOptions(['--queries', '[{"query":"news"}]'], {}).mode, 'custom');
  assert.throws(() => readOptions(['--max-total', '1000'], {}));
  assert.throws(() => readOptions(['--request-id', '../../escape'], {}));
});
