import { FixedClock } from '@fisio/domain';
import { FakeChannel, freshTenant, TEST_TABLE, testDocumentClient } from '@fisio/testkit';
import { createTestEmulator, otpCodeIn } from '../src/testing';

/** The emulator for its own specs: a fresh pool on DynamoDB Local, a fixed clock, FakeChannel. */
export const SPEC_NOW = '2027-03-01T08:00:00.000Z';
export const THERAPIST_PASSWORD = 'una-password-lunga';

export function emulatorHarness() {
  const clock = new FixedClock(SPEC_NOW);
  const channel = new FakeChannel();
  const t = createTestEmulator({
    doc: testDocumentClient(),
    table: TEST_TABLE,
    clock,
    channel,
    config: { poolId: freshTenant(), tenantId: freshTenant() },
  });

  let next = 0;
  const email = (name: string) => `${name}-${++next}@example.test`;

  async function client(name = 'giulia') {
    return t.identity.createUser({ email: email(name), role: 'client' });
  }

  /** A therapist as the bootstrap CLI leaves one, after the setup link was used. */
  async function therapist() {
    const user = await t.identity.createUser({ email: email('terapista'), role: 'therapist' });
    await t.identity.setTotpPreference(user.userId, { enabled: true, preferred: true });
    const setupCode = await t.identity.startPasswordSetup(user.userId);
    const { secret } = await t.completeSetup(setupCode, THERAPIST_PASSWORD);
    return { ...user, secret };
  }

  /** The code of the latest OTP email to `to`. */
  const lastCode = (to: string) => otpCodeIn(channel.sentTo(to).at(-1));

  /** A code that is certainly not the one sent. */
  const wrongCode = (to: string) => {
    const code = lastCode(to);
    return `${(Number(code[0]) + 1) % 10}${code.slice(1)}`;
  };

  return { ...t, clock, channel, client, therapist, lastCode, wrongCode };
}
