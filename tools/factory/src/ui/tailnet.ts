/**
 * The tailnet names the Factory UI is served on (A1246): what `tailscale serve` proxies to the
 * UI's own port, as `host:port`. Only what Ryan has set up himself with `tailscale serve`
 * (`task factory:ui:tailnet`) counts, and only on his tailnet: `tailscale funnel` would make it
 * public, so a funnelled name is refused.
 */
import type { Exec } from '../exec.ts';

interface ServeStatus {
  readonly Web?: Record<
    string,
    { readonly Handlers?: Record<string, { readonly Proxy?: string }> }
  >;
  readonly AllowFunnel?: Record<string, boolean>;
}

/** The served names whose root proxies to this UI, from `tailscale serve status --json`. */
export function servedHosts(json: string, port: number): string[] {
  let status: ServeStatus;
  try {
    status = JSON.parse(json) as ServeStatus;
  } catch {
    return [];
  }
  const targets = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  return Object.entries(status.Web ?? {})
    .filter(([host, web]) => {
      const proxy = web.Handlers?.['/']?.Proxy?.replace(/\/+$/, '');
      return proxy !== undefined && targets.has(proxy) && status.AllowFunnel?.[host] !== true;
    })
    .map(([host]) => host);
}

/** Asks Tailscale; no Tailscale, or nothing served, is no tailnet name. */
export async function tailnetHosts(exec: Exec, port: number): Promise<string[]> {
  try {
    const r = await exec('tailscale', ['serve', 'status', '--json']);
    return r.code === 0 ? servedHosts(r.stdout, port) : [];
  } catch {
    return [];
  }
}

/** The link to open on another of Ryan's devices: HTTPS, without `:443`. */
export const tailnetLink = (host: string, token: string): string =>
  `https://${host.replace(/:443$/, '')}/?token=${token}`;
