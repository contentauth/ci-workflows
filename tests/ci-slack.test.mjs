import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeNotifier, notifier } from './notifier.mjs';

const config = {
  branch: 'main',
  workflowNames: ['Tier 1A', 'Tier 1B', 'Tier 2'],
  callerPath: '.github/workflows/main-ci-slack.yml',
};
const { github, postSlack } = notifier;
const transition = (run, previous, repository, options) =>
  notifier.transition(run, previous, repository, config, options);
const notify = (run, previous, repository, send, options) =>
  notifier.notify(run, previous, repository, send, config, options);
const loadState = (id, repository, request, readArtifact) =>
  notifier.loadState(id, repository, request, config, readArtifact);

const repository = 'contentauth/c2pa-rs';
const now = Date.parse('2026-11-18T08:30:00Z');
const morning = Date.parse('2026-11-18T15:00:00Z');
const halfDayMs = 12 * 60 * 60 * 1000;
function run(overrides = {}) {
  return {
    name: 'Tier 1A',
    path: '.github/workflows/tier-1a.yml',
    workflow_id: 1,
    head_branch: 'main',
    head_repository: { full_name: repository },
    event: 'push',
    status: 'completed',
    conclusion: 'success',
    run_number: 1,
    run_attempt: 1,
    head_sha: '1234567890abcdef',
    html_url: 'https://github.com/contentauth/c2pa-rs/actions/runs/1',
    updated_at: '2026-11-18T08:27:43Z',
    ...overrides,
  };
}

test('pass -> fail -> fail -> pass -> fail alerts on every failed run', () => {
  let previous;
  const alerts = ['success', 'failure', 'failure', 'success', 'failure'].map((conclusion, i) => {
    const result = transition(run({ conclusion, run_number: i + 1 }), previous, repository);
    previous = result.state;
    return result.alert;
  });
  assert.deepEqual(alerts, [false, true, true, false, true]);
});

test('the first observed failure alerts; a passing baseline does not', () => {
  assert.equal(transition(run({ conclusion: 'failure' }), undefined, repository).alert, true);
  assert.equal(transition(run(), undefined, repository).alert, false);
});

test('cancelled, skipped, PR, fork, other branch and advisory results do not reset state', () => {
  const previous = transition(run({ conclusion: 'failure' }), undefined, repository).state;
  for (const overrides of [
    { conclusion: 'cancelled' },
    { conclusion: 'skipped' },
    { conclusion: 'neutral' },
    { event: 'pull_request' },
    { head_repository: { full_name: 'someone/c2pa-rs' } },
    { head_branch: 'stable' },
    { name: 'Experimental features (non-blocking)' },
    { status: 'in_progress' },
  ]) {
    assert.deepEqual(
      transition(run({ run_number: 2, ...overrides }), previous, repository),
      { state: previous, alert: false, reason: 'ineligible' },
    );
  }
});

test('all tiers and supported run events are monitored', () => {
  for (const name of ['Tier 1A', 'Tier 1B', 'Tier 2']) {
    for (const event of ['push', 'schedule', 'workflow_dispatch']) {
      assert.equal(transition(run({ name, event, conclusion: 'failure' }), undefined, repository).alert, true);
    }
  }
});

test('wildcard monitors arbitrary workflow names and alerts on every failed run', () => {
  const all = { ...config, workflowNames: ['*'] };
  for (const name of ['Release', 'Update schemas', 'New workflow', 'Experimental features (non-blocking)']) {
    let previous;
    const alerts = ['success', 'failure', 'failure', 'success', 'failure'].map((conclusion, i) => {
      const result = notifier.transition(run({ name, conclusion, run_number: i + 1 }), previous, repository, all);
      previous = result.state;
      return result.alert;
    });
    assert.deepEqual(alerts, [false, true, true, false, true], name);
  }
});

