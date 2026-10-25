import { z } from 'zod';
import { ERROR_CODES, type ErrorCode, PROBLEM_TYPE_PREFIX } from './errors';
import {
  ClientIdSchema,
  ClientStatusSchema,
  EmailSchema,
  IsoDateTimeSchema,
  LocaleSchema,
  PhoneE164Schema,
} from './schemas';

/**
 * Request and response bodies of the API (docs/architecture.md §5.2), shared with the SPA. The
 * API declares its routes with these schemas, so they validate at runtime and generate
 * `docs/openapi.json`; the SPA's typed client is generated from that document.
 */

/** Where a rejected value was: the request part, then the path inside it. */
export const VALIDATION_LOCATIONS = ['body', 'query', 'path', 'header'] as const;

export const ValidationIssueSchema = z
  .object({
    in: z.enum(VALIDATION_LOCATIONS),
    path: z.array(z.union([z.string(), z.number()])),
    /** The Zod issue code (`invalid_type`, `too_small`, `custom`, …), never a sentence. */
    code: z.string(),
  })
  .meta({ id: 'ValidationIssue' });
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/**
 * RFC 9457 problem details. `type` is `urn:fisio:error:<code>`, and `code` repeats the code so a
 * client need not parse the URN. `errors` is present for `validation_failed` only.
 */
export const ProblemSchema = z
  .object({
    type: z.templateLiteral([PROBLEM_TYPE_PREFIX, z.enum(ERROR_CODES as [ErrorCode])]),
    code: z.enum(ERROR_CODES as [ErrorCode]),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    errors: z.array(ValidationIssueSchema).optional(),
  })
  .meta({ id: 'Problem' });
export type Problem = z.infer<typeof ProblemSchema>;

export const PROBLEM_MEDIA_TYPE = 'application/problem+json';

export const HealthResponseSchema = z.object({ status: z.literal('ok') }).meta({ id: 'Health' });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ClientProfileSchema = z
  .object({
    role: z.literal('client'),
    clientId: ClientIdSchema,
    name: z.string(),
    email: EmailSchema,
    phone: PhoneE164Schema.optional(),
    locale: LocaleSchema,
  })
  .meta({ id: 'ClientProfile' });

/** The therapist's profile; the settings relevant to her arrive with WP1.1. */
export const TherapistProfileSchema = z
  .object({
    role: z.literal('therapist'),
    therapistId: z.uuid(),
  })
  .meta({ id: 'TherapistProfile' });

/** `GET /me`: who the caller is, by role. */
export const MeResponseSchema = z
  .discriminatedUnion('role', [ClientProfileSchema, TherapistProfileSchema])
  .meta({ id: 'Me' });
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** `POST /admin/clients` (T7): the therapist adds a client, who is invited by email. */
export const AddClientRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    email: EmailSchema,
    phone: PhoneE164Schema.optional(),
  })
  .strict()
  .meta({ id: 'AddClientRequest' });
export type AddClientRequest = z.infer<typeof AddClientRequestSchema>;

/** A client as the therapist sees it. */
export const AdminClientSchema = z
  .object({
    clientId: ClientIdSchema,
    name: z.string(),
    email: EmailSchema,
    phone: PhoneE164Schema.optional(),
    status: ClientStatusSchema,
    invitedAt: IsoDateTimeSchema.optional(),
    createdAt: IsoDateTimeSchema,
  })
  .meta({ id: 'AdminClient' });
export type AdminClient = z.infer<typeof AdminClientSchema>;
