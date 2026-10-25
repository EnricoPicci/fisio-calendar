import {
  ISO_DATE_SHAPE,
  isIsoDate,
  isLocalTime,
  LOCAL_TIME_SHAPE,
  SLOT_ID_SHAPE,
  SLOT_TYPES,
  SlotId,
} from '@fisio/domain';
import { z } from 'zod';

/**
 * Base Zod schemas shared by the API (request/response validation, OpenAPI) and the web app.
 * Formats that the domain owns (dates, times, SlotId) delegate to the domain module, so there
 * is one definition of each. A refinement is invisible to OpenAPI, so each refined format also
 * carries the domain's shape as a `regex` (the published `pattern`) and an example (`.meta`).
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
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email())
  // The pipe hides the format from the OpenAPI generator; state it for the SPA's types.
  .meta({ format: 'email', example: 'cliente@example.com' });

/** A local calendar date, `yyyy-mm-dd`, that exists, in years 1900–9999 (`MIN_YEAR`–`MAX_YEAR`). */
export const IsoDateSchema = z
  .string()
  .regex(ISO_DATE_SHAPE)
  .refine(isIsoDate, 'Expected a real date as yyyy-mm-dd in a supported year')
  .meta({ id: 'IsoDate', example: '2027-03-28' });

/** A local wall-clock time, `HH:mm`, from 00:00 to 23:59. */
export const LocalTimeSchema = z
  .string()
  .regex(LOCAL_TIME_SHAPE)
  .refine(isLocalTime, 'Expected a time as HH:mm')
  .meta({ id: 'LocalTime', example: '09:00' });

/**
 * A UTC instant in the canonical `Date.toISOString()` form: `yyyy-mm-ddTHH:mm:ss.sssZ`, exactly
 * three fraction digits, with a date that `IsoDateSchema` accepts. Instants are stored and
 * compared as strings in DynamoDB, and only one fixed-width form sorts the same way as time.
 */
export const IsoDateTimeSchema = z.iso
  .datetime({ precision: 3 })
  .refine((value) => isIsoDate(value.slice(0, 10)), 'Expected a real date in a supported year');

export const SlotTypeSchema = z.enum(SLOT_TYPES);

/**
 * A slot id from a request: well formed, and its start exists in Rome (not in a DST gap). The
 * refinement never throws: `startExists` answers false for a malformed id, and a runtime without
 * Europe/Rome tz data is refused when the API starts. In a URL path the id travels as
 * `SlotId.toPathSegment(id)`; Hono decodes the param before this schema sees it.
 */
export const SlotIdSchema = z
  .string()
  .regex(SLOT_ID_SHAPE)
  .refine(
    (value) => SlotId.startExists(value),
    'Expected a slot id such as 2027-03-28T09:00#pool, with a start that exists in Europe/Rome',
  )
  .transform((value) => value as SlotId)
  .meta({ id: 'SlotId', example: '2027-03-28T09:00#pool' });

/**
 * The therapist's tenant id: the `tenantId` token claim and the `T#<tid>` key prefix (§6.2).
 * Letters, digits and dashes only, so it can never put a `#` into a key.
 */
export const TenantIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/)
  .brand<'TenantId'>();
export type TenantId = z.infer<typeof TenantIdSchema>;

/** A client's lifecycle (§3.1): `invited` → `enabled` ⇄ `blocked`; only `enabled` may call the API. */
export const CLIENT_STATUSES = ['invited', 'enabled', 'blocked'] as const;
export const ClientStatusSchema = z.enum(CLIENT_STATUSES);
export type ClientStatus = z.infer<typeof ClientStatusSchema>;

export const ROLES = ['client', 'therapist'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/** UI locales; v1 ships Italian only (TODOS.md: English UI). */
export const LocaleSchema = z.enum(['it']);
export type Locale = z.infer<typeof LocaleSchema>;
