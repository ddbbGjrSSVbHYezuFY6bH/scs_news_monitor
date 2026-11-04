import { publisherUrl } from './google-news.mjs';

export function timestampUtc(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error('Invalid run timestamp.');
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

export function resultPath(batch) {
  const prefix = `${batch.runTimestamp}-`;
  const suffix = batch.requestId.startsWith(prefix) ? batch.requestId.slice(prefix.length) : batch.requestId;
  return `results/${prefix}${suffix}.json`;
}

export function latestPointer(previous, batch, file = resultPath(batch)) {
  // A slower, older refresh must not replace a newer result.
  if (previous && previous.startedAt > batch.startedAt) return previous;
  return { schemaVersion: 3, path: file, startedAt: batch.startedAt, status: batch.status };
}

export function resolutionCache(batch) {
  const entries = {};
  for (const result of batch?.results ?? []) for (const article of result.articles) {
    if (article.resolutionStatus !== 'resolved' || !publisherUrl(article.publisherUrl)) continue;
    const key = article.googleArticleId ?? article.rssUrl;
    if (!entries[key] || article.resolvedAt > entries[key].resolvedAt) {
      entries[key] = { publisherUrl: article.publisherUrl, method: article.method, resolvedAt: article.resolvedAt };
    }
  }
  return { entries };
}
