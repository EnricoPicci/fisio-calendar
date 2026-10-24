# TODOS

## Notifications

### WhatsApp channel option

**What:** A `WhatsAppChannel` adapter (Meta Cloud API, or Twilio as fallback) behind the existing `NotificationChannel` interface, Italian Utility templates approved by Meta, per-client opt-in with recorded consent, a WhatsApp message counter on the therapist dashboard, and an authenticated entry point for delivery-status webhooks.

**Why:** The original brief wanted WhatsApp reminders and cancellations; v1 ships email only. The architecture keeps the seam (`channels` and `consentAt` on the client, one outbox item per channel, the delivery state machine) so this is additive.

**Context:** `docs/architecture.md` §12.1 holds the verified cost facts (Italy Utility rate €0.0248 per delivered message as of the July 2026 rate card; ≈ €11/month if enabled for all ~200 clients, ≈ €3.5 at 30 % opt-in) and the prerequisites with lead time: Meta Business account and business verification, a phone number dedicated to the API (not the therapist's personal number), display-name and template approval, a payment method. Meta becomes a GDPR processor with non-EU transfers, hence opt-in per client. Start with the Meta account and number; the code is the small part. Webhooks need their own authenticated entry point because the API sits behind CloudFront OAC (§9.2).

**Effort:** M
**Priority:** P3
**Depends on:** v1 launched; the therapist's decision on who pays per message and whether reminders or only cancellations go through WhatsApp.

## Web app

### Installable PWA

**What:** Web app manifest and a minimal service worker (app-shell caching only, no offline booking) via `vite-plugin-pwa`, so clients can add the calendar to their phone's home screen.

**Why:** Clients open the calendar from phones; a home-screen icon lowers friction versus a bookmark. Removed from v1 in the eng review scope decision as tooling without launch value.

**Context:** Add after M3 once asset hashing and the CSP are stable. Keep the worker to app-shell caching and version it with the build hash so a deploy never serves a stale SPA; test on iOS Safari explicitly. No backend impact.

**Effort:** S
**Priority:** P3
**Depends on:** v1 launched.

### English UI / locale switch

**What:** A per-client `locale` attribute (default `it`, already in the data model) and an English strings module next to the Italian one in `packages/contracts/strings/`; `Intl` formatting and email templates follow the locale.

**Why:** The clarification round asked for an i18n-ready UI; the eng review replaced i18next with a typed strings module, so a second language is a second module plus a switch, not a framework.

**Context:** Only relevant if the therapist gets non-Italian-speaking clients. Email templates need translating too, and the therapist's own UI can stay Italian. A missing key in a strings module is a compile error, which keeps the two modules in step.

**Effort:** M
**Priority:** P4
**Depends on:** A real request from the therapist.

## Infrastructure

### Separate AWS accounts for dev and prod

**What:** Move `dev` into its own account under an AWS Organization; CDK stages target different accounts; one GitHub OIDC deploy role per account; budgets per account.

**Why:** `docs/architecture.md` §9.3 starts with one account and stage-separated stacks for a solo maintainer. Separate accounts are the standard blast-radius control: a mistake in dev cannot touch prod data, IAM or spend.

**Context:** Cheapest before `prod` holds real client data; after that it is a migration. Each account gets its own CloudFront Free plans (3), its own SES production-access request and its own Cognito pool. Target: the week after M3 launch at the latest, or before if real client data enters during M2 testing.

**Effort:** M
**Priority:** P2
**Depends on:** None technical; a decision on timing.

## Completed
