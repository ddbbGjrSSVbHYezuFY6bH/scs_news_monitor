import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeConfig, pruneExpiredQueries, selectQueries, identifier, integer } from './config.mjs';
import { GoogleNewsClient } from './google-news.mjs';
import { runBatch, customId } from './runner.mjs';
import { GitHubStore } from './github-store.mjs';
import { parseLookbackHours } from './search-window.mjs';
import { timestampUtc, resultPath, latestPointer, resolutionCache } from './results.mjs';

async function jsonOr(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return structuredClone(fallback); throw error; }
}

async function writeJson(root, file, value) {
  const destination = path.join(root, file);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
}

async function readLatest(read) {
  const pointer = await read('latest.json', null);
  if (!pointer) return { pointer: null, batch: null };
  if (!/^results\/[a-z0-9][a-z0-9_-]*\.json$/.test(pointer.path ?? '')) {
    throw new Error('latest.json must point to a JSON file directly inside results/.');
  }
  const batch = await read(pointer.path, null);
  // Historical output is an optional cache. A deleted result also invalidates its pointer.
  return { pointer: batch ? pointer : null, batch };
}

export function readOptions(args = process.argv.slice(2), env = process.env) {
  const { values } = parseArgs({ args, options: {
    validate: { type: 'boolean' }, publish: { type: 'boolean' }, 'force-resolve': { type: 'boolean' },
    mode: { type: 'string' }, query: { type: 'string' }, 'query-ids': { type: 'string' },
    'max-articles': { type: 'string' }, 'lookback-hours': { type: 'string' },
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
    mode: values.mode || env.SCS_MODE || (query.trim() || customQueries.length ? 'custom' : 'active'),
    queryIds: JSON.parse(values['query-ids'] ?? env.SCS_QUERY_IDS ?? '[]'), customQueries,
    requestId: values['request-id'] || env.SCS_REQUEST_ID ?
      identifier(values['request-id'] || env.SCS_REQUEST_ID, 'requestId') :
      identifier(env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || '1'}` : `local-${randomUUID()}`),
    maxTotal: integer(values['max-total'] || env.SCS_MAX_TOTAL || '100', 'maxTotal', 1, 100),
    lookbackHours: parseLookbackHours(values['lookback-hours'] ?? env.SCS_LOOKBACK_HOURS ?? 24),
    intervalMs: integer(values['interval-ms'] || env.SCS_INTERVAL_MS || '1200', 'intervalMs', 0, 60000),
    budgetMs: integer(values['budget-ms'] || env.SCS_BUDGET_MS || '480000', 'budgetMs', 1000, 600000),
    output: values.output ?? '.local/output',
  };
}

export async function refresh(root, options, { client, store, now = () => new Date(), env = process.env } = {}) {
  const started = now();
  const original = JSON.parse(await readFile(path.join(root, 'queries.json'), 'utf8'));
  const cleaned = pruneExpiredQueries(original, started);
  const config = normalizeConfig(cleaned.document);
  const queries = selectQueries(config, options, started);
  if (options.validate) {
    return { validation: true, configuredQueries: config.queries.length, activeQueries: queries.length,
      expiredQueries: cleaned.expiredIds, timezone: config.timezone, lookbackHours: options.lookbackHours ?? 24 };
  }
  const outputRoot = path.resolve(root, options.output);
  const repositoryLatest = await readLatest((file, fallback) => jsonOr(path.join(root, file), fallback));
  const localLatest = outputRoot === path.resolve(root) ? repositoryLatest :
    await readLatest((file, fallback) => jsonOr(path.join(outputRoot, file), fallback));
  const latest = !localLatest.pointer || (repositoryLatest.pointer &&
    repositoryLatest.pointer.startedAt > localLatest.pointer.startedAt) ? repositoryLatest : localLatest;
  const runTimestamp = timestampUtc(started);
  const file = resultPath({ runTimestamp, requestId: options.requestId });
  if (await jsonOr(path.join(outputRoot, file), null)) throw new Error(`Results file already exists: ${file}`);
  if (cleaned.expiredIds.length) await writeJson(root, 'queries.json', cleaned.document);
  const batch = await runBatch({ ...options, queries, cache: resolutionCache(latest.batch), now,
    client: client ?? new GoogleNewsClient({ intervalMs: options.intervalMs, budgetMs: options.budgetMs }) });
  Object.assign(batch, { runTimestamp, githubRunId: env.GITHUB_RUN_ID ?? null });
  await writeJson(outputRoot, file, batch);
  await writeJson(outputRoot, 'latest.json', latestPointer(localLatest.pointer, batch, file));
  let publication = null;
  if (options.publish) {
    store ??= new GitHubStore({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN,
      branch: env.SCS_DATA_BRANCH || 'main' });
    publication = await store.transaction(`Refresh news ${runTimestamp} (${options.requestId})`, async read => {
      if (await read(file, null)) throw new Error(`Results file already exists: ${file}`);
      const current = pruneExpiredQueries(await read('queries.json'), now());
      const changes = new Map([[file, batch]]);
      const { pointer: previous } = await readLatest(read);
      const pointer = latestPointer(previous, batch, file);
      if (pointer !== previous) changes.set('latest.json', pointer);
      if (current.expiredIds.length) changes.set('queries.json', current.document);
      return changes;
    });
  }
  return { requestId: batch.requestId, runTimestamp, status: batch.status, resultsPath: file,
    lookbackHours: batch.lookbackHours, queryCount: batch.results.length, uniqueArticles: batch.uniqueArticles,
    expiredQueries: cleaned.expiredIds, publication, localOutput: outputRoot };
}

async function main() {
  const summary = await refresh(process.cwd(), readOptions());
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY,
      summary.validation ? `Configuration valid: ${summary.activeQueries} active queries.\n` :
        `Results: [${summary.resultsPath}](https://github.com/${process.env.GITHUB_REPOSITORY}/blob/${process.env.SCS_DATA_BRANCH || 'main'}/${summary.resultsPath})\n\n` +
        `Status: ${summary.status}; Queries: ${summary.queryCount}; Unique articles: ${summary.uniqueArticles}; Lookback: ${summary.lookbackHours} hours\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
