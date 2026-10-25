import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProvider } from '@fisio/api/identity';
import { SettingsRepository } from '@fisio/api/repo/settings';
import { createLocalEmulator, LOCAL_SETUP_URL, LocalIdentityProvider } from '@fisio/auth-emulator';
import { DEFAULT_TENANT_ID, type TenantId, TenantIdSchema } from '@fisio/contracts';
import { systemClock } from '@fisio/domain';
import { tableName } from '@fisio/infra/table-definition';
import { type BootstrapDeps, bootstrapTherapist } from './bootstrap';

/**
 * `pnpm bootstrap:therapist --stage local|dev|prod --email <addr>` (docs/architecture.md §11.5),
 * for the single tenant (`main`, the `tenantId` claim the pool's trigger adds). `local` writes to
 * the emulator and the `fisio-local` table on DynamoDB Local; `dev` and `prod` use the stage's
 * Cognito pool (`COGNITO_USER_POOL_ID`, whose id names its region), its table and the SPA origin
 * (`WEB_ORIGIN`) with the caller's AWS credentials.
 */
export const BOOTSTRAP_STAGES = ['local', 'dev', 'prod'] as const;
export type BootstrapStage = (typeof BOOTSTRAP_STAGES)[number];

export interface BootstrapArgs {
  readonly stage: BootstrapStage;
  readonly email: string;
}

export const USAGE = 'Usage: pnpm bootstrap:therapist --stage local|dev|prod --email <address>';

/** The command line, or an error message naming what is wrong. */
export function parseBootstrapArgs(argv: readonly string[]): BootstrapArgs | { error: string } {
  let values: { stage?: string; email?: string };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        stage: { type: 'string' },
        email: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { error: (error as Error).message };
  }
  const stage = BOOTSTRAP_STAGES.find((name) => name === values.stage);
  if (!stage) return { error: '--stage must be local, dev or prod' };
  if (!values.email) return { error: '--email is required' };
  return { stage, email: values.email };
}

const TENANT_ID: TenantId = TenantIdSchema.parse(DEFAULT_TENANT_ID);

/** A pool id is `<region>_<id>`, so the pool, not the shell's default region, picks the region. */
const POOL_ID = /^([a-z]{2}(?:-[a-z]+)+-\d)_[A-Za-z0-9]+$/;

function adaptersFor(
  stage: BootstrapStage,
  env: NodeJS.ProcessEnv,
): { deps: BootstrapDeps; setupUrl: string; close(): void } {
  if (stage === 'local') {
    const { doc, store, config } = createLocalEmulator();
    return {
      deps: {
        identity: new LocalIdentityProvider(store, systemClock, config),
        settings: new SettingsRepository(doc, tableName('local')),
        clock: systemClock,
      },
      setupUrl: LOCAL_SETUP_URL,
      close: () => doc.destroy(),
    };
  }
  const poolId = env.COGNITO_USER_POOL_ID;
  const origin = env.WEB_ORIGIN;
  if (!poolId || !origin) {
    throw new Error(
      `--stage ${stage} needs COGNITO_USER_POOL_ID and WEB_ORIGIN in the environment`,
    );
  }
  const region = POOL_ID.exec(poolId)?.[1];
  if (!region) throw new Error(`COGNITO_USER_POOL_ID ${poolId} is not a user pool id`);
  if (new URL(origin).protocol !== 'https:') throw new Error('WEB_ORIGIN must be https');
  const cognito = new CognitoIdentityProviderClient({ region });
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return {
    deps: {
      identity: new CognitoIdentityProvider(cognito, poolId),
      settings: new SettingsRepository(doc, tableName(stage)),
      clock: systemClock,
    },
    setupUrl: new URL('/setup', origin).toString(),
    close: () => {
      cognito.destroy();
      doc.destroy();
    },
  };
}

/** Runs the CLI; returns the exit code. `print` receives every line of output. */
export async function runBootstrapCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  print: (line: string) => void,
): Promise<number> {
  const args = parseBootstrapArgs(argv);
  if ('error' in args) {
    print(`${args.error}\n${USAGE}`);
    return 2;
  }
  let adapters: ReturnType<typeof adaptersFor>;
  try {
    adapters = adaptersFor(args.stage, env);
  } catch (error) {
    print(`Bootstrap not started: ${(error as Error).message}`);
    return 2;
  }
  try {
    const result = await bootstrapTherapist(adapters.deps, {
      email: args.email,
      tenantId: TENANT_ID,
      setupUrl: adapters.setupUrl,
    });
    print(
      `Therapist ${result.email} ${result.created ? 'created' : 'already exists'} on ${args.stage} (user ${result.userId}).`,
    );
    if (result.reenabled) print('The account was disabled and has been enabled again.');
    print(`TOTP MFA preference: enabled and preferred. Settings: present for tenant ${TENANT_ID}.`);
    print(
      result.setupLink
        ? `Setup not finished. One-time link (choose the password, enrol TOTP); it replaces any earlier link:\n${result.setupLink}`
        : 'Password chosen and TOTP enrolled: no setup link.',
    );
    return 0;
  } catch (error) {
    print(`Bootstrap failed: ${(error as Error).message}`);
    return 1;
  } finally {
    adapters.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await runBootstrapCli(process.argv.slice(2), process.env, (line) =>
    console.log(line),
  );
}
