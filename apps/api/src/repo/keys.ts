import type { ClientId, TenantId } from '@fisio/contracts';

/**
 * DynamoDB key values (docs/architecture.md §6.2). This folder is the only place that builds
 * them (CLAUDE.md convention 3), always from typed domain ids, never from raw request strings.
 */
export function tenantPk(tenantId: TenantId): string {
  return `T#${tenantId}`;
}

export function clientSk(clientId: ClientId): string {
  return `CLIENT#${clientId}`;
}

export const SETTINGS_SK = 'SETTINGS';

/** GSI2: clients by email, for the uniqueness check on add and the lookup by email. */
export function clientEmailGsi2(email: string): { GSI2PK: string; GSI2SK: string } {
  return { GSI2PK: `EMAIL#${email}`, GSI2SK: 'CLIENT' };
}
