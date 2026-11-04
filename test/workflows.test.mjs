import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

test('workflow definitions parse and keep user query input out of shell source', async () => {
  for (const name of ['ci', 'refresh-news', 'manage-queries']) {
    const text = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    const doc = parseDocument(text);
    assert.deepEqual(doc.errors, []);
    const workflow = doc.toJS();
    if (name !== 'ci') {
      assert.deepEqual(workflow.on.workflow_dispatch.inputs.lookbackHours.options, ['24', '72']);
      assert.equal(workflow.on.workflow_dispatch.inputs.lookbackHours.default, '24');
      const job = workflow.jobs.refresh ?? workflow.jobs.manage;
      assert.equal(job.steps.at(-1).env.SCS_LOOKBACK_HOURS, "${{ inputs.lookbackHours || '24' }}");
    }
    assert.equal(workflow.permissions.contents, 'read');
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*(?:inputs|github\.event\.inputs)\./);
      }
    }
    if (name === 'refresh-news') {
      assert.equal(workflow.on.schedule[0].timezone, 'America/New_York');
      assert.ok(workflow.on.workflow_dispatch.inputs.query);
      assert.equal(workflow.jobs.refresh.permissions.contents, 'write');
      assert.equal(workflow.on.push, undefined); // Result commits must not recursively refresh news.
    }
    if (name === 'manage-queries') assert.equal(workflow.jobs.manage.permissions.actions, 'write');
  }
});