test('wildcard still excludes notifier, PRs, forks, other branches and ignored results', () => {
  const all = notifier.configuration({
    CI_SLACK_WORKFLOWS: '["*"]', CI_SLACK_BRANCH: config.branch,
    CI_SLACK_CALLER_PATH: config.callerPath,
  });
  const previous = notifier.transition(run({ conclusion: 'failure' }), undefined, repository, all).state;
  for (const overrides of [
    { path: config.callerPath, event: 'workflow_dispatch' },
    { event: 'pull_request' },
    { event: 'pull_request_target' },
    { event: 'workflow_run' },
    { head_repository: { full_name: 'someone/c2pa-rs' } },
    { head_branch: 'stable' },
    { conclusion: 'cancelled' },
    { conclusion: 'skipped' },
    { conclusion: 'neutral' },
  ]) {
    assert.deepEqual(
      notifier.transition(run({ run_number: 2, ...overrides }), previous, repository, all),
      { state: previous, alert: false, reason: 'ineligible' },
    );
  }
});

test('explicit workflow lists also exclude notifier itself by path, regardless of name', () => {
  const result = transition(run({
    name: 'Tier 1A', path: config.callerPath, event: 'workflow_dispatch', conclusion: 'failure',
  }), undefined, repository);
  assert.deepEqual(result, { state: undefined, alert: false, reason: 'ineligible' });
});

test('timeouts and startup failures count as failures', () => {
  for (const conclusion of ['timed_out', 'startup_failure']) {
    assert.equal(transition(run({ conclusion }), undefined, repository).alert, true);
  }
});

test('duplicate events and late completions from older runs are ignored', () => {
  const previous = transition(run({ run_number: 5 }), undefined, repository).state;
  for (const run_number of [4, 5]) {
    assert.deepEqual(
      transition(run({ run_number, conclusion: 'failure' }), previous, repository),
      { state: previous, alert: false, reason: 'duplicate-or-older' },
    );
  }
});

test('each failed rerun alerts; successful reruns clear the failing state', () => {
  const first = transition(run({ conclusion: 'failure' }), undefined, repository);
  const second = transition(run({ conclusion: 'failure', run_attempt: 2 }), first.state, repository);
  assert.equal(second.alert, true);
  const recovered = transition(run({ run_attempt: 3 }), second.state, repository);
  assert.equal(recovered.state.failing, false);
  const broken = transition(run({ run_number: 2, conclusion: 'failure' }), recovered.state, repository);
  assert.equal(broken.alert, true);
});

test('mismatched and malformed saved state fails explicitly', () => {
  for (const previous of [{}, { version: 1, workflow_id: 2 }]) {
    assert.throws(() => transition(run(), previous, repository), /Invalid saved/);
  }
});

test('delivery contains the failed run link and commit', async () => {
  const messages = [];
  await notify(run({ conclusion: 'failure' }), undefined, repository, async (text) => messages.push(text));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Tier 1A is failing on main/);
  assert.match(messages[0], /1234567890ab/);
  assert.match(messages[0], /https:\/\/github.com\/contentauth\/c2pa-rs\/actions\/runs\/1/);
});

test('failed delivery cannot produce an advanced state', async () => {
  await assert.rejects(
    notify(run({ conclusion: 'failure' }), undefined, repository, async () => { throw new Error('delivery failed'); }),
    /delivery failed/,
  );
});

test('Slack receives JSON with link unfurling disabled', async () => {
  const webhook = 'https://hooks.slack.com/services/test';
  await postSlack(webhook, 'test message', async (url, options) => {
    assert.equal(String(url), webhook);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), {
      text: 'test message', unfurl_links: false, unfurl_media: false,
    });
    return new Response('ok', { status: 200 });
  });
});

test('missing secrets, rejected webhooks, and unexpected Slack replies fail explicitly', async () => {
  await assert.rejects(postSlack('', 'test'), /not configured/);
  await assert.rejects(postSlack('https://example.com/webhook', 'test'), /Slack HTTPS/);
  for (const response of [
    new Response('invalid_payload', { status: 400 }),
    new Response('unexpected', { status: 200 }),
  ]) {
    await assert.rejects(
      postSlack('https://hooks.slack.com/services/test', 'test', async () => response),
      /Slack rejected/,
    );
  }
});

test('network failures do not expose the webhook secret', async () => {
  const secret = 'https://hooks.slack.com/services/secret';
  await assert.rejects(
    postSlack(secret, 'test', async () => { throw new Error(`request to ${secret} failed`); }),
    (error) => !error.message.includes(secret) && /request failed/.test(error.message),
  );
});

