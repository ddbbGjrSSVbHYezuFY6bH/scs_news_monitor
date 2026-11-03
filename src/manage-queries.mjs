import { pathToFileURL } from 'node:url';
import { normalizeConfig, identifier, dateOnly, integer, isActive, localDate } from './config.mjs';
import { GitHubStore } from './github-store.mjs';
import { parseLookbackHours } from './search-window.mjs';

export function applyQueryChange(standardInput, temporaryInput, options, now = new Date()) {
  const standard = structuredClone(standardInput), temporary = structuredClone(temporaryInput);
  normalizeConfig(standard, temporary);
  const { operation, querySet = 'temporary', queryId, entries = [], activeUntil } = options;
  if (!['standard', 'temporary'].includes(querySet)) throw new Error('querySet must be standard or temporary.');
  const find = id => {
    for (const [source, config] of [['standard', standard], ['temporary', temporary]]) {
      const position = config.queries.findIndex(q => q.id === id);
      if (position !== -1) return { source, config, position, query: config.queries[position] };
    }
    throw new Error(`Unknown query: ${id}`);
  };
  const changedIds = [];
  if (operation === 'upsert') {
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 20) throw new Error('Supply 1–20 query entries.');
    const target = querySet === 'standard' ? standard : temporary;
    if (new Set(entries.map(q => q.id)).size !== entries.length) throw new Error('Duplicate IDs in update request.');
    for (const entry of entries) {
      identifier(entry.id);
      const other = querySet === 'standard' ? temporary : standard;
      if (other.queries.some(q => q.id === entry.id)) throw new Error(`ID exists in the other query set: ${entry.id}`);
      const position = target.queries.findIndex(q => q.id === entry.id);
      const old = position < 0 ? {} : target.queries[position];
      const next = { ...old, ...entry, revision: (old.revision ?? 0) + 1 };
      if (querySet === 'standard') { delete next.activeFrom; delete next.activeUntil; }
      if (position < 0) target.queries.push(next); else target.queries[position] = next;
      changedIds.push(entry.id);
    }
  } else if (['disable', 'extend', 'promote'].includes(operation)) {
    identifier(queryId, 'queryId');
    const found = find(queryId);
    const next = { ...found.query, revision: (found.query.revision ?? 1) + 1 };
    if (operation === 'disable') next.enabled = false;
    if (operation === 'extend') {
      if (found.source !== 'temporary') throw new Error('Only temporary queries have an expiry date.');
      next.activeUntil = dateOnly(activeUntil, 'activeUntil');
    }
    if (operation === 'promote') {
      if (found.source !== 'temporary') throw new Error('Query is already standard.');
      delete next.activeFrom; delete next.activeUntil;
      next.enabled = true;
      found.config.queries.splice(found.position, 1);
      standard.queries.push(next);
    } else found.config.queries[found.position] = next;
    changedIds.push(queryId);
  } else throw new Error('operation must be upsert, disable, extend or promote.');
  const config = normalizeConfig(standard, temporary);
  const today = localDate(now, config.timezone);
  return { standard, temporary, changedIds,
    refreshIds: config.queries.filter(q => changedIds.includes(q.id) && isActive(q, today)).map(q => q.id) };
}

async function main() {
  const env = process.env;
  const options = { operation: env.SCS_OPERATION, querySet: env.SCS_QUERY_SET || 'temporary',
    queryId: env.SCS_QUERY_ID, entries: JSON.parse(env.SCS_ENTRIES || '[]'), activeUntil: env.SCS_ACTIVE_UNTIL };
  const maxTotal = integer(env.SCS_MAX_TOTAL || '100', 'maxTotal', 1, 100);
  const lookbackHours = parseLookbackHours(env.SCS_LOOKBACK_HOURS ?? 24);
  const store = new GitHubStore({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN,
    branch: env.SCS_DATA_BRANCH || 'main' });
  let changed;
  const publication = await store.transaction('Update monitoring queries', async read => {
    changed = applyQueryChange(await read('queries/standard.json'), await read('queries/temporary.json'), options);
    return new Map([['queries/standard.json', changed.standard], ['queries/temporary.json', changed.temporary]]);
  });
  let refresh = 'not_requested';
  if (env.SCS_REFRESH_NOW === 'true') {
    if (!changed.refreshIds.length) refresh = 'no_active_queries';
    else {
      const requestId = identifier(env.SCS_REQUEST_ID || `update-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || '1'}`);
      try {
        await store.api('actions/workflows/refresh-news.yml/dispatches', {
          method: 'POST', body: JSON.stringify({ ref: store.branch, inputs: {
            mode: 'selected', queryIds: JSON.stringify(changed.refreshIds), requestId, maxTotal: String(maxTotal),
            lookbackHours: String(lookbackHours),
          } }),
        });
        refresh = 'dispatched';
      } catch (error) {
        console.error(`Configuration saved in ${publication.commit}, but refresh dispatch failed. Retry Refresh news. ${error.message}`);
        process.exitCode = 1; refresh = 'dispatch_failed';
      }
    }
  }
  console.log(JSON.stringify({ changedIds: changed.changedIds, publication, refresh }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
