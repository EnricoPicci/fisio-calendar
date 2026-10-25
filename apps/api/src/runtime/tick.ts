import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { IsoDateTimeSchema } from '@fisio/contracts';
import { type Clock, systemClock } from '@fisio/domain';
import { SmtpEmailChannel } from '@fisio/local/smtp';
import { localDynamoClient } from '@fisio/local/table';
import { loadConfig } from '../config';
import { NotificationRepository } from '../repo/notifications';
import { LOCAL_DEFAULTS, LOCAL_TENANT_ID, localNotifierAt, localTick } from './local';

/**
 * `pnpm tick [--now <iso>]` (docs/architecture.md §11.4): one run of the real jobs tick on the
 * local stack at a chosen instant (default: now), with the notifier in-process and email to
 * Mailpit. The instant is a UTC ISO string such as `2027-03-27T18:00:00.000Z`.
 */
export const USAGE = 'usage: pnpm tick [--now <yyyy-mm-ddTHH:mm:ss.sssZ>]';

export function parseTickArgs(args: readonly string[], clock: Clock = systemClock): Date {
  const { values } = parseArgs({
    args: [...args],
    options: { now: { type: 'string' } },
    strict: true,
  });
  if (values.now === undefined) return clock.now();
  const parsed = IsoDateTimeSchema.safeParse(values.now);
  if (!parsed.success) throw new RangeError(`--now must be a UTC instant\n${USAGE}`);
  return new Date(parsed.data);
}

const ENV_FILE = fileURLToPath(new URL('../../../../.env.local', import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let now: Date;
  try {
    // pnpm passes a `--` separator through when the user typed one.
    now = parseTickArgs(process.argv.slice(2).filter((arg) => arg !== '--'));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
  if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
  const config = loadConfig({ ...LOCAL_DEFAULTS, ...process.env });
  const doc = DynamoDBDocumentClient.from(localDynamoClient(config.dynamoEndpoint), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const channel = new SmtpEmailChannel();
  const notifications = new NotificationRepository(doc, config.tableName);
  try {
    const report = await localTick({
      now,
      tenantId: LOCAL_TENANT_ID,
      notifierAt: localNotifierAt(notifications, channel),
    });
    console.log(`tick at ${now.toISOString()}: ran ${report.ran.join(', ') || 'nothing'}`);
  } catch (error) {
    console.error('tick failed', error);
    process.exitCode = 1;
  } finally {
    channel.close();
    doc.destroy();
  }
}