test('saved state is loaded only from this notifier on trusted main', async () => {
  const name = 'ci-slack-state-1';
  const calls = [];
  const sources = [
    { event: 'pull_request' },
    { head_repository: { full_name: 'someone/c2pa-rs' } },
    { path: '.github/workflows/unrelated.yml' },
    {},
  ];
  const request = async (path) => {
    calls.push(path);
    if (path.includes('/actions/artifacts?')) {
      return Response.json({ artifacts: sources.map((_, i) => ({
        id: 10 - i, name, expired: false, workflow_run: { id: i + 1, head_branch: 'main' },
      })) });
    }
    const match = path.match(/^\/actions\/runs\/(\d+)$/);
    if (match) {
      return Response.json({
        id: Number(match[1]),
        path: '.github/workflows/main-ci-slack.yml',
        event: 'workflow_run',
        head_branch: 'main',
        head_repository: { full_name: repository },
        ...sources[Number(match[1]) - 1],
      });
    }
    assert.equal(path, '/actions/artifacts/7/zip');
    return new Response('state archive');
  };
  const expected = { version: 1, failing: true };
  assert.deepEqual(await loadState(1, repository, request, (buffer) => {
    assert.equal(Buffer.from(buffer).toString(), 'state archive');
    return expected;
  }), expected);
  assert.equal(calls.filter((path) => path.endsWith('/zip')).length, 1);
});

test('state discovery paginates past expired artifacts', async () => {
  const calls = [];
  const result = await loadState(1, repository, async (path) => {
    calls.push(path);
    return Response.json({
      artifacts: path.endsWith('page=1')
        ? Array.from({ length: 100 }, () => ({ name: 'ci-slack-state-1', expired: true }))
        : [],
    });
  });
  assert.equal(result, undefined);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /page=2$/);
});

test('GitHub API errors fail instead of resetting saved state', async () => {
  await assert.rejects(github('/actions/artifacts', '', async () => {}), /GH_TOKEN/);
  await assert.rejects(
    github('/actions/artifacts', 'test-token', async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      return new Response('forbidden', { status: 403 });
    }),
    /GitHub API request failed \(HTTP 403\)/,
  );
  await assert.rejects(
    loadState(1, repository, async () => { throw new Error('GitHub unavailable'); }),
    /GitHub unavailable/,
  );
});

test('downloaded state archives are extracted and invalid JSON fails explicitly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'main-ci-slack-test-'));
  const previousTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = directory;
  try {
    const state = transition(run(), undefined, repository).state;
    for (const contents of [JSON.stringify(state), 'not JSON']) {
      writeFileSync(join(directory, 'ci-slack-state.json'), contents);
      execFileSync('zip', ['-j', join(directory, 'fixture.zip'), join(directory, 'ci-slack-state.json')]);
      const request = async (path) => {
        if (path.includes('/actions/artifacts?')) {
          return Response.json({ artifacts: [{
            id: 1, name: 'ci-slack-state-1', expired: false,
            workflow_run: { id: 1, head_branch: 'main' },
          }] });
        }
        if (path === '/actions/runs/1') {
          return Response.json({
            path: '.github/workflows/main-ci-slack.yml', event: 'workflow_run',
            head_branch: 'main', head_repository: { full_name: repository },
          });
        }
        assert.equal(path, '/actions/artifacts/1/zip');
        return new Response(readFileSync(join(directory, 'fixture.zip')));
      };
      if (contents === 'not JSON') {
        await assert.rejects(loadState(1, repository, request), SyntaxError);
      } else {
        assert.deepEqual(await loadState(1, repository, request), state);
      }
    }
  } finally {
    if (previousTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousTemp;
    rmSync(directory, { recursive: true });
  }
});

