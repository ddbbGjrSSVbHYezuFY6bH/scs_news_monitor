
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeConfig } from '../src/config.mjs';
import { runBatch } from '../src/runner.mjs';
import { filterByRssTimestamp } from '../src/rss-time-filter.mjs';
import { refresh, readOptions } from '../src/refresh-news.mjs';
import { GitHubStore, mergeCache, updateIndex } from '../src/github-store.mjs';

const now = () => new Date('2026-11-03T12:00:00Z');

const queries = () => normalizeConfig({ schemaVersion: 1, queries: [
  { id: 'one', query: 'first', revision: 1 },
  { id: 'two', query: 'second', revision: 1 },
] }, { schemaVersion: 1, queries: [] }).queries;

// Mock articles default to one hour before the fixed test clock.
// The timestamp can be overridden for filtering tests.
const article = (id, publishedAt = '2026-11-03T11:00:00Z') => ({
  title: id,
  publisher: 'Example',
  rssDescription: 'Description',
  publishedAt,
  googleArticleId: id,
  rssUrl: `https://news.google.com/rss/articles/${id}`
});

const resolved = {
  publisherUrl: 'https://publisher.example/article',
  method: 'rpc'
};

// ------------------------------------------------------------------
// RSS timestamp filtering
// ------------------------------------------------------------------

test('RSS timestamp filter enforces exact 24h and 72h windows', () => {
  const startedAt = now().toISOString();

  const articles = [
    article('recent', '2026-11-03T11:00:00Z'),
    article('boundary24', '2026-11-02T12:00:00Z'),
    article('older24', '2026-11-02T11:59:59Z'),
    article('boundary72', '2026-10-31T12:00:00Z'),
    article('older72', '2026-10-31T11:59:59Z'),
    article('exactNow', '2026-11-03T12:00:00Z'),
    article('future', '2026-11-03T12:00:01Z'),
    article('missing', null),
    article('invalid', 'not-a-date')
  ];

  const result24 = filterByRssTimestamp(articles, startedAt, 24);

  assert.deepEqual(
    result24.map(a => a.googleArticleId),
    ['recent', 'boundary24', 'exactNow']
  );

  const result72 = filterByRssTimestamp(articles, startedAt, 72);

  assert.deepEqual(
    result72.map(a => a.googleArticleId),
    ['recent', 'boundary24', 'older24', 'boundary72', 'exactNow']
  );
});

test('runner filters RSS timestamps before deduplication and resolution', async () => {
  const calls = [];

  const batch = await runBatch({
    queries: queries().slice(0, 1),
    now,
    requestId: 'filter-test',
    mode: 'active',
    lookbackHours: 24,
    client: {
      feed: async () => [
        article('old', '2026-11-01T10:00:00Z'),
        article('valid', '2026-11-03T11:00:00Z'),
        article('valid', '2026-11-03T11:00:00Z'),
        article('future', '2026-11-04T10:00:00Z'),
        article('missing', null)
      ],
      resolve: async url => {
        calls.push(url);
        return resolved;
      }
    }
  });

  assert.deepEqual(
    batch.results[0].articles.map(a => a.googleArticleId),
    ['valid']
  );

  assert.deepEqual(calls, [article('valid').rssUrl]);
  assert.equal(batch.request.uniqueArticles, 1);
  assert.equal(batch.results[0].counts.resolved, 1);
  assert.equal(batch.results[0].status, 'completed');
});

// ------------------------------------------------------------------
// Existing runner tests
// ------------------------------------------------------------------

test('round-robin selection shares the global cap and resolves overlap only once', async () => {
  const calls = [];
  const batch = await runBatch({ queries: queries(), now, requestId: 'batch', mode: 'active', maxTotal: 3,
    client: { feed: async q => q.id === 'one' ? [article('A'), article('A'), article('B'), article('C')] : [article('D'), article('A')],
      resolve: async url => { calls.push(url); return resolved; } } });
  assert.equal(calls.length, 3);
  assert.deepEqual(batch.results[0].articles.map(a => a.googleArticleId), ['A', 'B']);
  assert.deepEqual(batch.results[1].articles.map(a => a.googleArticleId), ['D', 'A']);
  assert.deepEqual(batch.results[0].articles[0].matchedQueryIds, ['one', 'two']);
  assert.equal(batch.results[0].truncated, true);
});

test('successful mappings are reused and forceResolve bypasses them', async () => {
  let calls = 0;
  const base = { queries: queries().slice(0, 1), now, requestId: 'cache', mode: 'selected',
    client: { feed: async () => [article('A')], resolve: async () => { calls++; return resolved; } },
    cache: { schemaVersion: 1, entries: { A: { ...resolved, resolvedAt: now().toISOString() } } } };
  assert.equal((await runBatch(base)).results[0].articles[0].cacheHit, true);
  assert.equal(calls, 0);
  await runBatch({ ...base, forceResolve: true });
  assert.equal(calls, 1);
});

