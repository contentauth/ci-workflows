import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const events = new Set(['push', 'schedule', 'workflow_dispatch']);
const failures = new Set(['failure', 'timed_out', 'startup_failure']);
const halfDayMs = 12 * 60 * 60 * 1000;

function reminderSlot(time) {
  // Daily reminder slots start at 03:00 UTC and 15:00 UTC.
  const offset = 3 * 60 * 60 * 1000;
  return Math.floor((time - offset) / halfDayMs) * halfDayMs + offset;
}

function nextReminder(state) {
  return Math.max(
    reminderSlot(state.failing_since) + halfDayMs,
    (state.last_reminder_slot ?? 0) + halfDayMs,
  );
}

export function configuration(env) {
  const workflowNames = JSON.parse(env.CI_SLACK_WORKFLOWS);
  if (!Array.isArray(workflowNames) || !workflowNames.length ||
      !workflowNames.every((name) => typeof name === 'string' && name.trim())) {
    throw new Error('workflow-names must be a nonempty JSON array of workflow names');
  }
  if (!env.CI_SLACK_BRANCH ||
      !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(env.CI_SLACK_CALLER_PATH)) {
    throw new Error('A branch and a valid caller-workflow-path are required');
  }
  return {
    branch: env.CI_SLACK_BRANCH,
    workflowNames,
    callerPath: env.CI_SLACK_CALLER_PATH,
  };
}

function eligible(run, repository, config) {
  return (config.workflowNames.includes('*') || config.workflowNames.includes(run.name)) &&
    run.path !== config.callerPath &&
    run.head_branch === config.branch &&
    run.head_repository?.full_name === repository &&
    events.has(run.event) && run.status === 'completed' &&
    (run.conclusion === 'success' || failures.has(run.conclusion));
}

export function transition(run, previous, repository, config, { now = Date.now(), sweep = false } = {}) {
  if (!eligible(run, repository, config)) {
    return { state: previous, alert: false, reason: 'ineligible' };
  }
  if (previous) {
    if (
      previous.version !== 1 ||
      previous.workflow_id !== run.workflow_id ||
      !Number.isSafeInteger(previous.run_number) ||
      !Number.isSafeInteger(previous.run_attempt) ||
      typeof previous.failing !== 'boolean' ||
      (previous.failing_since !== undefined &&
        (!previous.failing ||
          !Number.isSafeInteger(previous.failing_since) || previous.failing_since < 0)) ||
      (previous.last_alert_at !== undefined &&
        (previous.failing_since === undefined ||
          !Number.isSafeInteger(previous.last_alert_at) ||
          previous.last_alert_at < previous.failing_since)) ||
      (previous.last_reminder_slot !== undefined &&
        (previous.last_alert_at === undefined ||
          !Number.isSafeInteger(previous.last_reminder_slot) ||
          previous.last_reminder_slot < previous.failing_since ||
          previous.last_reminder_slot > previous.last_alert_at ||
          previous.last_reminder_slot !== reminderSlot(previous.last_reminder_slot)))
    ) {
      throw new Error('Invalid saved Slack alert state');
    }
    if (
      run.run_number < previous.run_number ||
      (run.run_number === previous.run_number &&
        (run.run_attempt < previous.run_attempt ||
          (run.run_attempt === previous.run_attempt && !sweep)))
    ) {
      return { state: previous, alert: false, reason: 'duplicate-or-older' };
    }
  }
  const failing = failures.has(run.conclusion);
  const state = {
    version: 1,
    workflow_id: run.workflow_id,
    run_number: run.run_number,
    run_attempt: run.run_attempt,
    failing,
  };
  if (failing) {
    const since = previous?.failing ? previous.failing_since : undefined;
    state.failing_since = since ?? Date.parse(run.updated_at);
    if (!Number.isSafeInteger(state.failing_since) || state.failing_since < 0) {
      throw new Error('Invalid workflow result timestamp');
    }
    if (previous?.failing) {
      if (previous.last_alert_at !== undefined) state.last_alert_at = previous.last_alert_at;
      if (previous.last_reminder_slot !== undefined) state.last_reminder_slot = previous.last_reminder_slot;
    }
  }
  const newResult = !previous || run.run_number > previous.run_number ||
    run.run_attempt > previous.run_attempt;
  const reason = failing ? (newResult ? 'failure' :
    sweep && now >= nextReminder(state) ? 'reminder' : 'not-due') :
    previous?.failing ? 'recovered' : 'healthy';
  const alert = reason === 'failure' || reason === 'reminder';
  if (alert) {
    state.last_alert_at = now;
    if (reason === 'reminder') state.last_reminder_slot = reminderSlot(now);
  }
  return {
    state,
    alert,
    reason,
  };
}

