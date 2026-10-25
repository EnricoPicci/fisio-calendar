import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import {
  NOTIFICATION_KEY_HEADER,
  type NotificationChannel,
  type OutboundMessage,
  PermanentError,
  RetryableError,
} from '@fisio/domain';
import { classifySmtpError, SmtpEmailChannel } from '@fisio/local/smtp';
import { mailpitMessage } from '@fisio/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * NotificationChannel.contract (docs/architecture.md §10.4 group F, §11.4): one set of specs every
 * email channel must pass, so local delivery through Mailpit stays a faithful stand-in for SES.
 * It runs against `SmtpEmailChannel` and Mailpit on every `pnpm test`; WP0.10 adds the
 * `SesEmailChannel` target on the `dev` SES sandbox behind `pnpm test:cloud:email`.
 */
export interface DeliveredMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
}

export interface ChannelContractTarget {
  readonly channel: NotificationChannel;
  /** A fresh address the provider delivers to. */
  goodAddress(): string;
  /** An address the provider refuses for good. */
  readonly badAddress: string;
  /** The channel facing a provider that is throttling; `close` ends the situation. */
  throttled(): Promise<{ channel: NotificationChannel; close(): Promise<void> }>;
  /** What the provider recorded for the message it accepted under this id. */
  delivered(providerMessageId: string): Promise<DeliveredMessage>;
}

const message = (to: string): OutboundMessage => ({
  channel: 'email',
  notificationKey: `INVITE#${randomUUID()}#1`,
  to,
  subject: 'Il tuo invito a Fisio Calendar',
  text: 'Ciao Giulia,\nè necessario un codice: 12345678',
  html: '<p>Ciao Giulia, è necessario un codice: <b>12345678</b></p>',
});

export function describeNotificationChannelContract(
  name: string,
  target: () => Promise<ChannelContractTarget>,
): void {
  describe(`NotificationChannel.contract (${name}): send succeeds, bad address is PermanentError, throttle is RetryableError`, () => {
    let t: ChannelContractTarget;
    beforeAll(async () => {
      t = await target();
    });

    // Value: protects=an accepted message reaches the provider with recipient, subject, both bodies (UTF-8) and the outbox key header, and the id returned finds it there; fails_when=the adapter drops the HTML body or the header, mangles accented text, or returns an id the provider does not know; why_new=first contract; seam=the provider's own record (Mailpit API / SES dev); no_claim=inbox placement (dev smoke)
    it('send succeeds and the provider records the message under the returned id', async () => {
      const to = t.goodAddress();
      const sent = message(to);
      const { providerMessageId } = await t.channel.send(sent);
      expect(providerMessageId).toEqual(expect.any(String));
      const delivered = await t.delivered(providerMessageId ?? '');
      expect(delivered.to).toEqual([to]);
      expect(delivered.subject).toBe(sent.subject);
      // Email bodies travel with CRLF line ends.
      expect(delivered.text.replaceAll('\r\n', '\n').trim()).toBe(sent.text);
      expect(delivered.html).toContain('<b>12345678</b>');
      expect(delivered.headers[NOTIFICATION_KEY_HEADER]).toEqual([sent.notificationKey]);
    });

    // Value: protects=an address the provider refuses fails the notification at once, and the error text carries no address (it is stored as lastError); fails_when=the refusal is classified retryable (five useless retries) or its message echoes the recipient; why_new=first contract; seam=none; no_claim=bounces after acceptance (SES feedback, WP2.5)
    it('bad address is PermanentError, without the address in its message', async () => {
      const failure = await t.channel.send(message(t.badAddress)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PermanentError);
      expect((failure as Error).message).not.toContain(t.badAddress);
    });

    // Value: protects=a recipient that reads as a list or a display name is refused, never re-parsed into another mailbox; fails_when=the adapter hands the raw string to a library that splits `x y@z` into `y@z` (seen with nodemailer) or `a@x, b@y` into two recipients; why_new=probe of nodemailer's address parsing; seam=none; no_claim=address syntax in general (EmailSchema)
    it('a recipient with a space, comma or angle bracket is PermanentError', async () => {
      for (const to of [
        'giulia bianchi@example.test',
        `${t.goodAddress()}, ${t.goodAddress()}`,
        '<a@example.test>',
      ]) {
        await expect(t.channel.send(message(to)), to).rejects.toBeInstanceOf(PermanentError);
      }
    });

    // Value: protects=a provider asking to slow down makes the notifier retry later, not give up; fails_when=a throttling reply is classified permanent; why_new=first contract; seam=the target's throttling situation (an SMTP server answering 451 / SES throttling); no_claim=the back-off schedule (notifier spec)
    it('throttle is RetryableError', async () => {
      const throttled = await t.throttled();
      try {
        await expect(throttled.channel.send(message(t.goodAddress()))).rejects.toBeInstanceOf(
          RetryableError,
        );
      } finally {
        await throttled.close();
      }
    });
  });
}

