import { describe, expect, it } from 'vitest';
import { TABLE_DEFINITION, tableName } from '../lib/table-definition';

describe('Table definition: the single DynamoDB table (architecture §6.2, §6.4)', () => {
  // Value: protects=every stage gets its own fisio-<stage> table and a typo cannot name another; fails_when=tableName accepts empty, upper-case or spaced stages; why_new=no infra spec existed; seam=none; no_claim=the deployed table name (WP0.9 asserts it)
  it('names one table per stage, fisio-<stage>', () => {
    expect(tableName('dev')).toBe('fisio-dev');
    expect(tableName('prod')).toBe('fisio-prod');
    for (const bad of ['', 'Dev', 'my stage', '-dev', 'dev_1']) {
      expect(() => tableName(bad), bad).toThrow(RangeError);
    }
  });

  // Value: protects=the keys and indexes §6.2 relies on, on-demand billing and TTL (§6.4); fails_when=an index, key or the ttl attribute is renamed or dropped; why_new=the definition is plain data that CDK and create-table both read; seam=none; no_claim=PITR and deletion protection (stack properties, WP0.9)
  it('has PK/SK keys, GSI1 and GSI2, on-demand billing and TTL on ttl', () => {
    expect(TABLE_DEFINITION).toEqual({
      partitionKey: 'PK',
      sortKey: 'SK',
      globalSecondaryIndexes: [
        { name: 'GSI1', partitionKey: 'GSI1PK', sortKey: 'GSI1SK' },
        { name: 'GSI2', partitionKey: 'GSI2PK', sortKey: 'GSI2SK' },
      ],
      timeToLiveAttribute: 'ttl',
      billingMode: 'PAY_PER_REQUEST',
    });
  });
});