test('manual delivery without a secret exits unsuccessfully without a stack trace', () => {
  const result = executeNotifier({
    env: {
      ...process.env,
      SLACK_WEBHOOK_URL: '',
      CI_SLACK_WORKFLOWS: JSON.stringify(config.workflowNames),
      CI_SLACK_BRANCH: config.branch,
      CI_SLACK_CALLER_PATH: config.callerPath,
      CI_SLACK_TEST_DELIVERY: 'true',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/main',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'SLACK_WEBHOOK_URL is not configured');
});

test('configuration accepts other repos, workflow names, branches and wrapper paths', async () => {
  const custom = notifier.configuration({
    CI_SLACK_WORKFLOWS: '["Build and test"]',
    CI_SLACK_BRANCH: 'trunk',
    CI_SLACK_CALLER_PATH: '.github/workflows/alerts.yaml',
  });
  const otherRepo = 'contentauth/example';
  const source = run({
    name: 'Build and test', head_branch: 'trunk',
    head_repository: { full_name: otherRepo }, conclusion: 'failure',
  });
  const messages = [];
  const state = await notifier.notify(source, undefined, otherRepo, async (text) => messages.push(text), custom);
  assert.equal(state.failing, true);
  assert.match(messages[0], /contentauth\/example: Build and test is failing on trunk/);
  assert.equal(notifier.transition(run(), undefined, repository, custom).state, undefined);
});

test('invalid workflow lists and caller paths fail explicitly', () => {
  const env = {
    CI_SLACK_WORKFLOWS: '["Build"]', CI_SLACK_BRANCH: 'main',
    CI_SLACK_CALLER_PATH: '.github/workflows/alerts.yml',
  };
  for (const CI_SLACK_WORKFLOWS of ['not json', '[]', '{}', '[""]', '[1]']) {
    assert.throws(() => notifier.configuration({ ...env, CI_SLACK_WORKFLOWS }));
  }
  for (const CI_SLACK_CALLER_PATH of ['', 'scripts/alerts.yml', '.github/workflows/nested/alerts.yml']) {
    assert.throws(() => notifier.configuration({ ...env, CI_SLACK_CALLER_PATH }), /valid caller/);
  }
  assert.throws(() => notifier.configuration({ ...env, CI_SLACK_BRANCH: '' }), /branch/);
});

test('entry point blocks test delivery from other events and branches', () => {
  for (const overrides of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_REF: 'refs/heads/untrusted' },
  ]) {
    const result = executeNotifier({
      env: {
        ...process.env, SLACK_WEBHOOK_URL: '',
        CI_SLACK_WORKFLOWS: '["Build"]', CI_SLACK_BRANCH: 'main',
        CI_SLACK_CALLER_PATH: '.github/workflows/alerts.yml',
        CI_SLACK_TEST_DELIVERY: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main', ...overrides,
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /manual dispatch on the configured branch/);
  }
});

test('entry point delivers a failure and writes artifact state and step output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-slack-entry-'));
  try {
    const eventPath = join(directory, 'event.json');
    const outputPath = join(directory, 'output');
    writeFileSync(eventPath, JSON.stringify({ workflow_run: run({ conclusion: 'failure' }) }));
    const mock = `
      Date.now = () => ${now};
      globalThis.fetch = async (url, options) => {
        if (String(url).startsWith('https://hooks.slack.com/')) {
          if (options.method !== 'POST' ||
              !JSON.parse(options.body).text.includes('Tier 1A is failing on main')) {
            throw new Error('Unexpected Slack request');
          }
          console.log('MOCK_SLACK_DELIVERY');
          return new Response('ok');
        }
        if (String(url).endsWith('/actions/artifacts?name=ci-slack-state-1&per_page=100&page=1')) {
          if (options.headers.Authorization !== 'Bearer test-token') throw new Error('Missing token');
          return Response.json({ artifacts: [] });
        }
        throw new Error('Unexpected network request');
      };
    `;
    const result = executeNotifier({
      cwd: directory,
      env: {
        ...process.env,
        SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/mock',
        GH_TOKEN: 'test-token', GITHUB_API_URL: 'https://api.github.com',
        GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'workflow_run',
        GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath,
        CI_SLACK_WORKFLOWS: JSON.stringify(config.workflowNames),
        CI_SLACK_BRANCH: config.branch, CI_SLACK_CALLER_PATH: config.callerPath,
        CI_SLACK_TEST_DELIVERY: 'false',
      },
      encoding: 'utf8',
    }, mock);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MOCK_SLACK_DELIVERY/);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'ci-slack-state.json'))), {
      version: 1, workflow_id: 1, run_number: 1, run_attempt: 1, failing: true,
      failing_since: Date.parse(run().updated_at), last_alert_at: now,
    });
    assert.equal(readFileSync(outputPath, 'utf8'), 'save-state=true\n');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('manual test posts a labeled message without writing state or step output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-slack-manual-'));
  try {
    const mock = `
        globalThis.fetch = async (_url, options) => {
          const text = JSON.parse(options.body).text;
          if (!text.startsWith('[TEST] contentauth/c2pa-rs:')) throw new Error('Not labeled');
          console.log('MOCK_TEST_DELIVERY');
          return new Response('ok');
        };
      `;
    const result = executeNotifier({
      cwd: directory,
      env: {
        ...process.env,
        SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/mock',
        GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF: 'refs/heads/main',
        CI_SLACK_WORKFLOWS: JSON.stringify(config.workflowNames),
        CI_SLACK_BRANCH: config.branch, CI_SLACK_CALLER_PATH: config.callerPath,
        CI_SLACK_TEST_DELIVERY: 'true',
        GITHUB_OUTPUT: join(directory, 'output'),
      },
      encoding: 'utf8',
    }, mock);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MOCK_TEST_DELIVERY/);
    assert.throws(() => readFileSync(join(directory, 'ci-slack-state.json')), { code: 'ENOENT' });
    assert.throws(() => readFileSync(join(directory, 'output')), { code: 'ENOENT' });
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('reminders follow 03:00 UTC and 15:00 UTC without needing a new CI run', async () => {
  const source = run({ conclusion: 'failure' });
  const messages = [];
  const logs = [];
  const options = { now, log: (line) => logs.push(JSON.parse(line)) };
  const send = async (text) => messages.push(text);
  const initial = await notify(source, undefined, repository, send, options);
  assert.equal(logs.at(-1).reason, 'failure');
  const before = await notify(source, initial, repository, send, {
    ...options, now: morning - 1, sweep: true,
  });
  assert.equal(messages.length, 1);
  assert.equal(before.last_alert_at, now);
  assert.equal(logs.at(-1).decision, 'suppressed');
  assert.equal(logs.at(-1).reason, 'not-due');
  assert.equal(logs.at(-1).seconds_until_reminder, 1);

  const due = await notify(source, before, repository, send, {
    ...options, now: morning, sweep: true,
  });
  assert.equal(messages.length, 2);
  assert.match(messages[1], /is still failing/);
  assert.match(messages[1], /Known failing since: 2026-11-18T08:27:43.000Z \(6.5 hours\)/);
  assert.match(messages[1], /Last completed result: 2026-11-18T08:27:43.000Z/);
  assert.match(messages[1], /actions\/runs\/1/);
  assert.equal(due.failing_since, Date.parse(source.updated_at));
  assert.equal(due.last_reminder_slot, morning);
  assert.equal(logs.at(-1).decision, 'sent');
  assert.equal(logs.at(-1).reason, 'reminder');
  assert.equal(logs.at(-1).next_reminder_due, '2026-11-19T03:00:00.000Z');

  const evening = await notify(source, due, repository, send, {
    ...options, now: morning + halfDayMs, sweep: true,
  });
  assert.equal(messages.length, 3);
  assert.equal(evening.last_reminder_slot, morning + halfDayMs);
  assert.equal(logs.at(-1).next_reminder_due, '2026-11-19T15:00:00.000Z');
});

