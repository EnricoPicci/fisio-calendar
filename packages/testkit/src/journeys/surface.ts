import type { ObservableOwner } from './harness';

/**
 * The surface-coverage check (docs/architecture.md §10.5): which public methods and streams of
 * each view-model class the journeys and view-model specs exercised. A spec worker instruments
 * the classes once (`instrumentSurface`, from a Vitest setup file); each spec file then reports
 * its log, and a final step compares the union with each class's surface (`uncoveredMembers`).
 *
 * The surface of a class is its methods, from its prototype up to the first abstract base
 * (`ViewModel`, `FormViewModel`: their members are the base's own specs' business), plus the
 * streams it declared through the base's `stream()`. A method counts as exercised when it was
 * called, a stream when it was subscribed, on an instance of the class.
 */
/** A class, whatever its constructor's signature or visibility. */
export interface ViewModelClass {
  readonly name: string;
  readonly prototype: object;
}

export interface SurfaceLog {
  /** Streams each class declared, by class name. */
  readonly streams: Readonly<Record<string, readonly string[]>>;
  /** Members exercised, by class name. */
  readonly exercised: Readonly<Record<string, readonly string[]>>;
}

/** Method names of the class's public surface (see the module comment). */
export function surfaceMethods(cls: ViewModelClass, bases: readonly ViewModelClass[]): string[] {
  const names = new Set<string>();
  for (const prototype of ownPrototypes(cls, bases)) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (name !== 'constructor' && typeof descriptor?.value === 'function') names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * Wraps the methods of `classes` and the base's `stream()` so that this worker logs what is
 * declared and exercised. Idempotent per prototype.
 */
export function instrumentSurface(options: {
  readonly base: ViewModelClass;
  readonly bases: readonly ViewModelClass[];
  readonly classes: readonly ViewModelClass[];
}): { log(): SurfaceLog } {
  const streams = new Map<string, Set<string>>();
  const exercised = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, cls: string, member: string) => {
    const members = map.get(cls) ?? new Set<string>();
    map.set(cls, members.add(member));
  };

  for (const cls of options.classes) {
    for (const prototype of ownPrototypes(cls, options.bases)) {
      if (instrumented.has(prototype)) continue;
      instrumented.add(prototype);
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const original: unknown = descriptor?.value;
        if (name === 'constructor' || typeof original !== 'function') continue;
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value: function (this: object, ...args: unknown[]) {
            add(exercised, this.constructor.name, name);
            return (original as (...a: unknown[]) => unknown).apply(this, args);
          },
        });
      }
    }
  }

  const prototype = options.base.prototype as { stream: (...args: unknown[]) => unknown };
  if (!instrumented.has(prototype)) {
    instrumented.add(prototype);
    const original = prototype.stream;
    const observed = new WeakSet<object>();
    prototype.stream = function (this: ObservableOwner, name: unknown, ...rest: unknown[]) {
      const result = original.call(this, name, ...rest);
      add(streams, this.constructor.name, String(name));
      if (!observed.has(this)) {
        observed.add(this);
        this.observe({
          subscribed: (owner, stream) => add(exercised, owner.constructor.name, stream),
          emitted: () => {},
          unsubscribed: () => {},
        });
      }
      return result;
    };
  }

  const toRecord = (map: Map<string, Set<string>>) =>
    Object.fromEntries([...map].map(([cls, members]) => [cls, [...members].sort()]));
  return { log: () => ({ streams: toRecord(streams), exercised: toRecord(exercised) }) };
}

/**
 * Every surface member no spec exercised, as `Class.member`, minus the allowlist; plus any
 * allowlist entry that is exercised after all (a stale entry). `streams` and `exercised` are the
 * union of the logs of every reporting spec file.
 */
export function uncoveredMembers(input: {
  readonly methods: Readonly<Record<string, readonly string[]>>;
  readonly streams: Readonly<Record<string, readonly string[]>>;
  readonly exercised: Readonly<Record<string, readonly string[]>>;
  readonly allowlist: readonly string[];
}): { uncovered: string[]; stale: string[]; neverConstructed: string[] } {
  const exercised = new Set(
    Object.entries(input.exercised).flatMap(([cls, members]) => members.map((m) => `${cls}.${m}`)),
  );
  const allowed = new Set(input.allowlist);
  const uncovered: string[] = [];
  const neverConstructed: string[] = [];
  for (const [cls, methods] of Object.entries(input.methods)) {
    const streams = input.streams[cls];
    if (!streams) neverConstructed.push(cls);
    for (const member of [...methods, ...(streams ?? [])]) {
      const key = `${cls}.${member}`;
      if (!exercised.has(key) && !allowed.has(key)) uncovered.push(key);
    }
  }
  const stale = input.allowlist.filter((key) => exercised.has(key));
  return { uncovered: uncovered.sort(), stale, neverConstructed: neverConstructed.sort() };
}

/** Vitest evaluates modules afresh per spec file, so this guards repeated calls within one file. */
const instrumented = new WeakSet<object>();

function ownPrototypes(cls: ViewModelClass, bases: readonly ViewModelClass[]): object[] {
  const stops = new Set<unknown>([Object.prototype, ...bases.map((base) => base.prototype)]);
  const prototypes: object[] = [];
  for (
    let prototype: object | null = cls.prototype;
    prototype && !stops.has(prototype);
    prototype = Object.getPrototypeOf(prototype)
  ) {
    prototypes.push(prototype);
  }
  return prototypes;
}
