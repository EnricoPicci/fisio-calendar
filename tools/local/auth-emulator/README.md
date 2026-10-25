# @fisio/auth-emulator

The local stand-in for Cognito (architecture §11.4, D15, D27). It has two faces:

- **`LocalIdentityProvider`**: the `IdentityProvider` port (`packages/domain/src/identity.ts`) on
  DynamoDB Local, the counterpart of `CognitoIdentityProvider` in `apps/api`. Both run
  `apps/api/test/identity/IdentityProvider.contract.spec.ts`.
- **`AuthEmulator`**: the sign-in flows the SPA runs against Cognito, issuing RS256 tokens with
  Cognito's claims (`token_use`, `client_id`, `cognito:groups`, plus `role` and `tenantId`).

| Rule | Value |
|---|---|
| Client one-time code | 8 digits, valid 5 minutes, sent through the `NotificationChannel` |
| Unknown, blocked or therapist email on the code flow | same answer, no code sent, then `code_mismatch` |
| Lockout | 5 wrong codes or passwords for one email within 15 minutes → `too_many_attempts` for 15 minutes; a successful sign-in resets the count; concurrent guesses all count |
| Single use | every sign-in session, setup code and TOTP code works once, also under concurrent answers (a TOTP code already used, at sign-in or enrolment, is `code_mismatch`) |
| Therapist | password, then `SOFTWARE_TOKEN_MFA` while the TOTP preference is enabled |
| Setup code (bootstrap link, in the URL fragment) | one live code per user, 7 days, sets the password (12+ characters) and enrols TOTP; a replaced code, or a second session on a spent one, cannot finish |
| Tokens | access and ID 60 minutes; refresh 30 days (client) / 7 days (therapist), rotated on use with the first sign-in's expiry; refused after a disable (also once enabled again) or a global sign-out |

Failures are `AuthErrorCode`s (`packages/contracts/src/auth.ts`).

## HTTP (`pnpm dev`, `http://127.0.0.1:9100/local`)

All `POST` bodies are JSON (`content-type: application/json`); a refused step answers
`400 { "code": <AuthErrorCode> }`. Four answers are not sign-in outcomes and carry a code outside
`AuthErrorCode`, which `LocalAuthService` (WP0.7) treats as unexpected: `400 validation_failed` (a
malformed body or a non-JSON POST), `403 forbidden_origin` (a browser origin other than the Vite
dev server), `404 not_found` and `500 internal_error`.

| Route | Body | Answer |
|---|---|---|
| `GET /.well-known/jwks.json` | | the signing key |
| `POST /email-otp` | `{ email }` | `{ kind: "challenge", challenge: "EMAIL_OTP", session }` |
| `POST /email-otp/answer` | `{ session, code }` | tokens |
| `POST /password` | `{ email, password }` | `SOFTWARE_TOKEN_MFA` challenge, or `{ kind: "signedIn", tokens }` |
| `POST /totp/answer` | `{ session, code }` | tokens |
| `POST /setup` | `{ code, password }` | `{ session, secret, otpauthUri }` |
| `POST /setup/verify` | `{ session, code }` | tokens |
| `POST /refresh` | `{ refreshToken }` | tokens (with a new refresh token) |

Tokens are `{ accessToken, idToken, refreshToken, expiresIn }`: the answer routes return them bare;
only `/password`, which may or may not need a TOTP step, wraps them as `{ kind: "signedIn", tokens }`. Until WP0.6 the codes are printed
on the emulator's console; then they go to Mailpit. The signing key lives in memory, so a restart
invalidates access tokens (refresh tokens are stored and keep working).

- **Depends on:** `@fisio/domain`, `@fisio/contracts`, `@fisio/local` (DynamoDB Local client),
  `@fisio/infra` (table name), `otplib`, Hono. Never on `apps/*`; specs use the testkit.
- **`@fisio/auth-emulator/testing`:** `createTestEmulator` (a pool of its own in a given table,
  clock and channel), `otpCodeIn`, `jwtPayload`, for specs and the seed.