export async function postSlack(webhook, text, fetcher = fetch) {
  if (!webhook) throw new Error('SLACK_WEBHOOK_URL is not configured');
  const url = new URL(webhook);
  if (
    url.protocol !== 'https:' ||
    !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname)
  ) {
    throw new Error('SLACK_WEBHOOK_URL must be a Slack HTTPS incoming webhook');
  }
  let response;
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
  } catch {
    // Network errors may contain the secret webhook URL.
    throw new Error('Slack webhook request failed; check connectivity and webhook configuration');
  }
  if (!response.ok || (await response.text()).trim() !== 'ok') {
    throw new Error(`Slack rejected the notification (HTTP ${response.status})`);
  }
}

function logDecision(decision, reason, run, state, now, log = console.log) {
  log(JSON.stringify({
    decision, reason, workflow: run.name, workflow_id: run.workflow_id,
    run_number: run.run_number, run_attempt: run.run_attempt, run_url: run.html_url,
    ...(state?.failing_since !== undefined ? {
      failing_since: new Date(state.failing_since).toISOString(),
      next_reminder_due: new Date(nextReminder(state)).toISOString(),
      seconds_until_reminder: Math.max(0, Math.ceil((nextReminder(state) - now) / 1000)),
    } : {}),
  }));
}

export async function notify(run, previous, repository, send, config, options = {}) {
  const now = options.now ?? Date.now();
  const result = transition(run, previous, repository, config, { ...options, now });
  if (result.alert) {
    const reminder = result.reason === 'reminder';
    const duration = ((now - result.state.failing_since) / (60 * 60 * 1000)).toFixed(1);
    try {
      await send(
        `${repository}: ${run.name} is ${reminder ? 'still ' : ''}failing on ${config.branch} (${run.conclusion}).\n` +
        (reminder ? `Known failing since: ${new Date(result.state.failing_since).toISOString()} (${duration} hours).\n` +
          `Last completed result: ${new Date(run.updated_at).toISOString()}.\n` : '') +
        `Commit: ${run.head_sha.slice(0, 12)}\n${run.html_url}`,
      );
    } catch (error) {
      logDecision('delivery-failed', result.reason, run, previous, now, options.log);
      throw error;
    }
  }
  logDecision(result.alert ? 'sent' : 'suppressed', result.reason, run, result.state, now, options.log);
  return result.state;
}

export async function github(path, token, fetcher = fetch) {
  if (!token) throw new Error('GH_TOKEN is not configured');
  const response = await fetcher(`${process.env.GITHUB_API_URL}/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API request failed (HTTP ${response.status})`);
  return response;
}

function readArtifactState(buffer) {
  const zipPath = `${process.env.RUNNER_TEMP}/ci-slack-state.zip`;
  writeFileSync(zipPath, Buffer.from(buffer));
  return JSON.parse(execFileSync('unzip', ['-p', zipPath, 'ci-slack-state.json'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }));
}

export async function loadState(workflowId, repository, request, config, readArtifact = readArtifactState) {
  const name = `ci-slack-state-${workflowId}`;
  for (let page = 1; ; page++) {
    const response = await request(`/actions/artifacts?name=${name}&per_page=100&page=${page}`);
    const { artifacts } = await response.json();
    const candidates = artifacts.filter((artifact) =>
      artifact.name === name && !artifact.expired &&
      artifact.workflow_run?.head_branch === config.branch,
    );
    candidates.sort((a, b) => b.id - a.id);
    for (const candidate of candidates) {
      // Artifact names alone are not a trust boundary: PRs can upload them too.
      const source = await (await request(`/actions/runs/${candidate.workflow_run.id}`)).json();
      if (
        source.path !== config.callerPath ||
        !['workflow_run', 'schedule'].includes(source.event) ||
        source.head_branch !== config.branch ||
        source.head_repository?.full_name !== repository
      ) {
        console.log(`::warning::Ignoring alert state from an untrusted workflow run (${source.id}).`);
        continue;
      }
      const artifact = await request(`/actions/artifacts/${candidate.id}/zip`);
      return readArtifact(await artifact.arrayBuffer());
    }
    if (artifacts.length < 100) break;
  }
  console.log('::notice::No retained Slack state; the first observed failure will alert.');
  return undefined;
}

