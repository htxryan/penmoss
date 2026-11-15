/** A repository's page on the web, and whether it is GitHub's (the button says so). */
export interface RepositoryLink {
  readonly url: string;
  readonly github: boolean;
}

/**
 * A git notebook's repository as a web page to open (Quanta feedback 3, item 12; A1128): its
 * host's page, at the notebook's branch and folder on GitHub. None for a repository on this Mac
 * (`file:` remotes, whose host is "this Mac").
 *
 * The page is on the host's real name (A1565): a remote through an SSH alias
 * (`git@github-quanta:owner/repo`, `Host github-quanta` in `~/.ssh/config`) names the alias, and
 * main resolves it to the `HostName` SSH uses (`webHost`, `github.com`).
 */
export function repositoryLink(info: {
  readonly repository: string;
  readonly host: string;
  /** The host's real name; absent: `host`. */
  readonly webHost?: string | undefined;
  readonly branch: string;
  readonly dir: string;
}): RepositoryLink | null {
  if (!info.host || info.host === 'this Mac' || !info.repository.startsWith(`${info.host}/`)) {
    return null;
  }
  const webHost = info.webHost || info.host;
  const path = info.repository.slice(info.host.length + 1).replace(/\.git$/, '');
  const base = `https://${webHost}/${path}`;
  if (webHost !== 'github.com') return { url: base, github: false };
  const tree = [info.branch, ...info.dir.split('/').filter(Boolean)].map(encodeURIComponent);
  return { url: `${base}/tree/${tree.join('/')}`, github: true };
}
