import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/ci-slack.yml', import.meta.url), 'utf8');
const start = "          node --input-type=module <<'NOTIFIER'\n";
const end = '          NOTIFIER\n';
if (!workflow.includes(start) || !workflow.includes(end)) {
  throw new Error('Cannot locate the inline notifier implementation');
}
export const executable = workflow.split(start)[1].split(end)[0]
  .split('\n').map((line) => line.replace(/^ {10}/, '')).join('\n');
const implementation = executable.split('// Tests import the implementation above')[0];
export const notifier = await import(`data:text/javascript;base64,${Buffer.from(implementation).toString('base64')}`);
