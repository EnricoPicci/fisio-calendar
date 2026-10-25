import { fileURLToPath } from 'node:url';
import { ClientRepository } from '@fisio/api/repo/clients';
import { SettingsRepository } from '@fisio/api/repo/settings';
import { createLocalEmulator, LOCAL_SETUP_URL, LocalIdentityProvider } from '@fisio/auth-emulator';
import { completeSetup } from '@fisio/auth-emulator/testing';
import { bootstrapTherapist } from '@fisio/bootstrap';
import {
  ClientIdSchema,
  type ClientStatus,
  DEFAULT_TENANT_ID,
  type TenantId,
  TenantIdSchema,
} from '@fisio/contracts';
import { type Clock, type IdentityProvider, systemClock } from '@fisio/domain';
import { tableName } from '@fisio/infra/table-definition';

/**
 * `pnpm seed` (docs/architecture.md §11.4): the therapist through the same bootstrap code as
 * every stage, with the setup completed so the printed password and TOTP secret work at once,
 * then a dozen clients (identity user + client item). Rules and slots arrive with WP1.2.
 * Idempotent: a re-run finds what exists and changes nothing.
 */
export const SEED_THERAPIST_EMAIL = 'terapista@fisio.test';
/** Local only: DynamoDB Local is in memory, and `pnpm local:down` forgets it. */
export const SEED_THERAPIST_PASSWORD = 'fisio-locale-2027';

interface SeedClient {
  readonly name: string;
  readonly email: string;
  readonly phone?: string;
  readonly status: ClientStatus;
}

export const SEED_CLIENTS: readonly SeedClient[] = [
  {
    name: 'Giulia Bianchi',
    email: 'giulia.bianchi@fisio.test',
    phone: '+393331000001',
    status: 'enabled',
  },
  {
    name: 'Marco Rossi',
    email: 'marco.rossi@fisio.test',
    phone: '+393331000002',
    status: 'enabled',
  },
  { name: 'Francesca Romano', email: 'francesca.romano@fisio.test', status: 'enabled' },
  {
    name: 'Luca Ferrari',
    email: 'luca.ferrari@fisio.test',
    phone: '+393331000004',
    status: 'enabled',
  },
  { name: 'Chiara Esposito', email: 'chiara.esposito@fisio.test', status: 'enabled' },
  {
    name: 'Alessandro Ricci',
    email: 'alessandro.ricci@fisio.test',
    phone: '+393331000006',
    status: 'enabled',
  },
  { name: 'Sara Marino', email: 'sara.marino@fisio.test', status: 'enabled' },
  {
    name: 'Davide Greco',
    email: 'davide.greco@fisio.test',
    phone: '+393331000008',
    status: 'enabled',
  },
  { name: 'Elena Bruno', email: 'elena.bruno@fisio.test', status: 'enabled' },
  {
    name: 'Matteo Gallo',
    email: 'matteo.gallo@fisio.test',
    phone: '+393331000010',
    status: 'enabled',
  },
  { name: 'Valentina Conti', email: 'valentina.conti@fisio.test', status: 'invited' },
  {
    name: 'Paolo De Luca',
    email: 'paolo.deluca@fisio.test',
    phone: '+393331000012',
    status: 'blocked',
  },
];

export interface SeedDeps {
  readonly identity: IdentityProvider;
  readonly clients: ClientRepository;
  readonly settings: { create(tenantId: TenantId, now: Date): Promise<void> };
  readonly clock: Clock;
  readonly tenantId: TenantId;
  /** Uses the bootstrap setup link: password, then TOTP enrolment; returns the TOTP secret. */
  completeSetup(code: string, password: string): Promise<{ secret: string; otpauthUri: string }>;
}

export interface SeedReport {
  readonly therapist: {
    readonly email: string;
    /** Only when this run completed the setup; a re-run cannot read the secret back. */
    readonly credentials?: { password: string; totpSecret: string; otpauthUri: string };
  };
  readonly clients: readonly { email: string; status: ClientStatus }[];
}

export async function seedLocal(deps: SeedDeps): Promise<SeedReport> {
  const result = await bootstrapTherapist(deps, {
    email: SEED_THERAPIST_EMAIL,
    tenantId: deps.tenantId,
    setupUrl: LOCAL_SETUP_URL,
  });
  let credentials: SeedReport['therapist']['credentials'];
  if (result.setupLink) {
    const code = new URLSearchParams(new URL(result.setupLink).hash.slice(1)).get('code') ?? '';
    const { secret, otpauthUri } = await deps.completeSetup(code, SEED_THERAPIST_PASSWORD);
    credentials = { password: SEED_THERAPIST_PASSWORD, totpSecret: secret, otpauthUri };
  }

  for (const seed of SEED_CLIENTS) {
    const user =
      (await deps.identity.findUserByEmail(seed.email)) ??
      (await deps.identity.createUser({ email: seed.email, role: 'client' }));
    if (seed.status === 'blocked' && user.enabled) await deps.identity.disableUser(user.userId);
    const clientId = ClientIdSchema.parse(user.userId);
    if (await deps.clients.get(deps.tenantId, clientId)) continue;
    await deps.clients.put(deps.tenantId, {
      clientId,
      name: seed.name,
      email: seed.email,
      ...(seed.phone ? { phone: seed.phone } : {}),
      status: seed.status,
      locale: 'it',
      createdAt: deps.clock.now().toISOString(),
    });
  }
  return {
    therapist: { email: SEED_THERAPIST_EMAIL, ...(credentials ? { credentials } : {}) },
    clients: SEED_CLIENTS.map(({ email, status }) => ({ email, status })),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { doc, store, config, emulator } = createLocalEmulator();
  const table = tableName('local');
  try {
    const report = await seedLocal({
      identity: new LocalIdentityProvider(store, systemClock, config),
      clients: new ClientRepository(doc, table),
      settings: new SettingsRepository(doc, table),
      clock: systemClock,
      tenantId: TenantIdSchema.parse(DEFAULT_TENANT_ID),
      completeSetup: (code, password) => completeSetup(emulator, systemClock, code, password),
    });
    const { credentials } = report.therapist;
    console.log(`Therapist: ${report.therapist.email}`);
    console.log(
      credentials
        ? `  password ${credentials.password}\n  TOTP secret ${credentials.totpSecret}\n  ${credentials.otpauthUri}`
        : '  already set up (the secret was printed by the first seed; `pnpm local:down && pnpm local:up` resets it)',
    );
    console.log(`Clients (sign in with the one-time code printed by the auth emulator):`);
    for (const client of report.clients) console.log(`  ${client.email} (${client.status})`);
  } catch (error) {
    console.error(`Seed failed: ${String(error)}. Is the local stack running (\`pnpm local:up\`)?`);
    process.exitCode = 1;
  } finally {
    doc.destroy();
  }
}
