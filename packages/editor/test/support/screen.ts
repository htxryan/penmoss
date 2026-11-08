import { vi } from 'vitest';

// Unlike intersection.ts (everything visible), elements here can be moved off and on screen.

type Observer = { callback: IntersectionObserverCallback; targets: Set<Element> };

/**
 * A controllable IntersectionObserver (happy-dom's never reports): elements
 * are on screen unless hidden, reported when observed and on every change.
 */
export function fakeScreen(options: { offScreen?: boolean } = {}) {
  const shown = new Set<Element>();
  const hidden = new Set<Element>();
  const observers = new Set<Observer>();
  const onScreen = (target: Element) =>
    options.offScreen ? shown.has(target) : !hidden.has(target);
  const report = (observer: Observer, target: Element) =>
    observer.callback(
      [{ target, isIntersecting: onScreen(target) } as unknown as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  class FakeIntersectionObserver {
    private readonly observer: Observer;
    constructor(callback: IntersectionObserverCallback) {
      this.observer = { callback, targets: new Set() };
      observers.add(this.observer);
    }
    observe(target: Element) {
      this.observer.targets.add(target);
      report(this.observer, target);
    }
    unobserve(target: Element) {
      this.observer.targets.delete(target);
    }
    disconnect() {
      this.observer.targets.clear();
      observers.delete(this.observer);
    }
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  const change = (target: Element, visible: boolean) => {
    if (visible) {
      shown.add(target);
      hidden.delete(target);
    } else {
      hidden.add(target);
      shown.delete(target);
    }
    for (const observer of observers) if (observer.targets.has(target)) report(observer, target);
  };
  return {
    show: (target: Element) => change(target, true),
    hide: (target: Element) => change(target, false),
    /** How many elements are observed now. */
    observed: () => [...observers].reduce((sum, observer) => sum + observer.targets.size, 0),
  };
}
