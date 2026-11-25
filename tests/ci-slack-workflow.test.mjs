import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync(new URL('../.github/workflows/ci-slack.yml', import.meta.url), 'utf8');
const job = (name) => workflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
const inputs = {
  branch: 'main', 'caller-workflow-path': '.github/workflows/alerts.yml',
  'workflow-names': '["Build"]', 'test-delivery': false,
};
const source = {
  workflow_id: 1, name: 'Build', path: '.github/workflows/build.yml',
  head_branch: 'main', head_repository: { full_name: 'contentauth/example' },
  event: 'push', status: 'completed', conclusion: 'failure',
};
const github = {
  repository: 'contentauth/example', event_name: 'workflow_run', ref: 'refs/heads/main',
  event: { workflow_run: source },
};

function evaluate(expression, context = {}) {
  return runInNewContext(expression.replace(/\.([\w]+-[\w-]+)/g, "['$1']"), {
    github, inputs, cancelled: () => false,
    contains: (values, value) => values.includes(value),
    fromJSON: JSON.parse,
    format: (template, value) => template.replace('{0}', value),
    ...context,
  });
}

function enabled(name, context) {
  const block = job(name);
  const folded = block.match(/^    if: >-\n((?: {6}.*\n)+)/m);
  const expression = folded ? folded[1] : block.match(/^    if: \$\{\{ (.*) \}\}/m)[1];
  return evaluate(expression, context);
}

test('eligible completion events and manual delivery run one notification job without discovery', () => {
  for (const event of ['push', 'schedule', 'workflow_dispatch']) {
    for (const conclusion of ['success', 'failure', 'timed_out', 'startup_failure']) {
      const context = { github: { ...github, event: { workflow_run: { ...source, event, conclusion } } } };
      assert.equal(enabled('notify', context), true);
      assert.equal(enabled('prepare', context), false);
      assert.doesNotMatch(job('notify'), /^    needs:/m);
    }
  }
  const manual = {
    github: { ...github, event_name: 'workflow_dispatch' },
    inputs: { ...inputs, 'test-delivery': true },
  };
  assert.equal(enabled('notify', manual), true);
  assert.equal(enabled('prepare', manual), false);
});

test('ignored completion events do not allocate discovery or notification runners', () => {
  for (const change of [
    { event: 'pull_request' }, { event: 'workflow_run' },
    { head_repository: { full_name: 'someone/example' } },
    { head_branch: 'stable' }, { name: 'Other build' },
    { path: inputs['caller-workflow-path'] }, { status: 'in_progress' },
    { conclusion: 'cancelled' }, { conclusion: 'skipped' }, { conclusion: 'neutral' },
  ]) {
    const context = { github: { ...github, event: { workflow_run: { ...source, ...change } } } };
    assert.equal(enabled('notify', context), false, JSON.stringify(change));
    assert.equal(enabled('prepare', context), false, JSON.stringify(change));
  }
  const wildcard = { ...inputs, 'workflow-names': '["*"]' };
  assert.equal(enabled('notify', {
    inputs: wildcard, github: { ...github, event: { workflow_run: { ...source, name: 'Future build' } } },
  }), true);
  assert.equal(enabled('notify', {
    inputs: wildcard,
    github: { ...github, event: { workflow_run: { ...source, path: inputs['caller-workflow-path'] } } },
  }), false);
});

test('discovery failures fail visibly without blocking other reminder jobs', () => {
  const context = {
    github: { ...github, event_name: 'schedule' },
    needs: { prepare: { result: 'failure', outputs: { 'workflow-ids': '[1,5]' } } },
  };
  assert.equal(enabled('prepare', context), true);
  assert.equal(enabled('notify', context), false);
  assert.equal(enabled('remind', context), true);
  assert.equal(enabled('remind', { ...context, cancelled: () => true }), false);
  assert.equal(enabled('remind', {
    ...context, needs: { prepare: { result: 'failure', outputs: { 'workflow-ids': '[]' } } },
  }), false);
  const report = job('prepare').split('      - name: Report discovery failures\n')[1];
  const condition = report.match(/        if: (.*)/)[1];
  for (const count of [0, 1, 3]) {
    assert.equal(evaluate(condition, {
      steps: { notifier: { outputs: { 'discovery-errors': String(count) } } },
    }), count > 0);
  }
  const result = spawnSync('bash', ['-e', '-c', report.split('        run: |\n')[1]], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::Reminder discovery failed/);
});

test('completion and reminder jobs share the same per-workflow serialization key', () => {
  const group = (name, context) => job(name).match(/^      group: (.*)/m)[1]
    .replace(/\$\{\{ (.*?) \}\}/g, (_match, expression) => evaluate(expression, context));
  assert.equal(group('notify'), group('remind', { matrix: { 'workflow-id': source.workflow_id } }));
  assert.notEqual(group('notify'), group('remind', { matrix: { 'workflow-id': 2 } }));
});