/** An SMTP server that greets, then answers every recipient with 451 (rate limited). */
async function throttlingSmtpServer(): Promise<Server> {
  const server = createServer((socket) => {
    socket.write('220 throttle.test ESMTP\r\n');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (let end = buffer.indexOf('\r\n'); end >= 0; end = buffer.indexOf('\r\n')) {
        const command = buffer.slice(0, end).toUpperCase();
        buffer = buffer.slice(end + 2);
        if (command.startsWith('EHLO')) socket.write('250-throttle.test\r\n250 OK\r\n');
        else if (command.startsWith('RCPT'))
          socket.write('451 4.7.1 Rate limited, try again later\r\n');
        else if (command.startsWith('QUIT')) socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

const smtp = new SmtpEmailChannel();
afterAll(() => smtp.close());

describeNotificationChannelContract('SmtpEmailChannel on Mailpit', async () => ({
  channel: smtp,
  goodAddress: () => `contratto-${randomUUID()}@example.test`,
  // Mailpit refuses it at RCPT TO with 553 (not an RFC 5321 address).
  badAddress: 'contratto@',
  async throttled() {
    const server = await throttlingSmtpServer();
    const channel = new SmtpEmailChannel({ port: (server.address() as AddressInfo).port });
    return {
      channel,
      close: async () => {
        channel.close();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  },
  delivered: (id) => mailpitMessage(id),
}));

describe('SmtpEmailChannel: an unreachable SMTP server (architecture §11.4)', () => {
  // Value: protects=a stopped Mailpit makes local deliveries retry instead of failing them for good; fails_when=a connection error is classified permanent; why_new=first SMTP adapter; seam=a closed port; no_claim=timeouts (same classification)
  it('a refused connection is RetryableError', async () => {
    const server = await throttlingSmtpServer();
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    const channel = new SmtpEmailChannel({ port, timeoutMs: 1_000 });
    await expect(channel.send(message('a@example.test'))).rejects.toBeInstanceOf(RetryableError);
    channel.close();
  });

  // Value: protects=an envelope nodemailer refuses before any reply fails for good, and replies and connection codes keep their class; fails_when=the EENVELOPE branch is dropped (five useless retries) or a 4xx reply reads as permanent; why_new=ship review (branches Mailpit cannot reach); seam=library-shaped error objects; no_claim=which codes nodemailer raises
  it('classifies library errors by envelope, reply code and connection code', () => {
    expect(classifySmtpError({ code: 'EENVELOPE' })).toBeInstanceOf(PermanentError);
    expect(classifySmtpError({ responseCode: 550, command: 'RCPT TO' })).toBeInstanceOf(
      PermanentError,
    );
    expect(classifySmtpError({ responseCode: 452, command: 'RCPT TO' })).toBeInstanceOf(
      RetryableError,
    );
    expect(classifySmtpError({ code: 'ETIMEDOUT', command: 'CONN' })).toBeInstanceOf(
      RetryableError,
    );
  });
});
