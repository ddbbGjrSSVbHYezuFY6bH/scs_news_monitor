import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, normalizeConfig, selectQueries, identifier } from './config.mjs';
import { GoogleNewsClient } from './google-news.mjs';
import { runBatch } from './runner.mjs';
import { GitHubStore, mergeCache, updateIndex } from './github-store.mjs';
import { readOptions } from './refresh-news.mjs';
import { timestampUtc, validateTimestamp, latestStandard } from './batch-index-v2.mjs';

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function refreshV2(root, args = [], env = process.env, dependencies = {}) {
  const now = dependencies.now ?? (() => new Date());
  const runTimestamp = validateTimestamp(env.SCS_RUN_TIMESTAMP || timestampUtc(now()));
  const options = readOptions(args, env);
  if (!env.SCS_REQUEST_ID && !args.includes('--request-id')) {
    options.requestId = identifier(`${runTimestamp}-${env.GITHUB_RUN_ID || 'local'}-${env.GITHUB_RUN_ATTEMPT || '1'}`);
  }
  const config = await loadConfig(root), queries = selectQueries(config, options, now());
  if (options.validate) return { validation: true, configuredQueries: config.queries.length,
    activeQueries: queries.length, lookbackHours: options.lookbackHours };
  const cache = await readJson(path.join(root, 'data/resolution-cache.json'), { schemaVersion: 1, entries: {} });
  const batch = await runBatch({ ...options, queries, cache, now, client: dependencies.client ??
    new GoogleNewsClient({ intervalMs: options.intervalMs, budgetMs: options.budgetMs }) });
  const manifestPath = `runs/v2/${runTimestamp}/${options.requestId}.json`;
  Object.assign(batch.request, { schemaVersion: 2, batchType: options.mode === 'active' ? 'standard' : 'requested',
    runTimestamp, manifestPath, githubRunId: env.GITHUB_RUN_ID ?? null });
  const files = new Map(batch.results.map(result => {
    const descriptor = batch.request.results.find(item => item.queryId === result.queryId);
    descriptor.path = `results/v2/${runTimestamp}/${options.requestId}/${result.queryId}.json`;
    Object.assign(result, { schemaVersion: 2, runTimestamp, batchType: batch.request.batchType });
    return [descriptor.path, result];
  }));
  // The stable request-ID alias supports direct lookup without listing runs or sorting filenames.
  files.set(manifestPath, batch.request);
  files.set(`runs/${options.requestId}.json`, batch.request);
  const localRoot = path.resolve(root, options.output);
  for (const [file, value] of files) {
    const destination = path.join(localRoot, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
  }
  if (options.publish) {
    const store = dependencies.store ?? new GitHubStore({ repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN,
      branch: env.SCS_DATA_BRANCH || 'main' });
    batch.publication = await store.transaction(`News ${runTimestamp} (${options.requestId})`, async read => {
      if (await read(`runs/${options.requestId}.json`, null)) throw new Error('Request ID already exists; use a new ID.');
      const current = normalizeConfig(await read('queries/standard.json'), await read('queries/temporary.json'));
      const changes = new Map(files);
      changes.set('data/resolution-cache.json', mergeCache(await read('data/resolution-cache.json', { entries: {} }), batch.newEntries));
      changes.set('data/v2/index.json', updateIndex(await read('data/v2/index.json', { topics: {} }), batch, current.queries));
      const previous = await read('data/latest-standard.json', null);
      const latest = latestStandard(previous, batch, current);
      if (latest !== previous) changes.set('data/latest-standard.json', latest);
      return changes;
    });
  }
  return { ...batch.request, publication: batch.publication ?? null };
}

async function main() {
  const summary = await refreshV2(process.cwd(), process.argv.slice(2));
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `Run timestamp (UTC): \`${summary.runTimestamp}\`\n\nRequest: \`${summary.requestId}\`\n\n` +
      `Manifest: \`${summary.manifestPath}\`\n\nLookback: ${summary.lookbackHours} hours\n\n| Topic | Status | Resolved |\n|---|---|---:|\n` +
      summary.results.map(item => `| ${item.queryId} | ${item.status} | ${item.counts.resolved} |`).join('\n'));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`${error.name}: ${error.message}`); process.exitCode = 1; });
}
