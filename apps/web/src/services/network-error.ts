/**
 * A request that never reached the server or never answered (`fetch` rejected): the device is
 * offline, DNS failed, the connection dropped. Raised at the service boundary so a view-model
 * can tell "offline" from a programming error; a plain `TypeError` elsewhere stays unexpected.
 */
export class NetworkError extends Error {
  override readonly name = 'NetworkError';

  constructor(cause: unknown) {
    super('The request could not reach the server', { cause });
  }
}

/** Runs `fetch` and converts its rejection, the only way it reports a network failure. */
export async function fetchOrNetworkError(
  fetch: typeof globalThis.fetch,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    throw new NetworkError(error);
  }
}
