/** A page's local storage (`Storage`) held in memory, for tests that run outside a browser. */
export class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();
  /** When set, `setItem` throws as a full storage does. */
  full = false;

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    this.items.set(key, String(value));
  }

  keys(): string[] {
    return [...this.items.keys()];
  }
}
