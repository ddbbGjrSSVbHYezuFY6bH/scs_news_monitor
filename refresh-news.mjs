import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, normalizeConfig, selectQueries, identifier, integer } from './config.mjs';
import { GoogleNewsClient } from './google-news.mjs';
import { runBatch, customId } from './runner.mjs';
import { GitHubStore, mergeCache, updateIndex } from './github-store.mjs';

const emptyCache = { schemaVersion: 1, entries: {} };
const emptyIndex = { schemaVersion: 1, topics: {} };

async function jsonOr(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}

async function writeJson(root, file, value) {
  const destination = path.join(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
}

export function readOptions(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args, options: {
    validate: { type: 'boolean' }, publish: { type: 'boolean' }, 'force-resolve': { type: 'boolean' },
    mode: { type: 'string' }, query: { type: 'string' }, 'query-ids': { type: 'string' },
    'max-articles': { type: 'string' },
    queries: { type: 'string' }, 'request-id': { type: 'string' }, 'max-total': { type: 'string' },
    'interval-ms': { type: 'string' }, 'budget-ms': { type: 'string' }, output: { type: 'string' },
  } });
  const query = values.query ?? env.SCS_QUERY ?? '';
  let customQueries = JSON.parse(values.queries ?? env.SCS_QUERIES ?? '[]');
  if (query.trim()) {
    if (!Array.isArray(customQueries) || customQueries.length) throw new Error('Supply query or queries, not both.');
    customQueries = [{ id: customId(query.trim()), query,
      maxArticles: integer(values['max-articles'] || env.SCS_MAX_ARTICLES || '25', 'maxArticles', 1, 100) }];
  }
  return {
    validate: values.validate ?? false,
    publish: values.publish ?? env.SCS_PUBLISH === 'true',
    forceResolve: values['force-resolve'] ?? env.SCS_FORCE_RESOLVE === 'true',
    mode: values.mode ?? env.SCS_MODE ?? (query ? 'custom' : 'active'),
    queryIds: JSON.parse(values['query-ids'] ?? env.SCS_QUERY_IDS ?? '[]'), customQueries,
    requestId: identifier(values['request-id'] || env.SCS_REQUEST_ID ||
      (env.GITHUB_RUN_ID ? `run-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}` : `local-${Date.now()}`), 'requestId'),
    maxTotal: integer(values['max-total'] || env.SCS_MAX_TOTAL || '100', 'maxTotal', 1, 100),
    intervalMs: integer(values['interval-ms'] || env.SCS_INTERVAL_MS || '1200', 'intervalMs', 0, 60000),
    budgetMs: integer(values['budget-ms'] || env.SCS_BUDGET_MS || '480000', 'budgetMs', 1000, 600000),
    output: values.output ?? '.local/output',
  };
}

export async function refresh(root, options, { client, store } = {}) {
  const config = await loadConfig(root);
  const queries = selectQueries(config, options);
  if (options.validate) {
    return { validation: true, configuredQueries: config.queries.length, activeQueries: queries.length, timezone: config.timezone };
  }
  const initialCache = await jsonOr(path.join(root, 'data/resolution-cache.json'), emptyCache);
  const batch = await runBatch({ ...options, queries, cache: initialCache,
    client: client ?? new GoogleNewsClient({ intervalMs: options.intervalMs, budgetMs: options.budgetMs }) });
  batch.request.githubRunId = process.env.GITHUB_RUN_ID ?? null;
  const files = new Map(batch.results.map(result => [batch.request.results.find(r => r.queryId === result.queryId).path, result]));
  files.set(`runs/${options.requestId}.json`, batch.request);
  for (const [file, value] of files) await writeJson(path.resolve(root, options.output), file, value);
  await writeJson(path.resolve(root, options.output), 'data/resolution-cache.json', mergeCache(initialCache, batch.newEntries));
  if (options.publish) {
    store ??= new GitHubStore({ repository: process.env.GITHUB_REPOSITORY, token: process.env.GITHUB_TOKEN,
      branch: process.env.SCS_DATA_BRANCH || 'main' });
    batch.publication = await store.transaction(`Refresh news ${options.requestId}`, async read => {
      const existingRun = await read(`runs/${options.requestId}.json`, null);
      if (existingRun) throw new Error(`requestId already exists: ${options.requestId}. Use a new ID for each refresh.`);
      const currentConfig = normalizeConfig(await read('queries/standard.json'), await read('queries/temporary.json'));
      const changes = new Map(files);
      changes.set('data/resolution-cache.json', mergeCache(await read('data/resolution-cache.json', emptyCache), batch.newEntries));
      changes.set('data/index.json', updateIndex(await read('data/index.json', emptyIndex), batch, currentConfig.queries));
      return changes;
    });
  }
  return { ...batch.request, publication: batch.publication ?? null, localOutput: path.resolve(root, options.output) };
}

async function main() {
  const summary = await refresh(process.cwd(), readOptions());
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = (summary.results ?? []).map(r => `| ${r.queryId} | ${r.status} | ${r.counts.selected} | ${r.counts.resolved} |`);
    await writeFile(process.env.GITHUB_STEP_SUMMARY,
      `Request: \`${summary.requestId}\`\n\n| Topic | Status | Selected | Resolved |\n|---|---|---:|---:|\n${rows.join('\n')}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
