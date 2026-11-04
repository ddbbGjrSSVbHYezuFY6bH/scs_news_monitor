import test from 'node:test';
import assert from 'node:assert/strict';
import { applyQueryOperation, manageQueries, validateQueryOperation } from '../src/manage-queries.mjs';

const document = () => ({ schemaVersion: 1, timezone: 'America/New_York', defaults: { maxArticles: 25 }, queries: [
  { id: 'permanent', query: 'regular search', label: 'Regular', revision: 3 },
  { id: 'temporary', query: 'temporary search', activeUntil: '2026-11-30' },
] });

test('create adds permanent and expiring queries to one document without modifying its input', () => {
  const input = document(), before = structuredClone(input);
  for (const entry of [{ query: 'new search' }, { query: 'new search', activeUntil: '2026-12-31' }]) {
    const result = applyQueryOperation(input, { operation: 'create', queryId: 'new', entry });
    assert.equal(result.changed, true);
    assert.deepEqual(result.queries, [{ id: 'new', ...entry, revision: 1 }]);
    assert.equal(result.document.queries.length, 3);
    assert.deepEqual(result.document.defaults, input.defaults);
  }
  assert.deepEqual(input, before);
});

test('read returns either all queries or a single ID without changing the document', () => {
  const input = document();
  const all = applyQueryOperation(input, { operation: 'read' });
  const one = applyQueryOperation(input, { operation: 'read', queryId: 'temporary' });
  assert.deepEqual(all.queries, input.queries);
  assert.deepEqual(one.queries, [input.queries[1]]);
  assert.equal(all.changed, false);
  assert.equal(one.changed, false);
  one.queries[0].query = 'changed output';
  assert.equal(input.queries[1].query, 'temporary search');
});

test('update patches selected fields, increments revision, disables queries and removes expiry with null', () => {
  const input = document();
  const changed = applyQueryOperation(input, { operation: 'update', queryId: 'permanent',
    entry: { query: 'revised search', enabled: false } });
  assert.deepEqual(changed.queries[0], { ...input.queries[0], query: 'revised search', enabled: false, revision: 4 });
  const extended = applyQueryOperation(input, { operation: 'update', queryId: 'temporary',
    entry: { activeUntil: '2026-12-31' } });
  assert.equal(extended.queries[0].activeUntil, '2026-12-31');
  assert.equal(extended.queries[0].revision, 2);
  const permanent = applyQueryOperation(input, { operation: 'update', queryId: 'temporary',
    entry: { activeUntil: null } });
  assert.equal(Object.hasOwn(permanent.queries[0], 'activeUntil'), false);
  assert.equal(permanent.queries[0].query, input.queries[1].query);
  assert.equal(input.queries[1].activeUntil, '2026-11-30');
});

test('an unchanged update does not bump the revision or create a commit', async () => {
  const input = document();
  const result = applyQueryOperation(input, { operation: 'update', queryId: 'permanent', entry: { query: 'regular search' } });
  assert.equal(result.changed, false);
  assert.deepEqual(result.document, input);
  const summary = await manageQueries({ operation: 'update', queryId: 'permanent', entry: { query: 'regular search' } }, {
    store: { transaction: async (message, update) => {
      assert.equal((await update(async () => input)).size, 0);
      return { commit: 'existing', changed: false };
    } },
  });
  assert.equal(summary.changed, false);
  assert.equal(summary.publication.changed, false);
});

test('updates increment revisions numerically even when an existing revision is stored as text', () => {
  const input = document();
  input.queries[0].revision = '3';
  const result = applyQueryOperation(input, { operation: 'update', queryId: 'permanent', entry: { label: 'New label' } });
  assert.equal(result.queries[0].revision, 4);
});

test('delete physically removes one query and reports the deleted entry', () => {
  const input = document();
  const result = applyQueryOperation(input, { operation: 'delete', queryId: 'temporary' });
  assert.deepEqual(result.document.queries, [input.queries[0]]);
  assert.deepEqual(result.queries, [input.queries[1]]);
  assert.equal(result.changed, true);
  assert.equal(input.queries.length, 2);
});

