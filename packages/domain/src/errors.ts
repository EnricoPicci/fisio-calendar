/**
 * Recognising domain errors across module copies. Two copies of `@fisio/domain` in one bundle
 * make `instanceof` fail, so every layer that branches on a domain error (the notifier's error
 * classification, the API's error mapper) also compares the `name` each error class sets.
 */
export function isErrorNamed(error: unknown, name: string): boolean {
  return errorName(error) === name;
}

/** The `name` of an error-like value, or undefined; a throwing getter counts as no name. */
export function errorName(error: unknown): string | undefined {
  try {
    const name =
      typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
}
