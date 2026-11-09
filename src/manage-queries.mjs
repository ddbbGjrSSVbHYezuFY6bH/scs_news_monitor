import { isDeepStrictEqual } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { identifier, normalizeConfig } from './config.mjs';
import { GitHubStore } from './github-store.mjs';

const operations = new Set(['create', 'read', 'update', 'delete']);
const editableFields = new Set(['label', 'query', 'enabled', 'maxArticles', 'language', 'country', 'edition', 'activeUntil']);

export function validateQueryOperation({ operation = 'read', queryId = '', entry = {} } = {}) {
  if (!operations.has(operation)) throw new Error('operation must be create, read, update or delete.');
  if (operation !== 'read' || queryId) identifier(queryId, 'queryId');
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('entry must be a JSON object.');
  const fields = Object.keys(entry);
  if (['read', 'delete'].includes(operation) && fields.length) throw new Error('entry is only used for create or update.');
  if (operation === 'create' && !fields.includes('query')) throw new Error('Create requires entry.query.');
  if (operation === 'update' && !fields.length) throw new Error('Update requires at least one field in entry.');
  for (const field of fields) {
    if (!editableFields.has(field)) throw new Error(`Unsupported query field: ${field}`);
    if (entry[field] === null && field !== 'activeUntil') throw new Error(`${field} cannot be null.`);
  }
  return { operation, queryId, entry };
}

export function applyQueryOperation(input, options) {
  const { operation, queryId, entry } = validateQueryOperation(options);
  const config = normalizeConfig(input);
  const document = structuredClone(input);
  const position = document.queries.findIndex(query => query.id === queryId);
  if (operation === 'read' && !queryId) return { document, queries: document.queries, changed: false };
  if (operation === 'create' && position !== -1) throw new Error(`Query already exists: ${queryId}`);
  if (operation !== 'create' && position === -1) throw new Error(`Unknown query: ${queryId}`);
  if (operation === 'read') return { document, queries: [document.queries[position]], changed: false };

  let affected;
  if (operation === 'delete') {
    [affected] = document.queries.splice(position, 1);
  } else {
    const previous = operation === 'update' ? document.queries[position] : { id: queryId, enabled: true };
    affected = { ...previous, ...structuredClone(entry) };
    if (affected.activeUntil === null) delete affected.activeUntil;
    if (operation === 'update' && isDeepStrictEqual(previous, affected)) {
      return { document, queries: [affected], changed: false };
    }
    affected.revision = operation === 'create' ? 1 : config.queries[position].revision + 1;
    if (operation === 'create') document.queries.push(affected);
    else document.queries[position] = affected;
  }
  normalizeConfig(document);
  return { document, queries: [affected], changed: true };
}

export async function manageQueries(options, { store, env = process.env } = {}) {
  options = validateQueryOperation(options);
  store ??= new GitHubStore({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN,
    branch: env.SCS_DATA_BRANCH || 'main' });
  let result, publication = null;
  if (options.operation === 'read') {
    result = applyQueryOperation(await store.readJson('queries.json'), options);
  } else {
    publication = await store.transaction(`Manage queries: ${options.operation} ${options.queryId}`, async read => {
      result = applyQueryOperation(await read('queries.json'), options);
      return result.changed ? new Map([['queries.json', result.document]]) : new Map();
    });
  }
  return { operation: options.operation, changed: result.changed, timezone: result.document.timezone ?? 'America/New_York',
    defaults: result.document.defaults ?? {}, queries: result.queries, publication };
}

async function main() {
  const summary = await manageQueries({ operation: process.env.SCS_OPERATION || 'read',
    queryId: process.env.SCS_QUERY_ID || '', entry: JSON.parse(process.env.SCS_ENTRY || '{}') });
  const json = JSON.stringify(summary, null, 2);
  console.log(json);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `Manage queries: ${summary.operation}\n\n\`\`\`json\n${json}\n\`\`\`\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