test('each failure alerts immediately without postponing fixed-time reminders', async () => {
  const messages = [];
  const send = async (text) => messages.push(text);
  const source = run({ conclusion: 'failure' });
  const initial = await notify(source, undefined, repository, send, { now });
  const repeatedRun = run({
    conclusion: 'failure', run_number: 2, updated_at: '2026-11-18T14:59:00Z',
  });
  const repeated = await notify(repeatedRun, initial, repository, send, { now: morning - 60_000 });
  assert.equal(messages.length, 2);
  assert.equal(repeated.last_alert_at, morning - 60_000);
  assert.equal(repeated.failing_since, initial.failing_since);
  const reminded = await notify(repeatedRun, repeated, repository, send, { now: morning, sweep: true });
  assert.equal(messages.length, 3);
  assert.equal(reminded.last_reminder_slot, morning);

  const recovered = transition(run({ run_number: 3 }), reminded, repository).state;
  assert.equal(recovered.failing, false);
  assert.equal(recovered.last_alert_at, undefined);
  assert.equal(recovered.failing_since, undefined);
  assert.equal(recovered.last_reminder_slot, undefined);
  const newFailure = run({
    conclusion: 'failure', run_number: 4, updated_at: '2026-11-18T15:30:00Z',
  });
  const next = transition(newFailure, recovered, repository, { now: morning + 30 * 60_000 });
  assert.equal(next.reason, 'failure');
  assert.equal(next.alert, true);
  assert.equal(next.state.failing_since, Date.parse(newFailure.updated_at));
  assert.equal(transition(newFailure, next.state, repository, {
    now: morning + 60 * 60_000, sweep: true,
  }).reason, 'not-due');
});

