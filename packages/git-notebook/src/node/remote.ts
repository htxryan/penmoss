/**
 * A git remote read for what Penmoss shows and checks: its host, path and protocol, and the
 * remote as it may be shown, with any credentials in an HTTP URL hidden.
 */

export interface RemoteParts {
  /** `github.com`, `git.example.com`; '' for a local path. */
  readonly host: string;
  /** `owner/repo` on github.com, else the path. */
  readonly path: string;
  readonly protocol: 'https' | 'http' | 'ssh' | 'file';
  /** An HTTP(S) URL with a user name or password in it (`https://token@host/…`). */
  readonly credentials: boolean;
}

/** The host and path of an HTTPS, SSH (`ssh://` or `git@host:path`) or `file://` remote. */
export function remoteParts(remote: string): RemoteParts | null {
  const scp = /^([A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(remote);
  if (scp && !/^[A-Za-z]:\\/.test(remote)) {
    return {
      host: scp[2]!.toLowerCase(),
      path: clean(scp[3]!),
      protocol: 'ssh',
      credentials: false,
    };
  }
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    return null;
  }
  const protocol = url.protocol.replace(/:$/, '');
  if (protocol === 'file') {
    return { host: '', path: url.pathname, protocol: 'file', credentials: false };
  }
  if (protocol !== 'https' && protocol !== 'http' && protocol !== 'ssh') return null;
  return {
    host: url.hostname.toLowerCase(),
    path: clean(url.pathname),
    protocol,
    // ssh://git@host is how SSH names its user; HTTP credentials belong in `notebook token`.
    credentials: protocol !== 'ssh' && (url.username !== '' || url.password !== ''),
  };
}

/** A remote as it may be shown: an HTTP URL's user name and password replaced. */
export function redactRemote(remote: string): string {
  return remote.replace(/^(https?:\/\/)[^/@]*@/i, '$1***@');
}

function clean(path: string): string {
  return path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}
