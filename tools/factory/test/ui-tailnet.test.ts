import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { allowed } from '../src/ui/server.ts';
import { servedHosts, tailnetHosts, tailnetLink } from '../src/ui/tailnet.ts';

const TOKEN = 'secret';
const NAME = 'mac.tail0.ts.net';

const req = (host: string, origin?: string, url = `/?token=${TOKEN}`) =>
  ({ headers: { host, ...(origin ? { origin } : {}) }, url }) as unknown as IncomingMessage;

const status = (web: Record<string, string>, funnel: Record<string, boolean> = {}) =>
  JSON.stringify({
    TCP: {},
    Web: Object.fromEntries(
      Object.entries(web).map(([host, proxy]) => [host, { Handlers: { '/': { Proxy: proxy } } }]),
    ),
    AllowFunnel: funnel,
  });

describe('the tailnet names serving the UI (A1246)', () => {
  it('finds the names that proxy to the UI port, and only those', () => {
    const json = status({
      [`${NAME}:8443`]: 'http://127.0.0.1:7878',
      [`${NAME}:443`]: 'http://127.0.0.1:49374',
      [`${NAME}:10000`]: 'http://localhost:7878/',
    });
    expect(servedHosts(json, 7878)).toEqual([`${NAME}:8443`, `${NAME}:10000`]);
  });

  it('refuses a funnelled name: that would be public', () => {
    const json = status({ [`${NAME}:443`]: 'http://127.0.0.1:7878' }, { [`${NAME}:443`]: true });
    expect(servedHosts(json, 7878)).toEqual([]);
  });

  it('treats no Tailscale, a failure or bad JSON as no names', async () => {
    expect(servedHosts('not json', 7878)).toEqual([]);
    expect(servedHosts('{}', 7878)).toEqual([]);
    expect(await tailnetHosts(() => Promise.reject(new Error('ENOENT')), 7878)).toEqual([]);
    expect(
      await tailnetHosts(() => Promise.resolve({ code: 1, stdout: '', stderr: 'x' }), 7878),
    ).toEqual([]);
  });

  it('links over HTTPS, without :443', () => {
    expect(tailnetLink(`${NAME}:8443`, 't')).toBe(`https://${NAME}:8443/?token=t`);
    expect(tailnetLink(`${NAME}:443`, 't')).toBe(`https://${NAME}/?token=t`);
  });
});

describe('requests through tailscale serve (A1246)', () => {
  const remote = [`${NAME}:8443`];

  it('refuses a tailnet Host the UI was not told about', () => {
    expect(allowed(req(`${NAME}:8443`), 7878, TOKEN)).toEqual({
      ok: false,
      why: 'unexpected Host',
    });
  });

  it('accepts a served Host and its https Origin, with the token', () => {
    expect(allowed(req(`${NAME}:8443`), 7878, TOKEN, remote)).toMatchObject({ ok: true });
    expect(allowed(req(`${NAME}:8443`, `https://${NAME}:8443`), 7878, TOKEN, remote)).toMatchObject(
      { ok: true },
    );
  });

  it('still needs the token', () => {
    expect(allowed(req(`${NAME}:8443`, undefined, '/'), 7878, TOKEN, remote)).toMatchObject({
      ok: false,
    });
  });

  it('refuses a plain-http or foreign Origin', () => {
    expect(allowed(req(`${NAME}:8443`, `http://${NAME}:8443`), 7878, TOKEN, remote)).toEqual({
      ok: false,
      why: 'foreign Origin',
    });
    expect(allowed(req(`${NAME}:8443`, 'https://evil.example'), 7878, TOKEN, remote)).toEqual({
      ok: false,
      why: 'foreign Origin',
    });
  });

  it('accepts the bare name for 443', () => {
    const r = [`${NAME}:443`];
    expect(allowed(req(NAME, `https://${NAME}`), 7878, TOKEN, r)).toMatchObject({ ok: true });
  });

  it('keeps accepting the local hosts', () => {
    expect(allowed(req('127.0.0.1:7878'), 7878, TOKEN, remote)).toMatchObject({ ok: true });
  });
});
