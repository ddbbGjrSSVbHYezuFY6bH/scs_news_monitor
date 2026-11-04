import { isActive, localDate } from './config.mjs';

export function timestampUtc(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error('Invalid run timestamp.');
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

export function validateTimestamp(value) {
  if (!/^\d{14}$/.test(value ?? '')) throw new Error('runTimestamp must be UTC YYYYMMDDHHMMSS.');
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`;
  if (timestampUtc(iso) !== value) throw new Error('Invalid calendar date in runTimestamp.');
  return value;
}

export function latestStandard(existing, batch, config) {
  if (batch.request.mode !== 'active' || batch.request.status !== 'completed' || !batch.results.length) return existing;
  const today = localDate(new Date(batch.request.startedAt), config.timezone);
  const active = config.queries.filter(query => isActive(query, today));
  if (active.length !== batch.results.length || !active.every(query => batch.results.some(result =>
    result.queryId === query.id && result.configHash === query.configHash && ['completed', 'empty'].includes(result.status)))) return existing;
  if (existing && existing.startedAt > batch.request.startedAt) return existing;
  return {
    schemaVersion: 2, batchType: 'standard', status: 'completed', requestId: batch.request.requestId,
    runTimestamp: batch.request.runTimestamp, startedAt: batch.request.startedAt,
    completedAt: batch.request.completedAt, manifestPath: batch.request.manifestPath,
    lookbackHours: batch.request.lookbackHours,
    topicCount: batch.results.length,
  };
}
