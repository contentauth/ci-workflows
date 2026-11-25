import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/ci-slack.yml', import.meta.url), 'utf8');
const bootstrap = workflow.match(/run: &load-notifier \|\n((?: {10}.*\n)+)/)[1]
  .replace(/^ {10}/gm, '');
const sha = 'a'.repeat(40);
const workflowPath = 'contentauth/ci-workflows/.github/workflows/ci-slack.yml';
const reference = { path: `${workflowPath}@refs/heads/feature`, sha };

function loadNotifier(references, { apiFailure = false, downloadFailure = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'ci-slack-loader-'));
  try {
    writeFileSync(join(directory, 'gh'), `#!${process.execPath}
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      assert.deepEqual(process.argv.slice(2, 5), [
        'api', 'repos/contentauth/example/actions/runs/42/attempts/2', '--jq',
      ]);
      if (${apiFailure}) {
        console.error('GitHub API request failed (HTTP 403)');
        process.exit(1);
      }
      const result = spawnSync('jq', ['-r', process.argv[5]], {
        input: ${JSON.stringify(JSON.stringify({ referenced_workflows: references }))},
        encoding: 'utf8',
      });
      process.stdout.write(result.stdout);
      process.stderr.write(result.stderr);
      process.exit(result.status);
    `, { mode: 0o755 });
    writeFileSync(join(directory, 'curl'), `#!${process.execPath}
      import { writeFileSync } from 'node:fs';
      const args = process.argv.slice(2);
      writeFileSync(${JSON.stringify(join(directory, 'download.json'))}, JSON.stringify(args));
      if (${downloadFailure}) {
        console.error('curl: HTTP 404');
        process.exit(22);
      }
      writeFileSync(args[args.indexOf('--output') + 1], '// downloaded notifier\\n');
    `, { mode: 0o755 });
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', bootstrap], {
      env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`,
        RUNNER_TEMP: directory, GITHUB_REPOSITORY: 'contentauth/example',
        GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '2', GITHUB_WORKFLOW_SHA: 'b'.repeat(40),
      },
      encoding: 'utf8',
    });
    return {
      ...result,
      download: existsSync(join(directory, 'download.json'))
        ? JSON.parse(readFileSync(join(directory, 'download.json'))) : undefined,
      script: existsSync(join(directory, 'ci-slack.mjs'))
        ? readFileSync(join(directory, 'ci-slack.mjs'), 'utf8') : undefined,
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test('script loading uses the called workflow SHA for this attempt, not the caller or a branch', () => {
  const result = loadNotifier([
    { path: 'contentauth/example/.github/workflows/caller.yml@main', sha: 'b'.repeat(40) },
    reference,
    reference,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.download.slice(0, -1), [
    '--fail', '--silent', '--show-error', '--proto', '=https', '--max-time', '60',
    `https://raw.githubusercontent.com/contentauth/ci-workflows/${sha}/scripts/ci-slack.mjs`,
    '--output',
  ]);
  assert.equal(result.script, '// downloaded notifier\n');
});

test('missing, foreign, ambiguous, and invalid workflow revisions fail without downloading code', () => {
  for (const references of [
    [],
    [{ path: `someone/ci-workflows/.github/workflows/ci-slack.yml@main`, sha }],
    [reference, { ...reference, sha: 'c'.repeat(40) }],
    [{ ...reference, sha: 'main' }],
  ]) {
    const result = loadNotifier(references);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Cannot identify|Invalid called/);
    assert.equal(result.download, undefined);
    assert.equal(result.script, undefined);
  }
});

test('metadata and script download failures fail explicitly', () => {
  const metadataFailure = loadNotifier([reference], { apiFailure: true });
  assert.equal(metadataFailure.status, 1);
  assert.match(metadataFailure.stderr, /HTTP 403/);
  assert.equal(metadataFailure.download, undefined);
  const downloadFailure = loadNotifier([reference], { downloadFailure: true });
  assert.equal(downloadFailure.status, 22);
  assert.match(downloadFailure.stderr, /HTTP 404/);
  assert.equal(downloadFailure.script, undefined);
});