test('duplicate scheduled sweeps are suppressed and a failed reminder can be retried', async () => {
  const source = run({ conclusion: 'failure' });
  const previous = transition(source, undefined, repository, { now }).state;
  const snapshot = structuredClone(previous);
  const logs = [];
  const options = {
    now: morning, sweep: true, log: (line) => logs.push(JSON.parse(line)),
  };
  await assert.rejects(notify(source, previous, repository, async () => {
    throw new Error('delivery failed');
  }, options), /delivery failed/);
  assert.deepEqual(previous, snapshot);
  assert.equal(logs.at(-1).decision, 'delivery-failed');

  const messages = [];
  const send = async (text) => messages.push(text);
  const saved = await notify(source, previous, repository, send, options);
  const newFailure = run({ conclusion: 'failure', run_number: 2 });
  const afterFailure = await notify(newFailure, saved, repository, send, {
    ...options, sweep: false, now: morning + 1,
  });
  await notify(newFailure, afterFailure, repository, send, { ...options, now: morning + 60_000 });
  assert.equal(messages.length, 2);
  assert.equal(logs.at(-1).reason, 'not-due');
  assert.equal(afterFailure.last_reminder_slot, morning);
  assert.equal(transition(newFailure, afterFailure, repository, { now: morning + halfDayMs }).reason,
    'duplicate-or-older');
  assert.equal(transition(run({ run_number: 0 }), saved, repository, options).reason, 'duplicate-or-older');
});

test('legacy failing state is eligible at the next fixed slot without fabricating a sent timestamp', () => {
  const legacy = { version: 1, workflow_id: 1, run_number: 1, run_attempt: 1, failing: true };
  const source = run({ conclusion: 'failure' });
  const migrated = transition(source, legacy, repository, { now, sweep: true });
  assert.equal(migrated.alert, false);
  assert.equal(migrated.state.last_alert_at, undefined);
  assert.equal(migrated.state.failing_since, Date.parse(source.updated_at));
  assert.equal(legacy.failing_since, undefined);
  const due = transition(source, migrated.state, repository, { now: morning, sweep: true });
  assert.equal(due.reason, 'reminder');
  assert.equal(transition(source, legacy, repository, { now: morning, sweep: true }).reason, 'reminder');
  for (const fields of [
    { failing_since: 'invalid' },
    { failing_since: now, last_alert_at: 'invalid' },
    { failing_since: now, last_alert_at: now - 1 },
    { failing_since: now, last_reminder_slot: 'invalid' },
    { failing_since: now, last_reminder_slot: morning + 1 },
  ]) {
    assert.throws(() => transition(source, { ...legacy, ...fields }, repository, {
      now: morning, sweep: true,
    }), /Invalid saved/);
  }
  assert.throws(() => transition(run({ conclusion: 'failure', updated_at: 'invalid' }), undefined,
    repository, { now }), /timestamp/);
});