test('create refuses duplicates and read/update/delete refuse missing IDs', () => {
  assert.throws(() => applyQueryOperation(document(), { operation: 'create', queryId: 'permanent',
    entry: { query: 'other search' } }), /already exists/);
  for (const operation of ['read', 'update', 'delete']) {
    assert.throws(() => applyQueryOperation(document(), { operation, queryId: 'missing',
      ...(operation === 'update' ? { entry: { label: 'New label' } } : {}) }), /Unknown query/);
  }
});

test('malformed requests, unknown fields, invalid dates and IDs fail without changing the input', () => {
  const input = document(), before = structuredClone(input);
  for (const options of [
    { operation: 'upsert' },
    { operation: 'delete' },
    { operation: 'create', queryId: '../escape', entry: { query: 'news' } },
    { operation: 'create', queryId: 'new', entry: {} },
    { operation: 'read', entry: { query: 'news' } },
    { operation: 'delete', queryId: 'permanent', entry: { query: 'news' } },
    { operation: 'update', queryId: 'permanent', entry: {} },
    ...[null, [], 'query', { id: 'new' }, { revision: 9 }, { unsupported: 'value' },
      { activeUntil: '2026-02-30' }, { activeUntil: '' }, { query: '' }, { enabled: 'yes' },
      { maxArticles: 101 }, { query: null }, { label: null }].map(entry =>
      ({ operation: 'update', queryId: 'permanent', entry })),
  ]) {
    assert.throws(() => applyQueryOperation(input, options));
    assert.deepEqual(input, before);
  }
});

test('query count limits are validated before a new document can be published', () => {
  const input = { schemaVersion: 1, queries: Array.from({ length: 100 }, (_, i) => ({ id: `q-${i}`, query: 'news' })) };
  assert.throws(() => applyQueryOperation(input, { operation: 'create', queryId: 'overflow',
    entry: { query: 'news' } }), /At most 100/);
  assert.equal(input.queries.length, 100);
});

test('authenticated reads use the store read method and never start a write transaction', async () => {
  const input = document();
  const summary = await manageQueries({ operation: 'read', queryId: 'permanent' }, {
    store: { readJson: async file => { assert.equal(file, 'queries.json'); return input; },
      transaction: async () => assert.fail('Read must not attempt a commit') },
  });
  assert.equal(summary.changed, false);
  assert.equal(summary.publication, null);
  assert.deepEqual(summary.queries, [input.queries[0]]);
  assert.deepEqual(summary.defaults, input.defaults);
});

test('publication retries against current queries and only commits the query document', async () => {
  const first = document(), latest = document();
  latest.queries[1].query = 'concurrently edited query';
  latest.queries.push({ id: 'concurrent', query: 'another new query' });
  let changes;
  const summary = await manageQueries({ operation: 'update', queryId: 'permanent', entry: { enabled: false } }, {
    store: { transaction: async (message, update) => {
      assert.equal(message, 'Manage queries: update permanent');
      await update(async file => { assert.equal(file, 'queries.json'); return first; });
      changes = await update(async file => { assert.equal(file, 'queries.json'); return latest; });
      return { commit: 'updated', changed: true };
    } },
  });
  assert.deepEqual([...changes.keys()], ['queries.json']);
  const saved = changes.get('queries.json');
  assert.equal(saved.queries[0].enabled, false);
  assert.equal(saved.queries[1].query, 'concurrently edited query');
  assert.equal(saved.queries[2].id, 'concurrent');
  assert.equal(summary.publication.commit, 'updated');
});

test('invalid operations are rejected before constructing or calling a GitHub client', async () => {
  await assert.rejects(manageQueries({ operation: 'update', queryId: 'bad/id', entry: { query: 'news' } }, { env: {} }), /queryId/);
  assert.equal(validateQueryOperation().operation, 'read');
});
