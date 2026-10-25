import { NOTIFICATION_KEY_HEADER, PermanentError, RetryableError } from '@fisio/domain';
import { describe, expect, it } from 'vitest';
import { type SesClient, SesEmailChannel } from '../../src/notify/ses-email-channel';

/**
 * The SES adapter against a recording client: the `SendEmail` request it builds and how it maps
 * SES errors. SES's real behaviour is the contract spec's job on `dev` (`pnpm test:cloud:email`,
 * WP0.10).
 */
function recordingSes(answer: () => unknown = () => ({ MessageId: 'ses-0100' })) {
  const sent: { command: string; input: Record<string, unknown> }[] = [];
  const client: SesClient = {
    send: (async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ command: command.constructor.name, input: command.input });
      return answer();
    }) as SesClient['send'],
  };
  return { client, sent };
}

const message = {
  channel: 'email' as const,
  notificationKey: 'INVITE#c1#1',
  to: 'giulia@example.test',
  subject: 'Il tuo invito a Fisio Calendar',
  text: 'Ciao Giulia',
  html: '<p>Ciao Giulia</p>',
};

const sesError = (name: string) => () => {
  throw Object.assign(new Error(`${name}: Email address is not verified: giulia@example.test`), {
    name,
  });
};

describe('SesEmailChannel: the NotificationChannel port on SES v2 (architecture §5.4)', () => {
  // Value: protects=the email goes from our sender, to the one recipient, with both bodies in UTF-8, the outbox key header and the configuration set that reports bounces; fails_when=the HTML body, header or configuration set is dropped, or the sender's display name can break the From header; why_new=first SES adapter; seam=recording client; no_claim=SES accepting it (contract spec on dev)
  it('sends a simple message through the configuration set and returns the SES message id', async () => {
    const { client, sent } = recordingSes();
    const channel = new SesEmailChannel(client, {
      from: { name: 'Studio "Anna"', address: 'noreply@fisio.example' },
      configurationSet: 'fisio-dev',
    });
    expect(await channel.send(message)).toEqual({ providerMessageId: 'ses-0100' });
    expect(sent).toEqual([
      {
        command: 'SendEmailCommand',
        input: {
          FromEmailAddress: '"Studio Anna" <noreply@fisio.example>',
          Destination: { ToAddresses: ['giulia@example.test'] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: 'Ciao Giulia', Charset: 'UTF-8' },
                Html: { Data: '<p>Ciao Giulia</p>', Charset: 'UTF-8' },
              },
              Headers: [{ Name: NOTIFICATION_KEY_HEADER, Value: 'INVITE#c1#1' }],
            },
          },
          ConfigurationSetName: 'fisio-dev',
        },
      },
    ]);
  });

  // Value: protects=an Italian sender name with an accent reaches SES encoded, so SES does not refuse every email; fails_when=a non-ASCII display name is sent raw (SES answers BadRequestException, which fails each notification at once); why_new=red-team finding in the WP0.6 review; seam=recording client; no_claim=how mail clients display it
  it('encodes a display name with non-ASCII characters (RFC 2047)', async () => {
    const { client, sent } = recordingSes();
    const channel = new SesEmailChannel(client, {
      from: { name: 'Studio Lucìa', address: 'noreply@fisio.example' },
    });
    await channel.send(message);
    const from = sent[0]?.input.FromEmailAddress as string;
    expect(from).toBe(
      `=?UTF-8?B?${Buffer.from('Studio Lucìa').toString('base64')}?= <noreply@fisio.example>`,
    );
    expect(from).toMatch(/^[\x20-\x7e]+$/);
  });

  // Value: protects=SES gets one plain mailbox, like SMTP (the shared contract's rule), so a list or a display name in a stored address can never reach several recipients; fails_when=the SES adapter passes `to` through unchecked; why_new=WP0.6 review (contract parity before the SES contract run in WP0.10); seam=recording client; no_claim=SES's own address syntax checks
  it('refuses a recipient that is not a single plain address, without calling SES', async () => {
    const { client, sent } = recordingSes();
    const channel = new SesEmailChannel(client, {
      from: { name: 'F', address: 'n@fisio.example' },
    });
    for (const to of ['Giulia <g@example.test>', 'a@example.test, b@example.test', 'a b@x.test']) {
      await expect(channel.send({ ...message, to }), to).rejects.toBeInstanceOf(PermanentError);
    }
    expect(sent).toEqual([]);
  });

  // Value: protects=an accepted message without a usable id is still sent, and no id is invented; fails_when=the adapter returns a blank or non-string id; why_new=architecture §5.4 rule for adapters; seam=recording client; no_claim=none
  it('returns no id when SES returns none or a blank one', async () => {
    for (const output of [{}, { MessageId: ' ' }, { MessageId: 42 }]) {
      const { client } = recordingSes(() => output);
      const channel = new SesEmailChannel(client, {
        from: { name: '', address: 'n@fisio.example' },
      });
      expect(await channel.send(message)).toEqual({});
    }
  });

  // Value: protects=SES refusals that will never succeed fail the notification at once, throttling and faults are retried, and the stored error names the SES error only, never the recipient SES echoes; fails_when=MessageRejected or a bad request is retried five times, throttling fails an invitation, or the SES message text reaches lastError; why_new=TODOS "Notifier edge cases" (one spec per SES error name); seam=recording client throwing named errors; no_claim=errors SES adds later (unknown names are retried)
  it('classifies SES errors by name, with only the name in the message', async () => {
    const cases: [string, typeof PermanentError | typeof RetryableError][] = [
      ['MessageRejected', PermanentError],
      ['BadRequestException', PermanentError],
      // Account and configuration faults are not the message's fault: retried while fixed.
      ['MailFromDomainNotVerifiedException', RetryableError],
      ['NotFoundException', RetryableError],
      ['AccountSuspendedException', RetryableError],
      ['TooManyRequestsException', RetryableError],
      ['LimitExceededException', RetryableError],
      ['SendingPausedException', RetryableError],
      ['ThrottlingException', RetryableError],
      ['InternalFailure', RetryableError],
      ['TimeoutError', RetryableError],
    ];
    for (const [name, kind] of cases) {
      const { client } = recordingSes(sesError(name));
      const channel = new SesEmailChannel(client, {
        from: { name: 'F', address: 'n@fisio.example' },
      });
      const error = await channel.send(message).catch((e: unknown) => e);
      expect(error, name).toBeInstanceOf(kind);
      expect((error as Error).message, name).toBe(`SES ${name}`);
      expect((error as Error).cause, name).toMatchObject({ name });
    }
  });
});