export async function latestRun(workflowId, repository, request, config) {
  let latest;
  for (const event of events) {
    for (let page = 1; ; page++) {
      const { workflow_runs: runs } = await (await request(
        `/actions/workflows/${workflowId}/runs?branch=${encodeURIComponent(config.branch)}` +
        `&event=${event}&status=completed&per_page=100&page=${page}`,
      )).json();
      const run = runs.find((candidate) => eligible(candidate, repository, config));
      if (run) {
        if (!latest || run.run_number > latest.run_number ||
            (run.run_number === latest.run_number && run.run_attempt > latest.run_attempt)) {
          latest = run;
        }
        break;
      }
      if (runs.length < 100) break;
    }
  }
  return latest;
}

export async function discover(repository, request, config, now = Date.now()) {
  const ids = [];
  const errors = [];
  for (let page = 1; ; page++) {
    const { workflows } = await (await request(`/actions/workflows?per_page=100&page=${page}`)).json();
    for (const workflow of workflows) {
      if (workflow.state !== 'active' || workflow.path === config.callerPath ||
          (!config.workflowNames.includes('*') && !config.workflowNames.includes(workflow.name))) continue;
      try {
        const run = await latestRun(workflow.id, repository, request, config);
        if (!run) {
          console.log(JSON.stringify({
            decision: 'suppressed', reason: 'no-eligible-result', workflow: workflow.name,
          }));
          continue;
        }
        const previous = await loadState(workflow.id, repository, request, config);
        const result = transition(run, previous, repository, config, { now, sweep: true });
        const shouldProcess = result.alert || (previous?.failing &&
          (!result.state.failing || previous.failing_since === undefined));
        if (shouldProcess) ids.push(workflow.id);
        logDecision(shouldProcess ? 'queued' : 'suppressed', result.reason, run, result.state, now);
      } catch (error) {
        const failure = { workflow: workflow.name, workflow_id: workflow.id, error: error.message };
        errors.push(failure);
        console.error(JSON.stringify({ decision: 'discovery-failed', ...failure }));
      }
    }
    if (workflows.length < 100) break;
  }
  return { workflowIds: ids, errors };
}

export async function main() {
  const config = configuration(process.env);
  const repository = process.env.GITHUB_REPOSITORY;
  const request = (path) => github(path, process.env.GH_TOKEN);
  const send = (text) => postSlack(process.env.SLACK_WEBHOOK_URL, text);
  const discovery = process.env.CI_SLACK_DISCOVER === 'true';
  const outputIds = (ids) => appendFileSync(
    process.env.GITHUB_OUTPUT, `workflow-ids=${JSON.stringify(ids)}\n`,
  );
  if (process.env.CI_SLACK_TEST_DELIVERY === 'true') {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
        process.env.GITHUB_REF !== `refs/heads/${config.branch}`) {
      throw new Error('Test delivery requires a manual dispatch on the configured branch');
    }
    if (discovery) outputIds(['test']);
    else {
      await send(`[TEST] ${repository}: CI Slack alerts for ${config.branch} are connected. This is not a CI failure.`);
      console.log(JSON.stringify({ decision: 'sent', reason: 'test-delivery' }));
    }
    return;
  }
  const sweep = process.env.GITHUB_EVENT_NAME === 'schedule';
  if (sweep && process.env.GITHUB_REF !== `refs/heads/${config.branch}`) {
    throw new Error('Reminder sweeps require the configured branch');
  }
  if (discovery && sweep) {
    const result = await discover(repository, request, config);
    outputIds(result.workflowIds);
    appendFileSync(process.env.GITHUB_OUTPUT, `discovery-errors=${result.errors.length}\n`);
    return;
  }
  let run;
  if (sweep) {
    const workflowId = Number(process.env.CI_SLACK_WORKFLOW_ID);
    if (!Number.isSafeInteger(workflowId) || workflowId <= 0) throw new Error('Invalid workflow ID');
    run = await latestRun(workflowId, repository, request, config);
  } else {
    if (process.env.GITHUB_EVENT_NAME !== 'workflow_run') {
      throw new Error('Notifications require a workflow_run or schedule event');
    }
    run = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).workflow_run;
  }
  if (!run || !eligible(run, repository, config)) {
    console.log(JSON.stringify({ decision: 'suppressed', reason: 'ineligible' }));
    if (discovery) outputIds([]);
    return;
  }
  if (discovery) {
    outputIds([run.workflow_id]);
    return;
  }
  const previous = await loadState(
    run.workflow_id, repository, request, config,
  );
  const state = await notify(run, previous, repository, send, config, { sweep });
  writeFileSync('ci-slack-state.json', `${JSON.stringify(state)}\n`);
  appendFileSync(process.env.GITHUB_OUTPUT, 'save-state=true\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
