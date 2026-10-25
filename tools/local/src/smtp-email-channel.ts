import {
  isSingleMailbox,
  NOTIFICATION_KEY_HEADER,
  type NotificationChannel,
  type OutboundMessage,
  PermanentError,
  RetryableError,
  type SendResult,
} from '@fisio/domain';
import nodemailer, { type Transporter } from 'nodemailer';

/**
 * The email channel of the local stack (docs/architecture.md §5.4, §11.4): SMTP to Mailpit
 * (`tools/local/docker-compose.yml`, port 1025), where every local email lands, readable in the
 * UI at http://localhost:8025 and through Mailpit's REST API. The local API, notifier and auth
 * emulator all send through it; the cloud counterpart is `SesEmailChannel` (apps/api). It runs
 * `NotificationChannel.contract.spec.ts` against Mailpit; the SES target joins in WP0.10.
 *
 * Errors follow the port: an SMTP 5xx reply or a refused envelope is a `PermanentError`, a 4xx
 * reply, a refused connection or a timeout is a `RetryableError`. Their messages name the reply
 * code and SMTP step only, never the address, because the notifier stores them (`lastError`);
 * the provider's error is kept as `cause`.
 */
export const LOCAL_SMTP = { host: '127.0.0.1', port: 1025 } as const;

export interface EmailAddress {
  readonly name: string;
  readonly address: string;
}

export const LOCAL_EMAIL_FROM: EmailAddress = {
  name: 'Fisio Calendar',
  address: 'noreply@fisio.test',
};

export interface SmtpEmailChannelOptions {
  readonly host?: string;
  readonly port?: number;
  readonly from?: EmailAddress;
  /** Connection, greeting and socket timeout; a stalled server fails the attempt (retryable). */
  readonly timeoutMs?: number;
}

/** Mailpit answers DATA with `250 2.0.0 Ok: queued as <id>`; that id opens the message in its API. */
const QUEUED_AS = /queued as (\S+)/i;

export class SmtpEmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;
  readonly #transport: Transporter;
  readonly #from: EmailAddress;

  constructor(options: SmtpEmailChannelOptions = {}) {
    const timeout = options.timeoutMs ?? 5_000;
    this.#from = options.from ?? LOCAL_EMAIL_FROM;
    this.#transport = nodemailer.createTransport({
      host: options.host ?? LOCAL_SMTP.host,
      port: options.port ?? LOCAL_SMTP.port,
      secure: false,
      // Mailpit offers no TLS; nothing leaves the laptop.
      ignoreTLS: true,
      connectionTimeout: timeout,
      greetingTimeout: timeout,
      socketTimeout: timeout,
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!isSingleMailbox(message.to)) {
      throw new PermanentError('SMTP recipient is not a single address');
    }
    let response: unknown;
    try {
      const info = await this.#transport.sendMail({
        from: this.#from,
        to: { name: '', address: message.to },
        // An explicit envelope: the recipient is never re-parsed from a header.
        envelope: { from: this.#from.address, to: [message.to] },
        subject: message.subject,
        text: message.text,
        ...(message.html !== undefined ? { html: message.html } : {}),
        headers: { [NOTIFICATION_KEY_HEADER]: message.notificationKey },
      });
      response = info.response;
    } catch (error) {
      throw classifySmtpError(error);
    }
    const id = typeof response === 'string' ? QUEUED_AS.exec(response)?.[1] : undefined;
    return id ? { providerMessageId: id } : {};
  }

  /** Closes idle connections (a spec or CLI that is about to exit). */
  close(): void {
    this.#transport.close();
  }
}

interface SmtpLibraryError {
  readonly code?: unknown;
  readonly responseCode?: unknown;
  readonly command?: unknown;
}

/** The port's error for a failed SMTP send. */
export function classifySmtpError(error: unknown): PermanentError | RetryableError {
  const { code, responseCode, command } = (
    typeof error === 'object' && error !== null ? error : {}
  ) as SmtpLibraryError;
  const step = typeof command === 'string' && command !== 'API' ? ` at ${command}` : '';
  if (typeof responseCode === 'number') {
    const text = `SMTP ${responseCode}${step}`;
    return responseCode >= 500
      ? new PermanentError(text, { cause: error })
      : new RetryableError(text, { cause: error });
  }
  // The library refuses an envelope it cannot build (no usable recipient) before any reply.
  if (code === 'EENVELOPE') return new PermanentError('SMTP envelope refused', { cause: error });
  const name = typeof code === 'string' ? code : 'error';
  return new RetryableError(`SMTP ${name}${step}`, { cause: error });
}
