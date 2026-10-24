// Value: protects=the @fisio/domain entry point exposes every WP0.2 module to api/web; fails_when=a module's re-export line is dropped from src/index.ts; why_new=specs import modules directly, contracts only reaches time and slot-id; seam=none; no_claim=behaviour of the exported functions
import { describe, expect, it } from 'vitest';
import * as domain from '../src/index';

describe('@fisio/domain public entry point', () => {
  it('re-exports SlotId, Clock, time helpers and the notification state machine', () => {
    expect(domain.SlotId.is('2027-03-28T09:00#pool')).toBe(true);
    expect(new domain.FixedClock('2027-03-28T07:00:00Z').now().toISOString()).toBe(
      '2027-03-28T07:00:00.000Z',
    );
    expect(domain.THERAPIST_TIME_ZONE).toBe('Europe/Rome');
    expect(domain.newPendingState(new Date('2027-03-28T07:00:00Z')).status).toBe('pending');
  });
});
