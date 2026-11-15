// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { devicePref } from '../../src/shell/device-pref';
import { memoryStorage } from './support/memory-storage';

afterEach(() => vi.unstubAllGlobals());

const listPref = (crossWindow = false) =>
  devicePref<readonly string[]>('penmoss.test.list', {
    parse: (stored) => (stored ? stored.split(',') : []),
    serialise: (list) => (list.length === 0 ? null : list.join(',')),
    crossWindow,
  });

describe('a device preference (web.md 2.9)', () => {
  it('reads what is stored, and gives the same value until that changes', () => {
    const storage = memoryStorage({ 'penmoss.test.list': 'a,b' });
    vi.stubGlobal('localStorage', storage);
    const pref = listPref();
    const first = pref.read();
    expect(first).toEqual(['a', 'b']);
    // A snapshot for useSyncExternalStore: the same object while nothing changed.
    expect(pref.read()).toBe(first);
    storage.setItem('penmoss.test.list', 'c');
    expect(pref.read()).toEqual(['c']);
  });

  it('stores what serialise gives, removes the key for null, and tells its listeners', () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    const pref = listPref();
    const heard = vi.fn();
    const off = pref.subscribe(heard);
    pref.write(['x']);
    expect(storage.getItem('penmoss.test.list')).toBe('x');
    pref.write([]);
    expect(storage.data.has('penmoss.test.list')).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    pref.write(['y']);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it('keeps the choice for this page where storage refuses it (a private window)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    });
    const pref = listPref();
    pref.write(['kept']);
    expect(pref.read()).toEqual(['kept']);
  });

  it('follows another window only when asked', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const here = vi.fn();
    const across = vi.fn();
    const offHere = listPref().subscribe(here);
    const offAcross = listPref(true).subscribe(across);
    window.dispatchEvent(new StorageEvent('storage', { key: 'penmoss.test.list' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'penmoss.other' }));
    expect(here).not.toHaveBeenCalled();
    expect(across).toHaveBeenCalledTimes(1);
    offHere();
    offAcross();
  });
});
