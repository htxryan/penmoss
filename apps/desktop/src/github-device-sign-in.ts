/**
 * Sign in with GitHub (T82, #229; D63, A1170): GitHub's device flow for Penmoss's OAuth app, in
 * the main process. GitHub gives a short code; the person enters it at github.com/login/device
 * in their browser and approves; this polls until GitHub hands over the token, which is kept in
 * the GitHub Token store (A1171) and never reaches the page. No password and no client secret
 * are involved: the client id is public.
 */

/** A fetch as the sign-in needs it (`net.fetch` and `globalThis.fetch` both fit). */
export type SignInFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

/** What the page may know of a sign-in: never the device code or the token. */
export type SignInState =
  | { readonly state: 'idle' }
  | {
      readonly state: 'waiting';
      /** The code to enter on GitHub, `WDJB-MJHT`. */
      readonly userCode: string;
      readonly verificationUri: string;
      /** When the code stops working (ms since the epoch). */
      readonly expiresAt: number;
    }
  | { readonly state: 'signed-in'; readonly login: string | null }
  | { readonly state: 'denied' }
  | { readonly state: 'expired' }
  | { readonly state: 'cancelled' }
  | { readonly state: 'failed'; readonly message: string };

export interface DeviceSignInOptions {
  readonly fetch: SignInFetch;
  /** Penmoss's OAuth app; null in a build without one (Sign in is not offered then). */
  readonly clientId: string | null;
  /** github.com, or the suite's fake (`PENMOSS_TEST_GITHUB_WEB`). */
  readonly web?: string | null;
  /** Opens the verification page in the person's browser. */
  readonly openExternal: (url: string) => Promise<unknown>;
  /** Keeps the token and says whose it is; false when it could not be kept. */
  readonly keep: (
    token: string,
  ) => Promise<{ readonly kept: boolean; readonly login: string | null }>;
  readonly onChange?: (state: SignInState) => void;
  readonly now?: () => number;
  /** Waits `ms`, or less when the sign-in is cancelled; tests pass a fake clock. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly log?: (message: string) => void;
}

const GITHUB_WEB = 'https://github.com';
/** What the token may do: read and write the person's repositories (HTTPS push), and list orgs. */
export const SIGN_IN_SCOPES = 'repo read:org';
/** A code's characters, as GitHub shows them (`WDJB-MJHT`). */
const USER_CODE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class DeviceSignIn {
  private current: SignInState = { state: 'idle' };
  private running: AbortController | null = null;
  private readonly web: string;

  constructor(private readonly options: DeviceSignInOptions) {
    this.web = (options.web ?? GITHUB_WEB).replace(/\/+$/, '');
  }

  /** Whether this build can sign in at all (it has Penmoss's OAuth app). */
  get available(): boolean {
    return Boolean(this.options.clientId);
  }

  state(): SignInState {
    return this.current;
  }

  private set(state: SignInState): void {
    this.current = state;
    this.options.onChange?.(state);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private post(path: string, fields: Record<string, string>) {
    return this.options.fetch(`${this.web}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Penmoss',
      },
      body: new URLSearchParams(fields).toString(),
    });
  }

  /** Asks GitHub for a code, opens the page to enter it, and waits for the person in the background. */
  async start(): Promise<SignInState> {
    const clientId = this.options.clientId;
    if (!clientId) {
      this.set({ state: 'failed', message: 'This build of Penmoss can’t sign in to GitHub.' });
      return this.current;
    }
    this.cancel(false);
    const controller = new AbortController();
    this.running = controller;
    // A Cancel, or a newer start, while GitHub answered: this one then touches nothing (review).
    const superseded = () => controller.signal.aborted || this.running !== controller;
    let body: {
      device_code?: unknown;
      user_code?: unknown;
      verification_uri?: unknown;
      expires_in?: unknown;
      interval?: unknown;
      error_description?: unknown;
    };
    try {
      const response = await this.post('/login/device/code', {
        client_id: clientId,
        scope: SIGN_IN_SCOPES,
      });
      body = (await response.json().catch(() => ({}))) as typeof body;
      if (response.status !== 200)
        throw new Error(
          typeof body.error_description === 'string'
            ? body.error_description
            : `GitHub answered ${response.status}.`,
        );
    } catch (error) {
      if (superseded()) return this.current;
      this.running = null;
      this.set({
        state: 'failed',
        message:
          `Can’t reach GitHub to sign in. ${error instanceof Error ? error.message : ''}`.trim(),
      });
      return this.current;
    }
    if (superseded()) return this.current;
    const deviceCode = typeof body.device_code === 'string' ? body.device_code : '';
    const userCode = typeof body.user_code === 'string' ? body.user_code : '';
    const verificationUri = typeof body.verification_uri === 'string' ? body.verification_uri : '';
    // Only GitHub's own page is ever opened (A1170).
    if (
      !deviceCode ||
      !USER_CODE.test(userCode) ||
      verificationUri !== `${this.web}/login/device`
    ) {
      this.running = null;
      this.set({
        state: 'failed',
        message: 'GitHub answered the sign-in in a way Penmoss does not expect.',
      });
      return this.current;
    }
    const expiresIn =
      typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 900;
    const interval = typeof body.interval === 'number' && body.interval > 0 ? body.interval : 5;
    const expiresAt = this.now() + expiresIn * 1000;
    this.set({ state: 'waiting', userCode, verificationUri, expiresAt });
    await this.options.openExternal(verificationUri).catch(() => undefined);
    void this.poll(clientId, deviceCode, interval, expiresAt, controller);
    return this.current;
  }

  /** Stops waiting; `say` false when a new sign-in replaces it. */
  cancel(say = true): void {
    if (!this.running) return;
    this.running.abort();
    this.running = null;
    if (say) this.set({ state: 'cancelled' });
  }

  private async poll(
    clientId: string,
    deviceCode: string,
    seconds: number,
    expiresAt: number,
    controller: AbortController,
  ): Promise<void> {
    const sleep = this.options.sleep ?? realSleep;
    let interval = seconds;
    const live = () => !controller.signal.aborted && this.running === controller;
    while (live()) {
      await sleep(interval * 1000, controller.signal);
      if (!live()) return;
      if (this.now() >= expiresAt) {
        this.running = null;
        this.set({ state: 'expired' });
        return;
      }
      let answer: { access_token?: unknown; error?: unknown; interval?: unknown };
      try {
        const response = await this.post('/login/oauth/access_token', {
          client_id: clientId,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        answer = (await response.json().catch(() => ({}))) as typeof answer;
      } catch {
        // Offline for a moment: try again at the next interval, until the code expires.
        continue;
      }
      if (!live()) return;
      if (typeof answer.access_token === 'string' && answer.access_token) {
        this.running = null;
        const kept = await this.options
          .keep(answer.access_token)
          .catch(() => ({ kept: false, login: null }));
        this.set(
          kept.kept
            ? { state: 'signed-in', login: kept.login }
            : {
                state: 'failed',
                message: 'Penmoss could not keep the sign-in: the Keychain is not available.',
              },
        );
        this.options.log?.(`GitHub sign-in ${kept.kept ? 'done' : 'not kept'}`);
        return;
      }
      switch (answer.error) {
        case 'authorization_pending':
          break;
        case 'slow_down':
          // 5 s more each time, or the new interval GitHub names if that is longer.
          interval = Math.max(
            interval + 5,
            typeof answer.interval === 'number' ? answer.interval : 0,
          );
          break;
        case 'access_denied':
          this.running = null;
          this.set({ state: 'denied' });
          return;
        case 'expired_token':
          this.running = null;
          this.set({ state: 'expired' });
          return;
        default:
          this.running = null;
          this.set({
            state: 'failed',
            message: `GitHub refused the sign-in (${typeof answer.error === 'string' ? answer.error : 'no answer'}).`,
          });
          return;
      }
    }
  }
}
