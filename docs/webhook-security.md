# Inbound webhook security

Last source audit: 2026-07-18

This document inventories routes that external systems can call without the
site-auth cookie. Keep it synchronized with `src/middleware.ts`, external
provider dashboards, and `vercel.json`.

## Current receiver inventory

| Route | Caller | Method/body | Verification | Invalid credential response |
| --- | --- | --- | --- | --- |
| `/api/worker/generate` | Vercel Cron and the first-party worker kick | `GET`; no request body | `CRON_SECRET` from `x-cron-secret` or `Authorization: Bearer`, compared by `crypto.timingSafeEqual` through `secretsEqual` | Generic `401 { "error": "Unauthorized" }` |

There are no signed-body webhook receivers in the repository. In particular:

- No Slack, Stripe, Svix, GitHub, Supabase, Resend, SendGrid, or Twilio webhook
  route or app manifest is checked in.
- The BFT integration in `/api/bug-report` is outbound-only: the authenticated
  application route sends reports to BFT and does not receive BFT callbacks.
- Gemini, Veo, and LTX integrations submit work and poll providers; no inbound
  provider callback route exists.
- `/api/login` is also public, but it is an interactive form endpoint rather
  than a webhook. All other `/api` routes are covered by the site-auth middleware.

The cron receiver uses a shared bearer credential rather than a timestamped
body signature because the configured invocation is a bodyless `GET`. Its
credential is therefore the security boundary. Keep it scoped to this route,
use a high-entropy value, and follow the rotation procedure in
`src/lib/server-secrets.ts`. Before relying on an overlap variable during a
rotation, confirm that the deployed revision actually accepts it; remove any
previous credential immediately after all callers use the new value.

## External configuration checks

Source control cannot verify provider dashboards. During deployment or incident
response, confirm all of the following manually:

1. The Vercel cron targets exactly `/api/worker/generate` and supplies the same
   `CRON_SECRET` expected by the deployed application.
2. No Slack app, Stripe endpoint, Supabase Database Webhook, Svix application,
   GitHub webhook, Resend/SendGrid event hook, or Twilio callback points at this
   deployment. Such a configuration would currently have no supported receiver.
3. Any future external receiver appears in this inventory and has an explicit
   owner and secret-rotation procedure.

## Requirements for a future signed webhook

An App Router webhook handler must:

1. Read the body once with `await request.text()`.
2. Extract the provider signature and timestamp headers.
3. Reject missing, stale, or invalid credentials with the same generic 401/403
   response. Use a five-minute replay window for Slack and Stripe unless the
   provider requires a stricter value.
4. Verify the signature over the untouched raw body with the provider SDK or
   `crypto.timingSafeEqual`. Never compare signatures with `===` or `.equals()`.
5. Call `JSON.parse(rawBody)` only after verification succeeds.
6. Add route-level tests for missing headers, invalid signatures, stale
   timestamps, malformed JSON after valid authentication, and the success path.

`src/lib/webhook-route-security.test.ts` is a regression tripwire for webhook-like
route names. It supplements review and route-level cryptographic tests; it is not
a substitute for them.
