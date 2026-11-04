import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeConfig, selectQueries, localDate } from '../src/config.mjs';
import { readOptions } from '../src/refresh-news.mjs';
import { applyQueryChange } from '../src/manage-queries.mjs';

const files = () => [{ schemaVersion: 1, timezone: 'America/New_York', queries: [
  { id: 'permanent', query: 'regular search', revision: 1 },
] }, { schemaVersion: 1, queries: [
  { id: 'temporary', query: 'extra search', revision: 1, activeFrom: '2026-11-03', activeUntil: '2026-11-16' },
] }];

test('temporary monitoring uses New York dates and includes the expiry date', () => {
  const config = normalizeConfig(...files());
  assert.equal(localDate(new Date('2026-11-03T04:59:59Z'), config.timezone), '2026-11-02');
  assert.equal(selectQueries(config, {}, new Date('2026-11-03T04:59:59Z')).length, 1);
  assert.equal(selectQueries(config, {}, new Date('2026-11-17T04:59:59Z')).length, 2);
  assert.equal(selectQueries(config, {}, new Date('2026-11-17T05:00:00Z')).length, 1);
});

test('invalid dates, duplicate IDs, invalid revisions and path traversal fail before network access', () => {
  for (const patch of [{ activeUntil: '2026-02-30' }, { id: 'permanent' }, { revision: 0 }, { id: '../secret' }]) {
    const [standard, temporary] = files(); Object.assign(temporary.queries[0], patch);
    assert.throws(() => normalizeConfig(standard, temporary));
  }
});

test('editing query text changes its hash even without a revision bump', () => {
  const [standard, temporary] = files();
  const before = normalizeConfig(standard, temporary).queries[0];
  standard.queries[0].query = 'changed search';
  const after = normalizeConfig(standard, temporary).queries[0];
  assert.equal(before.revision, after.revision);
  assert.notEqual(before.configHash, after.configHash);
});

test('selected mode refuses unknown, disabled and expired subscriptions', () => {
  const config = normalizeConfig(...files());
  assert.throws(() => selectQueries(config, { mode: 'selected', queryIds: ['missing'] }));
  assert.throws(() => selectQueries(config, { mode: 'selected', queryIds: ['temporary'] }, new Date('2026-11-18')));
  config.queries[0].enabled = false;
  assert.throws(() => selectQueries(config, { mode: 'selected', queryIds: ['permanent'] }));
});

test('custom queries remain runtime inputs and do not modify saved configuration', () => {
  const config = normalizeConfig(...files()), before = JSON.stringify(config);
  const selected = selectQueries(config, { mode: 'custom', customQueries: [
    { id: 'first', query: 'one "quoted" query', maxArticles: 50 }, { id: 'second', query: 'another query' },
  ] });
  assert.equal(selected.length, 2);
  assert.equal(selected[0].maxArticles, 50);
  assert.equal(JSON.stringify(config), before);
});

test('runtime arguments accept JSON and preserve shell metacharacters as plain text', () => {
  const query = 'trade "talks" $(whoami); `echo` & region';
  const options = readOptions(['--mode', 'custom', '--query', query, '--request-id', 'safe-id'], {});
  assert.equal(options.customQueries[0].query, query);
  assert.equal(options.requestId, 'safe-id');
  assert.throws(() => readOptions(['--max-total', '1000'], {}));
  assert.throws(() => readOptions(['--request-id', '../../escape'], {}));
});

test('one update adds a temporary set and increments revisions on subsequent edits', () => {
  const [standard, temporary] = files();
  const update = applyQueryChange(standard, temporary, { operation: 'upsert', entries: [
    { id: 'temporary', query: 'updated query' },
    { id: 'second', query: 'second query', activeFrom: '2026-11-03', activeUntil: '2026-11-16' },
  ] }, new Date('2026-11-03T12:00:00Z'));
  assert.equal(update.temporary.queries[0].revision, 2);
  assert.equal(update.temporary.queries[1].revision, 1);
  assert.deepEqual(update.refreshIds, ['temporary', 'second']);
  assert.equal(temporary.queries[0].revision, 1);
});

test('extend, disable and promote implement the monitoring lifecycle', () => {
  const [standard, temporary] = files();
  const extended = applyQueryChange(standard, temporary, { operation: 'extend', queryId: 'temporary', activeUntil: '2026-11-30' });
  assert.equal(extended.temporary.queries[0].activeUntil, '2026-11-30');
  const disabled = applyQueryChange(standard, temporary, { operation: 'disable', queryId: 'temporary' });
  assert.equal(disabled.temporary.queries[0].enabled, false);
  assert.deepEqual(disabled.refreshIds, []);
  const promoted = applyQueryChange(standard, temporary, { operation: 'promote', queryId: 'temporary' });
  assert.equal(promoted.temporary.queries.length, 0);
  assert.equal(promoted.standard.queries[1].activeUntil, undefined);
  assert.equal(promoted.standard.queries[1].revision, 2);
});

test('invalid query-set updates are rejected without changing either input', () => {
  const [standard, temporary] = files(), before = JSON.stringify([standard, temporary]);
  assert.throws(() => applyQueryChange(standard, temporary, { operation: 'upsert', entries: [
    { id: 'first', query: 'good', activeFrom: '2026-11-03', activeUntil: '2026-11-16' },
    { id: 'bad', query: 'bad', activeFrom: '2026-11-03', activeUntil: 'not-a-date' },
  ] }));
  assert.equal(JSON.stringify([standard, temporary]), before);
});
