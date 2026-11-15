/**
 * Clones over system git for the transport's tests (`node-transport.test.ts`, `node-sync.test.ts`):
 * temporary sandboxes removed after each test, a `NodeGitTransport` in one, and a device (an
 * engine on a clone, its state on disk).
 */
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { GitNotebookEngine, MemorySecrets, NotebookOps } from '../../src';
import { FileStorage } from '../../src/node/storage';
import { NodeGitTransport } from '../../src/node/transport';
import { ISOLATED, sandbox, type Sandbox } from './git';

export const NOTEBOOK = { id: '01JBNOTEBOOK00000000000001', name: 'Work' };

let boxes: Sandbox[] = [];
afterEach(() => {
  for (const box of boxes) box.cleanup();
  boxes = [];
});

/** A sandbox removed after the test. */
export function box(): Sandbox {
  const made = sandbox();
  boxes.push(made);
  return made;
}

export async function transport(
  dir: string,
  remote: string,
  options: {
    root?: string;
    branch?: string;
    token?: string | null;
    name?: string;
    env?: Readonly<Record<string, string>>;
    sign?: boolean;
    signTimeoutMs?: number;
  } = {},
): Promise<NodeGitTransport> {
  const t = new NodeGitTransport({
    gitDir: join(dir, `clone-${options.name ?? 'a'}.git`),
    remote,
    branch: options.branch ?? 'main',
    root: options.root ?? '',
    author: { name: `Penmoss ${options.name ?? 'a'}`, email: 'penmoss@example.invalid' },
    ...(options.token !== undefined ? { token: () => Promise.resolve(options.token ?? null) } : {}),
    ...(options.sign !== undefined ? { sign: options.sign } : {}),
    ...(options.signTimeoutMs !== undefined ? { signTimeoutMs: options.signTimeoutMs } : {}),
    env: { ...ISOLATED, ...options.env },
  });
  await t.init();
  return t;
}

export async function device(
  sb: Sandbox,
  url: string,
  name: string,
  extra: { root?: string; create?: boolean; token?: string } = {},
) {
  const t = await transport(sb.dir, url, {
    name,
    ...(extra.root ? { root: extra.root } : {}),
    ...(extra.token ? { token: extra.token } : {}),
  });
  const storage = new FileStorage(join(sb.dir, `state-${name}`));
  const secrets = new MemorySecrets();
  const engine = await GitNotebookEngine.open({
    transport: t,
    storage,
    secrets,
    writer: { kind: 'device', label: name },
    ...(extra.create ? { create: NOTEBOOK } : {}),
  });
  return { transport: t, storage, secrets, engine, ops: new NotebookOps(engine) };
}
