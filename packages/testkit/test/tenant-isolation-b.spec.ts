import { describe } from 'vitest';
import { tenantIsolationSpec } from './tenant-isolation';

describe('Local DynamoDB: per-spec tenant isolation (file B)', () => {
  tenantIsolationSpec('tenant-isolation-b');
});
