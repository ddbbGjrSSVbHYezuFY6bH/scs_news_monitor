import { createHash } from 'node:crypto';
import { publisherUrl } from './google-news.mjs';

const blockingCodes = new Set(['RateLimited', 'GoogleChallenge', 'GoogleConsentRequired', 'TimeBudgetExceeded']);
const keyOf = article => article.googleArticleId ?? article.rssUrl;
const errorInfo = error => ({ code: error.code ?? 'UnexpectedError', httpStatus: error.status ?? null,
  retryAfter: error.retryAfter ?? null });

export function resultPath(query, requestId) {
  return `results/${query.id}/${query.revision}-${query.configHash.slice(0, 16)}/${requestId}.json`;
}

export async function runBatch({ queries, client, requestId, mode, maxTotal = 100,
  forceResolve = false, cache = { schemaVersion: 1, entries: {} }, now = () => new Date() }) {
  const startedAt = now().toISOString();
  const states = [], selected = new Map();
  let circuit = null;
  for (const query of queries) {
    const state = { query, candidates: [], feedFetchedAt: null, feedError: null, truncated: false };
    states.push(state);
    if (circuit) { state.feedError = { code: 'CircuitOpen', cause: circuit.code }; continue; }
    try {
      const seen = new Set();
      const articles = (await client.feed(query)).filter(article => {
        const key = keyOf(article);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      state.feedFetchedAt = now().toISOString();
      state.truncated = articles.length > query.maxArticles;
      state.candidates = articles.slice(0, query.maxArticles);
    } catch (error) {
      state.feedError = errorInfo(error);
      if (blockingCodes.has(error.code)) circuit = state.feedError;
    }
  }
  // Round robin gives every query a chance before the global unique-link cap is reached.
  for (let round = 0; states.some(s => s.candidates.length > round); round++) {
    for (const state of states) {
      const article = state.candidates[round];
      if (!article) continue;
      const key = keyOf(article);
      if (!selected.has(key) && selected.size < maxTotal) selected.set(key, { article, query: state.query, queryIds: [] });
    }
  }
  for (const state of states) {
    for (const article of state.candidates) {
      const item = selected.get(keyOf(article));
      if (item) item.queryIds.push(state.query.id);
      else state.truncated = true;
    }
  }
  const resolutions = new Map(), newEntries = {};
  for (const [key, { article, query, queryIds }] of selected) {
    const cached = cache.entries?.[key];
    let resolution;
    if (!forceResolve && cached && publisherUrl(cached.publisherUrl)) {
      resolution = { ...cached, resolutionStatus: 'resolved', resolutionErrorCode: null,
        resolutionHttpStatus: null, cacheHit: true };
    } else if (circuit) {
      resolution = { publisherUrl: null, resolutionStatus: 'unresolved', resolutionErrorCode: 'CircuitOpen',
        resolutionHttpStatus: null, cause: circuit.code, resolvedAt: null, cacheHit: false };
    } else {
      try {
        const found = await client.resolve(article.rssUrl, query);
        const url = publisherUrl(found.publisherUrl);
        if (!url) throw Object.assign(new Error('Invalid publisher URL'), { code: 'InvalidPublisherUrl' });
        resolution = { publisherUrl: url, method: found.method, resolvedAt: now().toISOString(),
          resolutionStatus: 'resolved', resolutionErrorCode: null, resolutionHttpStatus: null, cacheHit: false };
        newEntries[key] = { publisherUrl: url, method: found.method, resolvedAt: resolution.resolvedAt };
      } catch (error) {
        resolution = { publisherUrl: null, resolvedAt: null, resolutionStatus: 'unresolved',
          resolutionErrorCode: error.code ?? 'UnexpectedError', resolutionHttpStatus: error.status ?? null, cacheHit: false };
        if (blockingCodes.has(error.code)) circuit = errorInfo(error);
      }
    }
    resolutions.set(key, { ...article, ...resolution, matchedQueryIds: queryIds });
  }
  const completedAt = now().toISOString();
  const results = states.map(state => {
    const articles = state.candidates.filter(a => selected.has(keyOf(a))).map(article => ({
      ...article, ...resolutions.get(keyOf(article)),
      // Keep this feed's metadata when another topic matched the same Google article.
      title: article.title, publisher: article.publisher, rssDescription: article.rssDescription,
    }));
    const resolved = articles.filter(a => a.resolutionStatus === 'resolved').length;
    return {
      schemaVersion: 1, requestId, queryId: state.query.id, query: state.query.query, label: state.query.label,
      queryRevision: state.query.revision, configHash: state.query.configHash, source: state.query.source,
      locale: { language: state.query.language, country: state.query.country, edition: state.query.edition },
      startedAt, feedFetchedAt: state.feedFetchedAt, generatedAt: completedAt,
      status: state.feedError ? 'failed' : articles.length === 0 ? 'empty' : resolved === articles.length ? 'completed' : 'partial',
      error: state.feedError, truncated: state.truncated,
      counts: { selected: articles.length, resolved, unresolved: articles.length - resolved,
        cacheHits: articles.filter(a => a.cacheHit).length },
      articles,
    };
  });
  const status = results.some(r => r.status === 'failed' || r.status === 'partial') ? 'partial' : 'completed';
  return {
    request: { schemaVersion: 1, requestId, mode, status, startedAt, completedAt,
      uniqueArticles: selected.size, newResolutions: Object.keys(newEntries).length,
      httpRequests: client.requests ?? null, circuit,
      results: results.map((r, index) => ({ queryId: r.queryId, queryRevision: r.queryRevision,
        configHash: r.configHash, status: r.status, counts: r.counts, path: resultPath(queries[index], requestId) })) },
    results, newEntries,
  };
}

export function customId(query) {
  return `custom-${createHash('sha256').update(query).digest('hex').slice(0, 16)}`;
}
