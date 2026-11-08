/**
 * Sign in with GitHub's device flow (T82, A1170, A1172): the poller against the scripted fake of
 * github.com's sign-in endpoints, with a fake clock and sleep, so no real time passes.
 */
import { describe, expect, it } from 'vitest';
import {
  DeviceSignIn,
  SIGN_IN_SCOPES,
  type SignInFetch,
  type SignInState,
} from '../../src/github-device-sign-in';
import { FakeGitHubBrowse } from '../../../../packages/git-notebook/test/support/fake-github-browse';

const WEB = 'https://github.test';
const TOKEN = 'gho_unit0device0token000000000000000';

function setup(
  options: {
    clientId?: string | null;
    fetch?: SignInFetch;
    kept?: boolean;
    web?: string;
    /** Waits until cancelled, so no poll ever happens. */
    hold?: boolean;
  } = {},
) {
  const fake = new FakeGitHubBrowse({
    token: TOKEN,
    login: 'ryan',
    base: 'https://api.github.test',
  });
  let now = 1_000_000;
  const slept: number[] = [];
  const opened: string[] = [];
  const kept: string[] = [];
  const states: SignInState[] = [];
  let settle: (state: SignInState) => void = () => undefined;
  const settled = new Promise<SignInState>((resolve) => (settle = resolve));
  const signIn = new DeviceSignIn({
    fetch:
      options.fetch ??
      ((url, init) =>
        fake.fetch(url, { method: init.method, headers: init.headers, body: init.body })),
    clientId: options.clientId === undefined ? fake.device.clientId : options.clientId,
    web: options.web ?? WEB,
    openExternal: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    keep: (token) => {
      kept.push(token);
      return Promise.resolve({ kept: options.kept ?? true, login: 'ryan' });
    },
    now: () => now,
    sleep: (ms, signal) => {
      if (options.hold) {
        return new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    onChange: (state) => {
      states.push(state);
      if (state.state !== 'waiting') settle(state);
    },
  });
  return {
    fake,
    signIn,
    slept,
    opened,
    kept,
    states,
    settled,
    advance: (ms: number) => (now += ms),
  };
}

describe('Sign in with GitHub (device flow)', () => {
  it('shows the code, opens github.com/login/device, polls until approved and keeps the token', async () => {
    const { fake, signIn, opened, kept, slept, settled } = setup();
    fake.device.polls = ['pending', 'pending', 'token'];
    const started = await signIn.start();
    expect(started).toEqual({
      state: 'waiting',
      userCode: 'WDJB-MJHT',
      verificationUri: `${WEB}/login/device`,
      expiresAt: 1_000_000 + 900_000,
    });
    expect(opened).toEqual([`${WEB}/login/device`]);
    expect(await settled).toEqual({ state: 'signed-in', login: 'ryan' });
    expect(kept).toEqual([TOKEN]);
    expect(slept).toEqual([50, 50, 50]);
    // The code request names Penmoss's app and its scopes; no secret is sent.
    const asked = fake.requests.find((request) => request.path === '/login/device/code');
    const form = new URLSearchParams(String(asked?.body));
    expect(form.get('client_id')).toBe(fake.device.clientId);
    expect(form.get('scope')).toBe(SIGN_IN_SCOPES);
    expect(form.has('client_secret')).toBe(false);
    // The page's state never holds the device code or the token.
    expect(JSON.stringify(signIn.state())).not.toContain(fake.device.deviceCode);
    expect(JSON.stringify(signIn.state())).not.toContain(TOKEN);
  });

  it('waits longer each time GitHub says slow_down', async () => {
    const { fake, signIn, slept, settled } = setup();
    fake.device.interval = 5;
    fake.device.polls = ['slow_down', 'slow_down', 'token'];
    await signIn.start();
    expect((await settled).state).toBe('signed-in');
    // The fake names a new interval just above the old one; the poller adds at least 5 s.
    expect(slept).toEqual([5000, 10_000, 15_000]);
  });

  it('ends on access_denied, expired_token, or the code running out', async () => {
    const denied = setup();
    denied.fake.device.polls = ['pending', 'denied'];
    await denied.signIn.start();
    expect(await denied.settled).toEqual({ state: 'denied' });
    expect(denied.kept).toEqual([]);

    const expired = setup();
    expired.fake.device.polls = ['expired'];
    await expired.signIn.start();
    expect(await expired.settled).toEqual({ state: 'expired' });

    const ranOut = setup();
    ranOut.fake.device.expiresIn = 1;
    ranOut.fake.device.interval = 2;
    await ranOut.signIn.start();
    expect(await ranOut.settled).toEqual({ state: 'expired' });
    // It stopped at the expiry without asking GitHub again.
    expect(ranOut.fake.requests.filter((r) => r.path === '/login/oauth/access_token')).toEqual([]);
  });

  it('Cancel stops the polling; a new sign-in replaces an old one', async () => {
    const { fake, signIn, states } = setup();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    // A sleep that waits for the test: cancel lands mid-wait.
    Reflect.set(signIn, 'options', {
      ...(Reflect.get(signIn, 'options') as object),
      sleep: (_ms: number, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
          void held.then(resolve);
        }),
    });
    await signIn.start();
    signIn.cancel();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signIn.state()).toEqual({ state: 'cancelled' });
    expect(fake.requests.filter((r) => r.path === '/login/oauth/access_token')).toEqual([]);
    expect(states.map((state) => state.state)).toEqual(['waiting', 'cancelled']);
  });

  it('a start overtaken by another, or by Cancel, while GitHub answers changes nothing (review)', async () => {
    const answers: Array<(value: { status: number; json(): Promise<unknown> }) => void> = [];
    const fail: Array<(error: Error) => void> = [];
    const pending: SignInFetch = (url) =>
      url.endsWith('/login/device/code')
        ? new Promise((resolve, reject) => {
            answers.push(resolve);
            fail.push(reject);
          })
        : Promise.resolve({
            status: 200,
            json: () => Promise.resolve({ error: 'authorization_pending' }),
          });
    const { signIn, opened, states } = setup({ fetch: pending, hold: true });
    const code = (user: string) => ({
      status: 200,
      json: () =>
        Promise.resolve({
          device_code: `device-${user}`,
          user_code: user,
          verification_uri: `${WEB}/login/device`,
          expires_in: 900,
          interval: 5,
        }),
    });
    const first = signIn.start();
    const second = signIn.start();
    // The newer start's answer arrives first; the older one's after it.
    answers[1]!(code('BBBB-BBBB'));
    await second;
    answers[0]!(code('AAAA-AAAA'));
    await first;
    expect(signIn.state()).toMatchObject({ state: 'waiting', userCode: 'BBBB-BBBB' });
    expect(opened).toEqual([`${WEB}/login/device`]);
    // An older start that fails later leaves the newer one running.
    const third = signIn.start();
    const fourth = signIn.start();
    answers[3]!(code('DDDD-DDDD'));
    await fourth;
    fail[2]!(new Error('offline'));
    await third;
    expect(signIn.state()).toMatchObject({ state: 'waiting', userCode: 'DDDD-DDDD' });
    // Cancel while GitHub is still answering: nothing opens and it stays cancelled.
    const fifth = signIn.start();
    signIn.cancel();
    answers[4]!(code('EEEE-EEEE'));
    await fifth;
    expect(signIn.state()).toEqual({ state: 'cancelled' });
    expect(opened).toHaveLength(2);
    expect(states.filter((state) => state.state === 'failed')).toEqual([]);
    signIn.cancel();
  });

  it('opens nothing when GitHub names another page, and offers nothing without an app', async () => {
    const elsewhere = setup({
      fetch: () =>
        Promise.resolve({
          status: 200,
          json: () =>
            Promise.resolve({
              device_code: 'x',
              user_code: 'ABCD-EFGH',
              verification_uri: 'https://evil.test/login/device',
              expires_in: 900,
              interval: 5,
            }),
        }),
    });
    const answer = await elsewhere.signIn.start();
    expect(answer.state).toBe('failed');
    expect(elsewhere.opened).toEqual([]);

    const none = setup({ clientId: null });
    expect(none.signIn.available).toBe(false);
    expect((await none.signIn.start()).state).toBe('failed');
    expect(none.fake.requests).toEqual([]);
  });

  it('says so when the token could not be kept, or GitHub is out of reach', async () => {
    const unkept = setup({ kept: false });
    unkept.fake.device.polls = ['token'];
    await unkept.signIn.start();
    const state = await unkept.settled;
    expect(state.state).toBe('failed');
    expect(state.state === 'failed' && state.message).toMatch(/Keychain/);

    const offline = setup({ fetch: () => Promise.reject(new Error('offline')) });
    const answer = await offline.signIn.start();
    expect(answer.state).toBe('failed');
    expect(offline.opened).toEqual([]);
  });
});
