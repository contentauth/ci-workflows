import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export * as notifier from '../scripts/ci-slack.mjs';

const script = fileURLToPath(new URL('../scripts/ci-slack.mjs', import.meta.url));

export function executeNotifier(options, mock) {
  const args = [];
  if (mock) {
    const preload = join(options.cwd, 'mock.mjs');
    writeFileSync(preload, mock);
    args.push('--import', preload);
  }
  return spawnSync(process.execPath, [...args, script], { ...options, encoding: 'utf8' });
}
