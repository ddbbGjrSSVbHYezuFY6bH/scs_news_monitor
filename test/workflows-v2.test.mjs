import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

test('v2 dispatch generates a UTC timestamp and preserves query data outside shell source', async () => {
  const source = await readFile(new URL('../.github/workflows/refresh-news-v2.yml', import.meta.url), 'utf8');
  const doc = parseDocument(source);
  assert.deepEqual(doc.errors, []);
  const workflow = doc.toJS();
  assert.equal(workflow.on.schedule[0].timezone, 'America/New_York');
  assert.equal(workflow.on.push, undefined);
  assert.match(workflow['run-name'], /inputs\.runTimestamp/);
  assert.equal(workflow.jobs.timestamp.permissions.actions, 'write');
  assert.equal(workflow.jobs.refresh.permissions.contents, 'write');
  assert.match(workflow.jobs.timestamp.if, /!inputs\.runTimestamp/);
  assert.match(workflow.jobs.refresh.if, /inputs\.runTimestamp != ''/);
  const dispatch = workflow.jobs.timestamp.steps[0];
  assert.match(dispatch.run, /date -u \+%Y%m%d%H%M%S/);
  assert.match(dispatch.run, /--input dispatch\.json/);
  assert.equal(dispatch.env.QUERY, '${{ inputs.query }}');
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.lookbackHours.options, ['24', '72']);
  assert.equal(dispatch.env.LOOKBACK_HOURS, "${{ inputs.lookbackHours || '24' }}");
  assert.match(dispatch.run, /--arg lookback "\$LOOKBACK_HOURS"/);
  assert.match(dispatch.run, /lookbackHours:\$lookback/);
  assert.equal(workflow.jobs.refresh.steps.at(-1).env.SCS_LOOKBACK_HOURS, "${{ inputs.lookbackHours || '24' }}");
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.run) assert.doesNotMatch(step.run, /\$\{\{\s*(?:inputs|github\.event\.inputs)\./);
  }
});
