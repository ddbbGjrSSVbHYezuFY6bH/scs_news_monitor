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
