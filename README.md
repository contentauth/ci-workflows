# Contentauth CI workflows

Reusable GitHub Actions workflows for Content Authenticity Initiative repositories.

## Slack alerts and failure reminders

The reusable [CI Slack workflow](.github/workflows/ci-slack.yml) alerts on every
new failed run or rerun of a monitored workflow, even if it is already failing.
It also reminds at **03:00 UTC and 15:00 UTC** while failures persist.
Each workflow is tracked independently. Successful runs silently stop reminders;
there are no recovery messages. Timeouts and startup failures count as failures.
Cancelled, skipped, neutral, pull-request, fork, and unrelated-branch results are
ignored. Pushes, schedules, and manual source runs are supported.
Reminders identify the last completed result and the known failure duration; they
do not rerun CI or imply that a fresh build has failed.

### Setup

1. Create a Slack incoming webhook for the destination channel.
2. Save it as the organization Actions secret `SLACK_WEBHOOK_URL`, granting access
   only to participating repositories. Never commit or log the webhook URL.
   A repository secret of the same name overrides the organization secret.
3. Add a wrapper like this to each repository's default branch. Replace
   `REVIEWED_COMMIT_SHA` with a full commit SHA from this repository:

```yaml
name: Main CI Slack alerts

on:
  workflow_run:
    workflows: ['*']
    types: [completed]
    branches: [main]
  workflow_dispatch:
  schedule:
    - cron: '0 3,15 * * *' # 03:00 UTC and 15:00 UTC.

permissions:
  actions: read

jobs:
  notify:
    uses: contentauth/ci-workflows/.github/workflows/ci-slack.yml@REVIEWED_COMMIT_SHA
    with:
      branch: main
      workflow-names: '["*"]'
      caller-workflow-path: .github/workflows/main-ci-slack.yml
      test-delivery: ${{ github.event_name == 'workflow_dispatch' }}
    secrets:
      slack-webhook-url: ${{ secrets.SLACK_WEBHOOK_URL }}
```

Use `["*"]` to monitor all workflows, including future additions. The notifier
excludes its own caller workflow by path. For selected workflows, replace both
lists with their exact `name` values, such as `[Tier 1A, Tier 1B, Tier 2]` in the
trigger and `'["Tier 1A", "Tier 1B", "Tier 2"]'` in `workflow-names`.
Change both branch settings together. `caller-workflow-path` must match the
wrapper's actual path. GitHub requires the wrapper on the default branch for
`workflow_run` delivery.

The schedule checks for due reminders even when CI runs only nightly.
Reminders use 03:00 UTC and 15:00 UTC year-round. GitHub schedules are best-effort
and may run late. Each reminder slot is sent at most once after successful state persistence;
repeated or delayed executions do not replay every missed slot. New failure
alerts do not postpone the fixed-time reminders. A failure immediately before a
scheduled reminder can therefore produce both messages close together.

All-workflow coverage still accepts only push, schedule, and manual source runs.
It checks overall workflow conclusions, not individual jobs. A failed job with
`continue-on-error` may leave the workflow successful and will not produce an alert.

Run the wrapper manually on the configured branch to send a labeled test message
without changing alert state. This is a real Slack post, not a dry run.

### Security and operational behavior

- The implementation is inline in the called workflow, so the caller's SHA pin
  covers all privileged code. No caller or triggering-run code is checked out.
- Only `actions: read` is needed. The caller's GitHub token reads run metadata and
  prior artifacts; uploading state uses the job's artifact runtime credentials.
- Workflow changes in participating repositories can access the shared webhook.
  Protect those branches and review changes to their workflows. The webhook
  grants posting access to its Slack channel, not channel-history access.
- Messages include the repository, workflow name, result, commit SHA, and
  source-run link, plus failure age and last-result time for reminders. Link and
  media unfurling are disabled.
- Per-workflow state artifacts live in the **calling repository**, with 90-day
  retention refreshed on each processed result. Expired or deleted state means
  the next observed failure alerts again. Use one wrapper per monitored workflow
  and branch; changing the wrapper path or branch resets its trusted state.
- State is accepted only from the configured wrapper's `workflow_run` or scheduled executions
  on the configured branch in the same repository.
- Rerun attempts are tracked. Duplicate completion events and results from older
  run numbers are suppressed, so stale results cannot overwrite newer health.
- Notifications are serialized per wrapper, branch, and workflow, using GitHub's
  `queue: max` (up to 100 pending jobs). Completion events and reminder sweeps use
  the same lock and reload state inside it. Queue overflow cancels excess jobs.
- Sweeps inspect the latest eligible completed result across push, schedule, and
  manual runs. Discovery queues only notifications, recoveries, and state
  upgrades; healthy workflows do not each consume a notification runner.
- Each decision logs `sent`, `suppressed`, `queued`, or `delivery-failed`, its reason,
  and relevant workflow/run metadata. Failing state includes the next reminder
  due time and seconds until that slot. No webhook URLs or tokens are logged.
- Slack or GitHub API errors fail visibly. Failed Slack delivery does not advance
  state; rerun the failed notifier after fixing the problem. Slack delivery and
  state upload are not atomic: if upload fails after Slack accepts the message,
  a retry can send a duplicate. There are no automatic webhook retries.

### Upgrading existing callers

Publish and review the shared workflow change, then update each caller's full SHA
pin and add the twice-daily schedule shown above. A schedule alone does not enable
reminders with an older pin. Callers without a schedule send failure alerts but
not reminders.

Existing version-1 artifacts remain readable; timestamps are additive.
For an already-failing workflow without timestamps, the latest completed failure
provides a conservative known-failing-since timestamp, since the original failure
time was not stored. It can receive a reminder at the next scheduled slot.
Failure alerts and reminders track their delivery times independently, so each
new failure alerts without resetting the reminder schedule. Healthy state and
existing per-workflow artifact names are unchanged.

Rolling back the caller's SHA pin restores transition-only alerts. Older readers
ignore scheduled artifacts and the extra fields in completion-event artifacts;
no artifacts need to be deleted. In-flight runs using the older pin cannot
coordinate reminder timestamps, so let them finish before changing pins.

## Development

No package installation is required. With Node.js 22+ and `zip`/`unzip`:

```sh
node --test tests/*.test.mjs
```

Tests load the actual inline implementation, mock all network requests, and
exercise archive extraction. The test workflow runs these on pushes and PRs.
Use `actionlint .github/workflows/*.yml` for workflow validation. If your
actionlint version predates GitHub's `queue: max`, exclude only that diagnostic:

```sh
actionlint -ignore 'unexpected key "queue" for "concurrency" section' .github/workflows/*.yml
```
