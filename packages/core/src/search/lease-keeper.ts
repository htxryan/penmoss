/**
 * Keeps trying for search by meaning's indexing lease (A1157, A1350). One indexer per Mac holds
 * `~/.penmoss/vectors/indexer.lease`; every other process searches with the vectors it finds. A
 * process that tried once and lost the race would never index, even after the holder died, so
 * each one tries again every `retryMs` while it lacks the lease, and checks every `retryMs` that it
 * still holds it. `onChange` hears each gain and loss.
 */

/** The lease as the keeper uses it (`@penmoss/embed`'s `Lease`). */
export interface HeldLease {
  held(): Promise<boolean>;
  release(): Promise<void>;
}

export interface LeaseKeeperOptions {
  /** How often to try for the lease, or check it is still held (ms, default 30 s). */
  readonly retryMs?: number;
  /** The lease was gained (true) or lost (false). */
  readonly onChange?: (held: boolean) => void;
  readonly log?: (text: string) => void;
}

export const LEASE_RETRY_MS = 30_000;

export class LeaseKeeper {
  private lease: HeldLease | undefined;
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<boolean> | null = null;
  private stopped = false;

  /** `take`: one try for the lease, undefined while another live process holds it. */
  constructor(
    private readonly take: () => Promise<HeldLease | undefined>,
    private readonly options: LeaseKeeperOptions = {},
  ) {}

  /** Whether this process held the lease when last checked. */
  get held(): boolean {
    return this.lease !== undefined;
  }

  /** Tries at once, then keeps trying (and checking) every `retryMs` until stopped. */
  async start(): Promise<boolean> {
    this.stopped = false;
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), this.options.retryMs ?? LEASE_RETRY_MS);
      this.timer.unref?.();
    }
    return this.check();
  }

  /**
   * One round now: without the lease, try for it; with it, make sure it is still ours. Answers
   * whether this process holds it. Overlapping calls share one round.
   */
  check(): Promise<boolean> {
    this.checking ??= this.round().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  /** Stops trying and lets go of the lease. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.checking?.catch(() => undefined);
    const lease = this.lease;
    this.lease = undefined;
    await lease?.release();
  }

  private async round(): Promise<boolean> {
    if (this.stopped) return false;
    try {
      if (this.lease) {
        if (await this.lease.held()) return true;
        this.lease = undefined;
        if (!this.stopped) this.options.onChange?.(false);
      }
      const lease = await this.take();
      if (this.stopped) {
        await lease?.release();
        return false;
      }
      if (!lease) return false;
      this.lease = lease;
      this.options.onChange?.(true);
      return true;
    } catch (error) {
      this.options.log?.(
        `could not take the indexing lease: ${error instanceof Error ? error.message : String(error)}`,
      );
      return this.lease !== undefined;
    }
  }
}