test('reminder boundaries stay at 03:00 UTC and 15:00 UTC year-round', () => {
  for (const at of [
    '2026-11-19T03:00:00Z', '2026-11-19T15:00:00Z',
    '2027-07-19T03:00:00Z', '2027-07-19T15:00:00Z',
  ]) {
    const time = Date.parse(at);
    const source = run({ conclusion: 'failure', updated_at: new Date(time - 60_000).toISOString() });
    const previous = transition(source, undefined, repository, { now: time - 60_000 }).state;
    assert.equal(transition(source, previous, repository, { now: time - 1, sweep: true }).alert, false, at);
    const due = transition(source, previous, repository, { now: time, sweep: true });
    assert.equal(due.alert, true, at);
    assert.equal(due.state.last_reminder_slot, time, at);
    assert.equal(transition(source, due.state, repository, {
      now: time + 10 * 60_000, sweep: true,
    }).alert, false, at);
    const delayed = transition(source, previous, repository, { now: time + 10 * 60_000, sweep: true });
    assert.equal(delayed.alert, true, at);
    assert.equal(delayed.state.last_reminder_slot, time, at);
  }
});

    test('sweeps select the newest eligible result across source events and ignored completions', async () => {
      const calls = [];
      const latest = await notifier.latestRun(1, repository, async (path) => {
        calls.push(path);
        if (path.includes('event=push')) {
          if (path.endsWith('page=1')) return Response.json({
            workflow_runs: Array.from({ length: 100 }, () => run({ conclusion: 'cancelled' })),
          });
          return Response.json({ workflow_runs: [
            run({ run_number: 9, conclusion: 'cancelled' }), run({ run_number: 4, conclusion: 'failure' }),
          ] });
        }
        if (path.includes('event=schedule')) {
          return Response.json({ workflow_runs: [run({ run_number: 5, event: 'schedule' })] });
        }
        return Response.json({ workflow_runs: [run({
          run_number: 99, event: 'pull_request', conclusion: 'failure',
        })] });
      }, config);
      assert.equal(latest.run_number, 5);
      assert.equal(latest.conclusion, 'success');
      assert.equal(calls.length, 4);
    });

    test('scheduled discovery queues failures and recovery while excluding healthy and notifier workflows', async () => {
      const workflows = [
        { id: 1, name: 'Tier 1A', path: run().path, state: 'active' },
        { id: 2, name: 'Tier 1B', path: '.github/workflows/tier-1b.yml', state: 'active' },
        { id: 3, name: 'Tier 2', path: '.github/workflows/tier-2.yml', state: 'active' },
        { id: 4, name: 'Main CI Slack alerts', path: config.callerPath, state: 'active' },
        { id: 5, name: 'Disabled', path: '.github/workflows/disabled.yml', state: 'disabled_manually' },
      ];
      const legacy = { version: 1, workflow_id: 3, run_number: 1, run_attempt: 1, failing: true };
      const directory = mkdtempSync(join(tmpdir(), 'ci-slack-discover-'));
      const previousTemp = process.env.RUNNER_TEMP;
      process.env.RUNNER_TEMP = directory;
      try {
        writeFileSync(join(directory, 'ci-slack-state.json'), JSON.stringify(legacy));
        execFileSync('zip', ['-j', join(directory, 'fixture.zip'), join(directory, 'ci-slack-state.json')]);
        const ids = await notifier.discover(repository, async (path) => {
          if (path.startsWith('/actions/workflows?')) return Response.json({ workflows });
          if (path.includes('/runs?')) {
            const id = Number(path.match(/workflows\/(\d+)/)[1]);
            assert.ok(id <= 3);
            return Response.json({ workflow_runs: path.includes('event=push') ? [run({
              workflow_id: id, name: workflows[id - 1].name, run_number: 2,
              conclusion: id === 1 ? 'failure' : 'success',
            })] : [] });
          }
          if (path.includes('/actions/artifacts?')) {
            return Response.json({ artifacts: path.includes('state-3&') ? [{
              id: 3, name: 'ci-slack-state-3', workflow_run: { id: 10, head_branch: 'main' },
            }] : [] });
          }
          if (path === '/actions/runs/10') return Response.json({
            path: config.callerPath, event: 'schedule', head_branch: 'main',
            head_repository: { full_name: repository },
          });
          assert.equal(path, '/actions/artifacts/3/zip');
          return new Response(readFileSync(join(directory, 'fixture.zip')));
        }, { ...config, workflowNames: ['*'] }, now);
        assert.deepEqual(ids, [1, 3]);
      } finally {
        if (previousTemp === undefined) delete process.env.RUNNER_TEMP;
        else process.env.RUNNER_TEMP = previousTemp;
        rmSync(directory, { recursive: true });
      }
    });

    test('scheduled entry point discovers due reminders, reloads state, and notices recovery before sending', () => {
      const directory = mkdtempSync(join(tmpdir(), 'ci-slack-sweep-'));
      try {
        const source = run({ conclusion: 'failure' });
        const outputPath = join(directory, 'output');
        const statePath = join(directory, 'ci-slack-state.json');
        const zipPath = join(directory, 'fixture.zip');
        writeFileSync(statePath, JSON.stringify(transition(source, undefined, repository, { now }).state));
        const archive = () => {
          execFileSync('zip', ['-j', zipPath, statePath]);
          return readFileSync(zipPath).toString('base64');
        };
        const execute = (discovery, current = source) => {
          const mock = `
            Date.now = () => ${morning};
            const source = ${JSON.stringify(current)};
            globalThis.fetch = async (url, options) => {
              const path = String(url);
              if (path.startsWith('https://hooks.slack.com/')) {
                if (${discovery}) throw new Error('Discovery must not send Slack messages');
                if (!JSON.parse(options.body).text.includes('still failing')) throw new Error('Not a reminder');
                console.log('MOCK_REMINDER_DELIVERY');
                return new Response('ok');
              }
              if (path.includes('/actions/workflows?')) return Response.json({ workflows: [{
                id: 1, name: source.name, path: source.path, state: 'active',
              }] });
              if (path.includes('/actions/workflows/1/runs?')) return Response.json({
                workflow_runs: path.includes('event=push') ? [source] : [],
              });
              if (path.includes('/actions/artifacts?')) return Response.json({ artifacts: [{
                id: 7, name: 'ci-slack-state-1', workflow_run: { id: 10, head_branch: 'main' },
              }] });
              if (path.endsWith('/actions/runs/10')) return Response.json({
                path: ${JSON.stringify(config.callerPath)}, event: 'schedule', head_branch: 'main',
                head_repository: { full_name: ${JSON.stringify(repository)} },
              });
              if (path.endsWith('/actions/artifacts/7/zip')) {
                return new Response(Buffer.from('${archive()}', 'base64'));
              }
              throw new Error('Unexpected request: ' + path);
            };
          `;
          const result = executeNotifier({
            cwd: directory,
            env: {
              ...process.env, RUNNER_TEMP: directory,
              GH_TOKEN: 'test-token', GITHUB_API_URL: 'https://api.github.com',
              GITHUB_REPOSITORY: repository, GITHUB_EVENT_NAME: 'schedule',
              GITHUB_REF: 'refs/heads/main', GITHUB_OUTPUT: outputPath,
              SLACK_WEBHOOK_URL: discovery ? '' : 'https://hooks.slack.com/services/mock',
              CI_SLACK_DISCOVER: String(discovery), CI_SLACK_WORKFLOW_ID: '1',
              CI_SLACK_WORKFLOWS: JSON.stringify(config.workflowNames),
              CI_SLACK_BRANCH: config.branch, CI_SLACK_CALLER_PATH: config.callerPath,
              CI_SLACK_TEST_DELIVERY: 'false',
            },
            encoding: 'utf8',
          }, mock);
          assert.equal(result.status, 0, result.stderr);
          return result;
        };

        execute(true);
        assert.equal(readFileSync(outputPath, 'utf8'), 'workflow-ids=[1]\n');
        rmSync(outputPath);
        const reminder = execute(false);
        assert.match(reminder.stdout, /MOCK_REMINDER_DELIVERY/);
        assert.match(reminder.stdout, /"decision":"sent","reason":"reminder"/);
        assert.equal(JSON.parse(readFileSync(statePath)).last_alert_at, morning);
        assert.equal(JSON.parse(readFileSync(statePath)).last_reminder_slot, morning);
        assert.equal(readFileSync(outputPath, 'utf8'), 'save-state=true\n');

        const overlap = execute(false);
        assert.doesNotMatch(overlap.stdout, /MOCK_REMINDER_DELIVERY/);
        assert.match(overlap.stdout, /"decision":"suppressed","reason":"not-due"/);
        rmSync(outputPath);
        execute(true);
        assert.equal(readFileSync(outputPath, 'utf8'), 'workflow-ids=[]\n');

        const recovered = execute(false, run({ run_number: 2 }));
        assert.doesNotMatch(recovered.stdout, /MOCK_REMINDER_DELIVERY/);
        assert.match(recovered.stdout, /"reason":"recovered"/);
        assert.equal(JSON.parse(readFileSync(statePath)).failing, false);
      } finally {
        rmSync(directory, { recursive: true });
      }
    });
