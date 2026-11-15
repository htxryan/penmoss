/**
 * The real host name behind an SSH remote's host (A1565), for the notebook's page on the web: a
 * remote such as `git@github-quanta:owner/repo` names a `Host github-quanta` in `~/.ssh/config`,
 * whose `HostName github.com` is where the repository is. `ssh -G <host>` prints the
 * configuration SSH would use for it, `hostname` among it, and connects to nothing: no key is
 * read and nothing reaches the network.
 */
import { boundedExec, type BoundedResult } from './bounded-exec';

/** How long `ssh -G` may take. */
const TIMEOUT_MS = 3000;

/** A host SSH could be asked about: never one that `ssh` would read as an option. */
const HOST = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,252}$/;

/** The `hostname` line of `ssh -G`'s output, lower case; null when there is none. */
export function sshHostName(output: string): string | null {
  for (const line of output.split('\n')) {
    const match = /^hostname\s+(\S+)\s*$/i.exec(line.trim());
    if (match && HOST.test(match[1]!)) return match[1]!.toLowerCase();
  }
  return null;
}

export type RunSsh = (args: readonly string[]) => Promise<BoundedResult>;

const runSsh: RunSsh = (args) =>
  boundedExec({ command: 'ssh', args, timeoutMs: TIMEOUT_MS, env: process.env });

/**
 * Resolves an SSH host to its `HostName`, each host once a launch: the host itself when SSH
 * names no other, when it can't be asked, or when the host is not one to ask about.
 */
export function sshHostResolver(run: RunSsh = runSsh): (host: string) => Promise<string> {
  const known = new Map<string, Promise<string>>();
  return (host) => {
    const key = host.toLowerCase();
    if (!HOST.test(key)) return Promise.resolve(key);
    let answer = known.get(key);
    if (!answer) {
      answer = run(['-G', key]).then(
        (result) =>
          (result.kind === 'exit' && result.code === 0 ? sshHostName(result.stdout) : null) ?? key,
        () => key,
      );
      known.set(key, answer);
    }
    return answer;
  };
}
