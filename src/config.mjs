import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export function identifier(value, name = 'id') {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value)) {
    throw new Error(`${name} must contain 1–80 lowercase letters, digits, underscores or hyphens.`);
  }
  return value;
}

export function integer(value, name, min, max) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function dateOnly(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
    throw new Error(`${name} must be a valid YYYY-MM-DD date.`);
  }
  return value;
}

export function localDate(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function normalizeQuery(raw, defaults, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each query must be an object.');
  const id = identifier(raw.id);
  if (typeof raw.query !== 'string' || !raw.query.trim() || raw.query.length > 4000) {
    throw new Error(`${id}: query must contain 1–4000 characters.`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error(`${id}: enabled must be boolean.`);
  const query = {
    id, label: raw.label ?? id, query: raw.query.trim(),
    revision: integer(raw.revision ?? 1, `${id}.revision`, 1, 1_000_000),
    enabled: raw.enabled ?? true,
    maxArticles: integer(raw.maxArticles ?? defaults.maxArticles ?? 25, `${id}.maxArticles`, 1, 100),
    language: raw.language ?? defaults.language ?? 'en-US',
    country: raw.country ?? defaults.country ?? 'US',
    edition: raw.edition ?? defaults.edition ?? 'US:en',
    source,
  };
  for (const field of ['label', 'language', 'country', 'edition']) {
    if (typeof query[field] !== 'string' || !query[field].trim() || query[field].length > 200) {
      throw new Error(`${id}: invalid ${field}.`);
    }
  }
  if (source === 'temporary' || raw.activeFrom !== undefined || raw.activeUntil !== undefined) {
    query.activeFrom = dateOnly(raw.activeFrom, `${id}.activeFrom`);
    query.activeUntil = dateOnly(raw.activeUntil, `${id}.activeUntil`);
    if (query.activeFrom > query.activeUntil) throw new Error(`${id}: activeFrom is after activeUntil.`);
  }
  query.configHash = createHash('sha256').update(JSON.stringify(query)).digest('hex');
  return query;
}

export function normalizeConfig(standard, temporary) {
  for (const [name, config] of [['standard', standard], ['temporary', temporary]]) {
    if (!config || config.schemaVersion !== 1 || !Array.isArray(config.queries)) {
      throw new Error(`${name}.json must have schemaVersion: 1 and a queries array.`);
    }
  }
  const timezone = standard.timezone ?? 'America/New_York';
  localDate(new Date(), timezone); // Validate the IANA timezone before any HTTP requests.
  const defaults = standard.defaults ?? {};
  const queries = [
    ...standard.queries.map(q => normalizeQuery(q, defaults, 'standard')),
    ...temporary.queries.map(q => normalizeQuery(q, defaults, 'temporary')),
  ];
  if (queries.length > 100) throw new Error('At most 100 configured queries are supported.');
  if (new Set(queries.map(q => q.id)).size !== queries.length) throw new Error('Query IDs must be unique across both files.');
  return { timezone, defaults, queries };
}

export async function loadConfig(root) {
  const read = name => readFile(path.join(root, 'queries', `${name}.json`), 'utf8').then(JSON.parse);
  return normalizeConfig(await read('standard'), await read('temporary'));
}

export function isActive(query, today) {
  return query.enabled && (!query.activeFrom || query.activeFrom <= today) &&
    (!query.activeUntil || today <= query.activeUntil);
}

export function selectQueries(config, { mode = 'active', queryIds = [], customQueries = [] } = {}, now = new Date()) {
  const today = localDate(now, config.timezone);
  if (mode === 'custom') {
    if (!Array.isArray(customQueries) || customQueries.length < 1 || customQueries.length > 20) {
      throw new Error('Custom mode requires between 1 and 20 queries.');
    }
    const selected = customQueries.map((q, index) => normalizeQuery({
      ...q, id: q.id ?? `custom-${index + 1}`, enabled: true,
    }, config.defaults, 'custom'));
    if (new Set(selected.map(q => q.id)).size !== selected.length) throw new Error('Duplicate custom query IDs.');
    return selected;
  }
  if (!['active', 'selected'].includes(mode)) throw new Error('mode must be active, selected or custom.');
  if (!Array.isArray(queryIds)) throw new Error('queryIds must be a JSON array.');
  if (mode === 'selected') {
    if (!queryIds.length) throw new Error('Selected mode requires queryIds.');
    for (const id of queryIds) {
      identifier(id);
      const query = config.queries.find(q => q.id === id);
      if (!query) throw new Error(`Unknown query: ${id}`);
      if (!isActive(query, today)) throw new Error(`Query is disabled or outside its active dates: ${id}`);
    }
    return config.queries.filter(q => queryIds.includes(q.id));
  }
  if (queryIds.length) throw new Error('Use selected mode when supplying queryIds.');
  return config.queries.filter(q => isActive(q, today));
}
