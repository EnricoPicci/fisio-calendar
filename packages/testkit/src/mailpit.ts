/**
 * Reading Mailpit (docs/architecture.md §11.4), the local SMTP sink, through its REST API: the
 * contract spec of the SMTP channel checks a message really arrived. `MAILPIT_API` overrides the
 * default address.
 */
export const MAILPIT_API = process.env.MAILPIT_API || 'http://127.0.0.1:8025/api/v1';

export interface MailpitMessage {
  /** Mailpit's id: what `SmtpEmailChannel` returns as `providerMessageId`. */
  readonly id: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
}

interface RawMessage {
  readonly ID: string;
  readonly To?: readonly { readonly Address: string }[] | null;
  readonly Subject: string;
  readonly Text?: string;
  readonly HTML?: string;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${MAILPIT_API}${path}`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Mailpit ${path} answered HTTP ${response.status}`);
  return (await response.json()) as T;
}

/** The message with this id, with its headers. */
export async function mailpitMessage(id: string): Promise<MailpitMessage> {
  const path = `/message/${encodeURIComponent(id)}`;
  const [raw, headers] = await Promise.all([
    getJson<RawMessage>(path),
    getJson<Record<string, string[]>>(`${path}/headers`),
  ]);
  return {
    id: raw.ID,
    to: (raw.To ?? []).map((to) => to.Address),
    subject: raw.Subject,
    text: raw.Text ?? '',
    html: raw.HTML ?? '',
    headers,
  };
}
