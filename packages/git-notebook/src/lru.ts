/** A small map that forgets the entry used least recently once it holds `size`. */
export class Lru<K, V> {
  private readonly entries = new Map<K, V>();
  constructor(private readonly size: number) {}
  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  has(key: K): boolean {
    return this.entries.has(key);
  }
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.size) {
      this.entries.delete(this.entries.keys().next().value as K);
    }
  }
}
