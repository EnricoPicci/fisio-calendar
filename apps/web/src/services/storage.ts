/**
 * The `Storage` port (docs/architecture.md §7.1): a view-model or service never touches
 * `localStorage` directly. Keys are strings, values are strings; callers serialise.
 */
export interface Storage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** For specs and the headless journeys. */
export class MemoryStorage implements Storage {
  readonly #items = new Map<string, string>();

  get(key: string): string | null {
    return this.#items.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.#items.set(key, value);
  }

  remove(key: string): void {
    this.#items.delete(key);
  }
}

type WebStorage = Pick<typeof globalThis.localStorage, 'getItem' | 'setItem' | 'removeItem'>;

/** `localStorage` behind the port, for the browser build. */
export class BrowserStorage implements Storage {
  readonly #backing: WebStorage;

  constructor(backing: WebStorage) {
    this.#backing = backing;
  }

  get(key: string): string | null {
    return this.#backing.getItem(key);
  }

  set(key: string, value: string): void {
    this.#backing.setItem(key, value);
  }

  remove(key: string): void {
    this.#backing.removeItem(key);
  }
}
