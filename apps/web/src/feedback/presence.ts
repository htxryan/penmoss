/**
 * Which note each Penmoss window or tab shows, for Send feedback's "Open in windows" (T49,
 * A791): every window says what it shows on a BroadcastChannel when that changes, answers a
 * newcomer's hello, and says goodbye when it closes. Only note ids travel, never their text.
 * The Mac app's windows share one origin, so its main and note windows count each other too.
 */

const CHANNEL = 'penmoss-feedback-presence';

type Message =
  | { readonly kind: 'hello'; readonly from: string }
  | { readonly kind: 'here'; readonly from: string; readonly note: string | null }
  | { readonly kind: 'bye'; readonly from: string };

interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

export class Presence {
  private readonly others = new Map<string, string | null>();
  private readonly id = Math.random().toString(36).slice(2);
  private note: string | null = null;
  private channel: ChannelLike | null = null;

  constructor(
    open: () => ChannelLike | null = () =>
      typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL),
  ) {
    this.channel = open();
    this.channel?.addEventListener('message', (event) => this.receive(event.data as Message));
    this.post({ kind: 'hello', from: this.id });
  }

  private post(message: Message): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // A closed channel: this window is going.
    }
  }

  private receive(message: Message): void {
    if (!message || typeof message !== 'object' || message.from === this.id) return;
    if (message.kind === 'hello') this.post({ kind: 'here', from: this.id, note: this.note });
    else if (message.kind === 'here') this.others.set(message.from, message.note ?? null);
    else if (message.kind === 'bye') this.others.delete(message.from);
  }

  /** This window now shows `note` (null: no note). */
  show(note: string | null): void {
    if (note === this.note) return;
    this.note = note;
    this.post({ kind: 'here', from: this.id, note });
  }

  /** How many windows show `note`, this one included. */
  windowsShowing(note: string): number {
    let count = this.note === note ? 1 : 0;
    for (const shown of this.others.values()) if (shown === note) count++;
    return count;
  }

  close(): void {
    this.post({ kind: 'bye', from: this.id });
    this.channel?.close();
    this.channel = null;
  }
}
