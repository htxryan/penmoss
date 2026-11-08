/**
 * A git notebook's repository as a web page to open (Quanta feedback 3, item 12; A1128): its
 * host's page, at the notebook's branch and folder on GitHub. None for a repository on this Mac
 * (`file:` remotes, whose host is "this Mac").
 */
export function repositoryLink(info: {
  readonly repository: string;
  readonly host: string;
  readonly branch: string;
  readonly dir: string;
}): string | null {
  if (!info.host || info.host === 'this Mac' || !info.repository.startsWith(`${info.host}/`)) {
    return null;
  }
  const base = `https://${info.repository.replace(/\.git$/, '')}`;
  if (info.host !== 'github.com') return base;
  const path = [info.branch, ...info.dir.split('/').filter(Boolean)].map(encodeURIComponent);
  return `${base}/tree/${path.join('/')}`;
}
