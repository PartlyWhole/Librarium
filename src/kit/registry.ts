/**
 * An ordered registry for a slot. Duplicate IDs are rejected; order is explicit
 * (`order`, then registration order).
 */
export class DuplicateError extends Error {}

export interface Entry<T> {
  id: string;
  contributor: string;
  order: number;
  value: T;
}

export class Registry<T> {
  private entries: Entry<T>[] = [];
  private seq = 0;
  constructor(readonly slot: string) {}

  add(contributor: string, id: string, value: T, order = 0): void {
    if (this.entries.some((e) => e.id === id)) {
      throw new DuplicateError(`slot ${this.slot} already has a contribution with id "${id}"`);
    }
    this.entries.push({ id, contributor, order: order * 1e6 + this.seq++, value });
    this.entries.sort((a, b) => a.order - b.order);
  }

  get(id: string): T | undefined {
    return this.entries.find((e) => e.id === id)?.value;
  }

  values(): T[] {
    return this.entries.map((e) => e.value);
  }

  list(): readonly Entry<T>[] {
    return this.entries;
  }

  contributors(): [string, string][] {
    return this.entries.map((e) => [e.id, e.contributor]);
  }
}
