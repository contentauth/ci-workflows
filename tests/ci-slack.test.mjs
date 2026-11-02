import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executable, notifier } from './notifier.mjs';

const config = {
  branch: 'main',
  workflowNames: ['Tier 1A', 'Tier 1B', 'Tier 2'],
  callerPath: '.github/workflows/main-ci-slack.yml',
};
const { github, postSlack } = notifier;
const transition = (...args) => notifier.transition(...args, config);
const notify = (...args) => notifier.notify(...args, config);
const loadState = (id, repository, request, readArtifact) =>
  notifier.loadState(id, repository, request, config, readArtifact);

const repository = 'contentauth/c2pa-rs';
function run(overrides = {}) {
  return {
    name: 'Tier 1A',
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
    ...overrides,
  };
}

test('pass -> fail -> fail -> pass -> fail sends only newly failing alerts', () => {
  let previous;
  const alerts = ['success', 'failure', 'failure', 'success', 'failure'].map((conclusion, i) => {
    const result = transition(run({ conclusion, run_number: i + 1 }), previous, repository);
    previous = result.state;
    return result.alert;
  });
  assert.deepEqual(alerts, [false, true, false, false, true]);
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
      { state: previous, alert: false },
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

test('wildcard monitors arbitrary workflow names and preserves transition-only alerts', () => {
  const all = { ...config, workflowNames: ['*'] };
  for (const name of ['Release', 'Update schemas', 'New workflow', 'Experimental features (non-blocking)']) {
    let previous;
    const alerts = ['success', 'failure', 'failure', 'success', 'failure'].map((conclusion, i) => {
      const result = notifier.transition(run({ name, conclusion, run_number: i + 1 }), previous, repository, all);
      previous = result.state;
      return result.alert;
    });
    assert.deepEqual(alerts, [false, true, false, false, true], name);
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
      { state: previous, alert: false },
    );
  }
});

test('explicit workflow lists also exclude notifier itself by path, regardless of name', () => {
  const result = transition(run({
    name: 'Tier 1A', path: config.callerPath, event: 'workflow_dispatch', conclusion: 'failure',
  }), undefined, repository);
  assert.deepEqual(result, { state: undefined, alert: false });
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
      { state: previous, alert: false },
    );
  }
});

test('rerunning a failure suppresses alerts; successful reruns re-arm alerts', () => {
  const first = transition(run({ conclusion: 'failure' }), undefined, repository);
  const second = transition(run({ conclusion: 'failure', run_attempt: 2 }), first.state, repository);
  assert.equal(second.alert, false);
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
  const result = spawnSync(process.execPath, [
    '--input-type=module',
  ], {
    input: executable,
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
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: executable,
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
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: `${mock}\n${executable}`,
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
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MOCK_SLACK_DELIVERY/);
    assert.deepEqual(JSON.parse(readFileSync(join(directory, 'ci-slack-state.json'))), {
      version: 1, workflow_id: 1, run_number: 1, run_attempt: 1, failing: true,
    });
    assert.equal(readFileSync(outputPath, 'utf8'), 'save-state=true\n');
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('manual test posts a labeled message without writing state or step output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ci-slack-manual-'));
  try {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: `
        globalThis.fetch = async (_url, options) => {
          const text = JSON.parse(options.body).text;
          if (!text.startsWith('[TEST] contentauth/c2pa-rs:')) throw new Error('Not labeled');
          console.log('MOCK_TEST_DELIVERY');
          return new Response('ok');
        };
        ${executable}
      `,
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
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /MOCK_TEST_DELIVERY/);
    assert.throws(() => readFileSync(join(directory, 'ci-slack-state.json')), { code: 'ENOENT' });
    assert.throws(() => readFileSync(join(directory, 'output')), { code: 'ENOENT' });
  } finally {
    rmSync(directory, { recursive: true });
  }
});
