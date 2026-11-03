
/**
 * Filter RSS articles by their publication timestamp.
 *
 * Uses article.publishedAt, which is extracted from the
 * RSS <pubDate> element by google-news.mjs.
 *
 * @param {Array} articles - Parsed RSS articles
 * @param {string} startedAt - Batch start timestamp (ISO 8601)
 * @param {number} lookbackHours - Lookback window in hours
 * @returns {Array} Articles published within the time window
 */
export function filterByRssTimestamp(articles, startedAt, lookbackHours) {
  const windowEnd = Date.parse(startedAt);
  const windowStart = windowEnd - lookbackHours * 60 * 60 * 1000;

  return articles.filter(article => {
    if (!article.publishedAt) return false;

    const published = Date.parse(article.publishedAt);

    return (
      Number.isFinite(published) &&
      published >= windowStart &&
      published <= windowEnd
    );
  });
}