test('rate limiting opens a circuit but preserves cached successes and original RSS URLs', async () => {
  let calls = 0;
  const batch = await runBatch({ queries: queries().slice(0, 1), now, requestId: 'limited', mode: 'active',
    cache: { entries: { C: { ...resolved, resolvedAt: now().toISOString() } } },
    client: { feed: async () => [article('A'), article('B'), article('C')], resolve: async () => {
      calls++; throw Object.assign(new Error('limited'), { code: 'RateLimited', status: 429 });
    } } });
  assert.equal(calls, 1);
  assert.equal(batch.results[0].status, 'partial');
  assert.equal(batch.results[0].articles[0].publisherUrl, null);
  assert.equal(batch.results[0].articles[1].resolutionErrorCode, 'CircuitOpen');
  assert.equal(batch.results[0].articles[2].cacheHit, true);
  assert.equal(batch.results[0].articles[0].rssUrl, article('A').rssUrl);
});

test('empty feeds and fetch failures are distinct', async () => {
  const batch = await runBatch({ queries: queries(), now, requestId: 'empty', mode: 'active',
    client: { feed: async q => { if (q.id === 'one') return []; throw Object.assign(new Error(), { code: 'InvalidFeed' }); } } });
  assert.equal(batch.results[0].status, 'empty');
  assert.equal(batch.results[1].status, 'failed');
});

test('index rejects stale revisions and older results, and preserves previous usable results on failure', async () => {
  const current = queries();
  const batch = await runBatch({ queries: current.slice(0, 1), now, requestId: 'new', mode: 'active',
    client: { feed: async () => [article('A')], resolve: async () => resolved } });
  const initial = updateIndex({ topics: {} }, batch, current);
  assert.equal(initial.topics.one.latestUsable.requestId, 'new');
  const old = structuredClone(batch);
  old.results[0].feedFetchedAt = '2026-11-02T00:00:00Z'; old.results[0].requestId = 'old';
  assert.equal(updateIndex(initial, old, current).topics.one.latestUsable.requestId, 'new');
  const edited = structuredClone(current); edited[0].configHash = 'edited';
  assert.equal(updateIndex({ topics: {} }, batch, edited).topics.one, undefined);
  const failed = structuredClone(batch);
  failed.results[0].status = 'failed'; failed.results[0].feedFetchedAt = null;
  failed.results[0].startedAt = '2026-11-04T00:00:00Z'; failed.results[0].requestId = 'failed';
  const next = updateIndex(initial, failed, current).topics.one;
  assert.equal(next.latestAttempt.status, 'failed');
  assert.equal(next.latestUsable.requestId, 'new');
});

test('cache publication merges concurrent successes and ignores invalid destinations', () => {
  const old = { entries: { A: { ...resolved, resolvedAt: '2026-11-03' } } };
  const merged = mergeCache(old, {
    A: { publisherUrl: 'https://older.example/a', resolvedAt: '2026-11-02' },
    B: { ...resolved, resolvedAt: '2026-11-04' },
    C: { publisherUrl: 'javascript:alert(1)', resolvedAt: '2026-11-04' },
  });
  assert.equal(merged.entries.A.publisherUrl, resolved.publisherUrl);
  assert.ok(merged.entries.B);
  assert.equal(merged.entries.C, undefined);
});

test('GitHub publication retries a non-fast-forward conflict with a new snapshot', async () => {
  let head = 1, mutations = 0, updates = 0;
  const store = new GitHubStore({ repository: 'owner/repo', token: 'test-token', fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    const endpoint = new URL(url).pathname.replace('/repos/owner/repo/', '');
    if (endpoint === 'git/ref/heads/main') return Response.json({ object: { sha: `head-${head}` } });
    if (endpoint.startsWith('git/commits/head-')) return Response.json({ tree: { sha: 'base-tree' } });
    if (endpoint === 'git/trees') return Response.json({ sha: 'new-tree' });
    if (endpoint === 'git/commits') return Response.json({ sha: `new-commit-${head}` });
    if (endpoint === 'git/refs/heads/main') {
      updates++;
      if (updates === 1) { head++; return Response.json({}, { status: 422 }); }
      return Response.json({});
    }
    throw new Error(`Unexpected route: ${endpoint}`);
  } });
  const result = await store.transaction('test', async () => { mutations++; return new Map([['data/index.json', { version: head }]]); });
  assert.equal(result.commit, 'new-commit-2');
  assert.equal(mutations, 2);
});

test('CLI integration writes complete local JSON files without a token or publication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scs-news-test-'));
  await mkdir(path.join(root, 'queries'));
  await writeFile(path.join(root, 'queries/standard.json'), JSON.stringify({ schemaVersion: 1, queries: [{ id: 'one', query: 'search' }] }));
  await writeFile(path.join(root, 'queries/temporary.json'), JSON.stringify({ schemaVersion: 1, queries: [] }));
  const options = readOptions(['--request-id', 'integration', '--lookback-hours', '72'], {});

  // The CLI uses the real clock rather than the fixed test clock.
  // Generate a publication timestamp relative to the actual run.
  const recentTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const result = await refresh(root, options, { client: { feed: async query => {
    assert.equal(query.query, '(search) when:3d');
    return [article('A', recentTimestamp)];
  }, resolve: async () => resolved } });
  assert.equal(result.status, 'completed');
  assert.equal(result.publication, null);
  const saved = JSON.parse(await readFile(path.join(root, '.local/output', result.results[0].path), 'utf8'));
  assert.equal(saved.articles[0].publisherUrl, resolved.publisherUrl);
  assert.equal(saved.queryRevision, 1);
  assert.equal(saved.lookbackHours, 72);
});
