// Runs a shell command in a slot's real Seatbelt sandbox on a throwaway branch of <sha>, as a
// factory run would, then closes it. For reproducing sandbox-only failures at the real path.
//   cd tools/factory && node ../.claude/skills/factory-foreman/scripts/sandbox.ts <slot> <sha> '<command>'
// The sandbox is made from the checkout this script lives in; the branch is left behind
// (factory/probe-*): delete it afterwards.
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../../../tools/factory/src/config.ts';
import {
  makeOwnDirs,
  sandboxSpec,
  seatbeltProvider,
} from '../../../../tools/factory/src/sandbox.ts';
const [slotId, sha, command] = process.argv.slice(2);
if (!slotId || !sha || !command) throw new Error('usage: sandbox.ts <slot> <sha> <command>');
const loaded = loadConfig();
if (!loaded.ok) throw new Error(loaded.error);
const slot = loaded.config.slots.find((s) => s.id === Number(slotId));
if (!slot) throw new Error(`no slot ${slotId}`);
const spec = sandboxSpec(loaded.config, slot, {});
makeOwnDirs(spec);
const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const { createSandbox } = await import(
  new URL(
    '../../../../tools/factory/node_modules/@ai-hero/sandcastle/dist/index.js',
    import.meta.url,
  ).href
);
const sandbox = await createSandbox({
  branch: `factory/probe-${Date.now().toString(36)}`,
  baseBranch: sha,
  cwd: repo,
  sandbox: await seatbeltProvider(spec),
});
try {
  const r = await sandbox.exec(command);
  console.log(r.stdout, '\n--- stderr\n', r.stderr, `\n--- exit ${r.exitCode}`);
} finally {
  await sandbox.close();
}
