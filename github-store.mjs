import { publisherUrl } from './google-news.mjs';

export class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class GitHubStore {
  constructor({ repository, token, branch = 'main', fetchImpl = fetch }) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('Invalid GitHub repository.');
    if (!token) throw new Error('A GitHub token is required for publication.');
    if (!/^[A-Za-z0-9_./-]+$/.test(branch) || branch.includes('..')) throw new Error('Invalid branch.');
    Object.assign(this, { repository, token, branch, fetchImpl });
  }

  async api(endpoint, options = {}) {
    const response = await this.fetchImpl(`https://api.github.com/repos/${this.repository}/${endpoint}`, {
      ...options, redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...options.headers },
    });
    if (!response.ok) {
      // Never print headers, tokens, input queries or arbitrary server response bodies.
      await response.body?.cancel();
      throw new GitHubError(response.status, `GitHub API ${response.status} for ${endpoint.split('?')[0]}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async readJson(file, ref = this.branch, fallback) {
    try {
      return await this.api(`contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, {
        headers: { Accept: 'application/vnd.github.raw+json' },
      });
    } catch (error) {
      if (error.status === 404 && fallback !== undefined) return structuredClone(fallback);
      throw error;
    }
  }

  async transaction(message, change) {
    // Compare-and-swap the branch reference. A competing commit causes a fresh read and merge.
    for (let attempt = 0; attempt < 5; attempt++) {
      const head = await this.api(`git/ref/heads/${this.branch}`);
      const commit = await this.api(`git/commits/${head.object.sha}`);
      const changes = await change((file, fallback) => this.readJson(file, head.object.sha, fallback));
      if (!changes.size) return { commit: head.object.sha, changed: false };
      const tree = await this.api('git/trees', { method: 'POST', body: JSON.stringify({ base_tree: commit.tree.sha,
        tree: [...changes].map(([file, value]) => ({ path: file, mode: '100644', type: 'blob', content: `${JSON.stringify(value, null, 2)}\n` })),
      }) });
      const next = await this.api('git/commits', { method: 'POST', body: JSON.stringify({ message,
        tree: tree.sha, parents: [head.object.sha] }) });
      try {
        await this.api(`git/refs/heads/${this.branch}`, { method: 'PATCH', body: JSON.stringify({ sha: next.sha, force: false }) });
        return { commit: next.sha, changed: true };
      } catch (error) {
        if (![409, 422].includes(error.status) || attempt === 4) throw error;
      }
    }
  }
}

export function mergeCache(existing, incoming) {
  const entries = { ...(existing.entries ?? {}) };
  for (const [id, value] of Object.entries(incoming)) {
    if (publisherUrl(value.publisherUrl) && (!entries[id] || value.resolvedAt >= entries[id].resolvedAt)) entries[id] = value;
  }
  // Retain the newest 10,000 successful mappings to bound file size.
  return { schemaVersion: 1, entries: Object.fromEntries(Object.entries(entries)
    .sort((a, b) => b[1].resolvedAt.localeCompare(a[1].resolvedAt)).slice(0, 10000)) };
}

export function updateIndex(existing, batch, currentQueries) {
  const index = structuredClone(existing);
  index.schemaVersion = 1;
  index.topics ??= {};
  for (const result of batch.results) {
    if (result.source === 'custom') continue;
    const current = currentQueries.find(q => q.id === result.queryId);
    // A query text edit without a manual revision bump is detected by configHash too.
    if (!current || current.configHash !== result.configHash) continue;
    const previous = index.topics[result.queryId];
    const resultTime = result.feedFetchedAt ?? result.startedAt;
    if (previous?.configHash === result.configHash && previous.latestAttempt.observedAt > resultTime) continue;
    const descriptor = batch.request.results.find(r => r.queryId === result.queryId);
    const topic = { queryRevision: result.queryRevision, configHash: result.configHash,
      latestAttempt: { requestId: result.requestId, status: result.status, generatedAt: result.generatedAt,
        observedAt: resultTime, path: descriptor.path }, latestUsable: null };
    if (previous?.configHash === result.configHash) topic.latestUsable = previous.latestUsable;
    if (result.status !== 'failed') topic.latestUsable = topic.latestAttempt;
    index.topics[result.queryId] = topic;
  }
  // Removed subscriptions must not survive as apparently current index entries.
  const ids = new Set(currentQueries.map(q => q.id));
  for (const id of Object.keys(index.topics)) if (!ids.has(id)) delete index.topics[id];
  return index;
}
