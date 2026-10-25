import { type SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  errorName,
  isSingleMailbox,
  NOTIFICATION_KEY_HEADER,
  type NotificationChannel,
  type OutboundMessage,
  PermanentError,
  RetryableError,
  type SendResult,
} from '@fisio/domain';

/**
 * The email channel in the cloud (docs/architecture.md §5.4): SES v2 `SendEmail` with a simple
 * message (subject, text and HTML bodies), sent through the configuration set that publishes
 * bounces and complaints. Unit-tested against a recording client; the shared contract spec runs
 * it against the `dev` SES sandbox (`pnpm test:cloud:email`, WP0.10).
 *
 * Errors follow the port. SES refusing this message (rejected content, a bad request) is a
 * `PermanentError`. Throttling, quota and server faults, account and configuration faults (a
 * suspended account, an unverified domain, a missing configuration set: fixed by the operator,
 * not by the message), and anything unknown, are a `RetryableError`. The message
 * names the SES error only: SES messages can carry the recipient or ARNs, and the notifier stores
 * the text (`lastError`). The SDK error is kept as `cause`.
 */
export type SesClient = Pick<SESv2Client, 'send'>;

export interface SesEmailChannelOptions {
  readonly from: { readonly name: string; readonly address: string };
  readonly configurationSet?: string;
}

/** SES v2 errors that mean "this message will never be accepted as it is". */
const PERMANENT_SES_ERRORS = new Set(['MessageRejected', 'BadRequestException']);

export class SesEmailChannel implements NotificationChannel {
  readonly channel = 'email' as const;

  constructor(
    private readonly ses: SesClient,
    private readonly options: SesEmailChannelOptions,
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    if (!isSingleMailbox(message.to)) {
      throw new PermanentError('SES recipient is not a single address');
    }
    let messageId: unknown;
    try {
      const output = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: formatAddress(this.options.from),
          Destination: { ToAddresses: [message.to] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: message.text, Charset: 'UTF-8' },
                ...(message.html !== undefined
                  ? { Html: { Data: message.html, Charset: 'UTF-8' } }
                  : {}),
              },
              Headers: [{ Name: NOTIFICATION_KEY_HEADER, Value: message.notificationKey }],
            },
          },
          ...(this.options.configurationSet
            ? { ConfigurationSetName: this.options.configurationSet }
            : {}),
        }),
      );
      messageId = output.MessageId;
    } catch (error) {
      throw classifySesError(error);
    }
    return typeof messageId === 'string' && messageId.trim()
      ? { providerMessageId: messageId }
      : {};
  }
}

/** The port's error for a failed `SendEmail`. */
export function classifySesError(error: unknown): PermanentError | RetryableError {
  const name = errorName(error) ?? 'unknown error';
  const text = `SES ${name}`;
  return PERMANENT_SES_ERRORS.has(name)
    ? new PermanentError(text, { cause: error })
    : new RetryableError(text, { cause: error });
}

/**
 * `"Name" <address>`, with the display name quoted so a comma or angle bracket stays inside it.
 * SES takes only ASCII there: a name with an accent goes as an RFC 2047 encoded word.
 */
function formatAddress(from: SesEmailChannelOptions['from']): string {
  const name = from.name.replace(/["\\\r\n]/g, '');
  if (!name) return from.address;
  if (/^[\x20-\x7e]*$/.test(name)) return `"${name}" <${from.address}>`;
  return `=?UTF-8?B?${Buffer.from(name, 'utf8').toString('base64')}?= <${from.address}>`;
}
