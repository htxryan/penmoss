/**
 * What main sends the main window's page from outside it (T51, A945): a page command (Open
 * Today's Journal in the menu bar icon's menu) or a path to show (a Quick Access note, a deep
 * link). The page listens once React has mounted its integration, which is later than its
 * load ending: `isLoading()` turned false before the page listened, and a click in that gap
 * was sent to nobody; held only while loading, a click just after the page asked was held and
 * never taken, then ran on a later load.
 *
 * So the page says when it listens (it asks for what is held, `menuCommandPending`), and main
 * sends straight away only to a page that has asked. Otherwise it holds the latest one for that
 * window, which the page takes when it asks: a new document does not listen until it asks
 * again, a closed window's item goes, and one held longer than `HOLD_MS` is dropped rather than
 * run long after the click. Pure, so the decision is tested without Electron.
 */

export type MainDelivery =
  | { readonly kind: 'command'; readonly id: string }
  | { readonly kind: 'path'; readonly path: string };

/** How long an item waits for a page that has not asked yet. */
export const HOLD_MS = 30_000;

export class MainInbox {
  /** The pages (by webContents id) that asked since their document loaded. */
  private readonly listening = new Set<number>();
  private held: {
    readonly target: number;
    readonly item: MainDelivery;
    readonly at: number;
  } | null = null;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly holdMs = HOLD_MS,
  ) {}

  /** Whether to send `item` to `target` now ('send'), or it is held for its page to take. */
  deliver(target: number, item: MainDelivery): 'send' | 'held' {
    if (this.listening.has(target)) return 'send';
    this.held = { target, item, at: this.now() };
    return 'held';
  }

  /** `target`'s page listens now: what was held for it, if still fresh. */
  take(target: number): MainDelivery | null {
    this.listening.add(target);
    const held = this.held;
    if (!held || held.target !== target) return null;
    this.held = null;
    return this.now() - held.at <= this.holdMs ? held.item : null;
  }

  /**
   * `target` started loading another document: it no longer listens until its new page asks.
   * What is held stays for that page (it is held while the window loads, often after the load
   * began), so the time limit is what keeps it from running much later.
   */
  navigated(target: number): void {
    this.listening.delete(target);
  }

  /** `target`'s window closed: it listens to nothing, and what was held for it goes. */
  closed(target: number): void {
    this.listening.delete(target);
    if (this.held?.target === target) this.held = null;
  }

  /** Whether an item is held (the tests read it). */
  get holding(): MainDelivery | null {
    return this.held?.item ?? null;
  }
}
