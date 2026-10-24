import { isIsoDate, isLocalTime, SLOT_TYPES, SlotId } from '@fisio/domain';
import { z } from 'zod';

/**
 * Base Zod schemas shared by the API (request/response validation, OpenAPI) and the web app.
 * Formats that the domain owns (dates, times, SlotId) delegate to the domain module, so there
 * is one definition of each.
 */

/** Client ids are the Cognito `sub`; booking and rule ids are generated UUIDs. */
export const ClientIdSchema = z.uuid().brand<'ClientId'>();
export const BookingIdSchema = z.uuid().brand<'BookingId'>();
export const RuleIdSchema = z.uuid().brand<'RuleId'>();
export type ClientId = z.infer<typeof ClientIdSchema>;
export type BookingId = z.infer<typeof BookingIdSchema>;
export type RuleId = z.infer<typeof RuleIdSchema>;

/** E.164: `+`, a non-zero country digit, 7 to 15 digits in all, no spaces or separators. */
export const PhoneE164Schema = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'Expected an E.164 phone number such as +393331234567');

/** Trimmed and lower-cased before validation, so one mailbox is one client. */
export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email());

/** A local calendar date, `yyyy-mm-dd`, that exists. */
export const IsoDateSchema = z.string().refine(isIsoDate, 'Expected a real date as yyyy-mm-dd');

/** A local wall-clock time, `HH:mm`, from 00:00 to 23:59. */
export const LocalTimeSchema = z.string().refine(isLocalTime, 'Expected a time as HH:mm');

/**
 * A UTC instant in the canonical `Date.toISOString()` form: `yyyy-mm-ddTHH:mm:ss.sssZ`, exactly
 * three fraction digits. Instants are stored and compared as strings in DynamoDB, and only one
 * fixed-width form sorts the same way as time.
 */
export const IsoDateTimeSchema = z.iso.datetime({ precision: 3 });

export const SlotTypeSchema = z.enum(SLOT_TYPES);

export const SlotIdSchema = z
  .string()
  .refine(SlotId.is, 'Expected a slot id such as 2027-03-28T09:00#pool')
  .transform((value) => value as SlotId);
