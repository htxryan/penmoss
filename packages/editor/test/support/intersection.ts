/**
 * happy-dom's IntersectionObserver never reports anything. This stand-in
 * reports every observed element as visible (soon after `observe`) unless a
 * test turns that off and shows elements itself with `showAll`.
 */
const observers = new Set<FakeIntersectionObserver>();
let automatic = true;

class FakeIntersectionObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    observers.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
    if (automatic) queueMicrotask(() => this.report());
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    observers.delete(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  report(): void {
    if (!this.targets.size) return;
    const entries = [...this.targets].map(
      (target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry,
    );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

/** Whether observed elements count as visible at once (the default). */
export function reportVisibleAtOnce(value: boolean): void {
  automatic = value;
}

/** Reports every observed element as visible. */
export function showAll(): void {
  for (const observer of [...observers]) observer.report();
}

globalThis.IntersectionObserver =
  FakeIntersectionObserver as unknown as typeof IntersectionObserver;
