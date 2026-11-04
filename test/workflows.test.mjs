import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parseDocument } from 'yaml';

test('Refresh news runs directly on schedule or manual dispatch alongside CI and query management', async () => {
  assert.deepEqual((await readdir(new URL('../.github/workflows', import.meta.url))).sort(),
    ['ci.yml', 'manage-queries.yml', 'refresh-news.yml']);
  const doc = parseDocument(await readFile(new URL('../.github/workflows/refresh-news.yml', import.meta.url), 'utf8'));
  assert.deepEqual(doc.errors, []);
  const workflow = doc.toJS();
  assert.equal(workflow.name, 'Refresh news');
  assert.deepEqual(Object.keys(workflow.jobs), ['refresh']);
  assert.equal(workflow.on.schedule[0].timezone, 'America/New_York');
  assert.equal(workflow.on.push, undefined);
  assert.equal(workflow.on.workflow_dispatch.inputs.runTimestamp, undefined);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.lookbackHours.options, ['24', '72']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.jobs.refresh.permissions.contents, 'write');
  assert.equal(workflow.jobs.refresh.permissions.actions, undefined);
  assert.equal(workflow.jobs.refresh.steps.at(-1).env.SCS_LOOKBACK_HOURS, "${{ inputs.lookbackHours || '24' }}");
  for (const step of workflow.jobs.refresh.steps) {
    if (step.run) {
      assert.doesNotMatch(step.run, /\$\{\{\s*(?:inputs|github\.event\.inputs)\./);
      assert.doesNotMatch(step.run, /dispatches/);
    }
  }
  assert.match(workflow.jobs.refresh.steps.at(-1).run, /node src\/refresh-news\.mjs --publish/);
});

test('query management requires dispatch on the default branch and isolates read and write permissions', async () => {
  const doc = parseDocument(await readFile(new URL('../.github/workflows/manage-queries.yml', import.meta.url), 'utf8'));
  assert.deepEqual(doc.errors, []);
  const workflow = doc.toJS();
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options, ['create', 'read', 'update', 'delete']);
  assert.equal(workflow.on.workflow_dispatch.inputs.operation.default, 'read');
  assert.equal(workflow.permissions.contents, 'read');
  assert.deepEqual(workflow.jobs.read.permissions, { contents: 'read' });
  assert.deepEqual(workflow.jobs.write.permissions, { contents: 'write' });
  assert.match(workflow.jobs.read.if, /inputs\.operation == 'read'/);
  assert.match(workflow.jobs.write.if, /create.*update.*delete/);
  for (const job of Object.values(workflow.jobs)) {
    assert.match(job.if, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
    assert.equal(job.steps[0].with.ref, '${{ github.event.repository.default_branch }}');
    assert.equal(job.steps[0].with['persist-credentials'], false);
    assert.equal(job.steps.at(-1).run, 'node src/manage-queries.mjs');
    assert.equal(job.steps.at(-1).env.SCS_ENTRY, '${{ inputs.entry }}');
    for (const step of job.steps) {
      if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*(?:inputs|github\.event\.inputs)\./);
    }
  }
});

test('CI tests code changes and validates the root query document with read-only permissions', async () => {
  const doc = parseDocument(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(doc.errors, []);
  const workflow = doc.toJS();
  assert.ok(workflow.on.push.paths.includes('queries.json'));
  assert.equal(workflow.permissions.contents, 'read');
  const commands = workflow.jobs.test.steps.map(step => step.run);
  assert.ok(commands.includes('npm test'));
  assert.ok(commands.includes('npm run validate'));
});
