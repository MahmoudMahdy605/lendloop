# LendLoop

**Borrow what you need. Lend what you don't.**

A neighborhood tool-lending board. Neighbors list tools, request to borrow them for a date range, approve or decline requests, and mark loans returned. n8n sends request notifications and daily overdue reminders.

Stack: Next.js 16 (App Router), Clerk (auth), Convex (data and backend logic), n8n (workflow automation), TypeScript.

---

## Local setup

Prerequisites: Node 20+, Docker, a free Clerk account.

```bash
npm install
```

### 1. Clerk

1. Create an application at https://dashboard.clerk.com.
2. In Clerk, enable the **Convex integration** (Configure → Integrations → Convex). This creates the `convex` JWT template that Convex validates. Copy the **Frontend API URL** it shows (the issuer, e.g. `https://xxx.clerk.accounts.dev`).
3. In Clerk → **Sessions → Customize session token**, add the claims Convex reads for display name and email (keep the managed `aud` claim):

```json
{ "email": "{{user.primary_email_address}}", "name": "{{user.full_name}}" }
```

4. Put the API keys in `.env.local`:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

### 2. Convex

```bash
npx convex dev          # creates a deployment and writes NEXT_PUBLIC_CONVEX_URL to .env.local
```

In another terminal, set the deployment's environment variables:

```bash
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://xxx.clerk.accounts.dev
npx convex env set N8N_REQUEST_WEBHOOK_URL http://localhost:5678/webhook/lendloop-loan-event
npx convex env set N8N_OUTBOUND_SECRET "$(openssl rand -hex 32)"   # copy into .env.n8n as LENDLOOP_OUTBOUND_SECRET
npx convex env set N8N_INBOUND_SECRET  "$(openssl rand -hex 32)"   # copy into .env.n8n as LENDLOOP_INBOUND_SECRET
```

Optional demo data (two neighbors, three tools, one overdue loan): `npx convex run seed:demo`

### 3. n8n

```bash
cp .env.n8n.example .env.n8n      # fill in the two secrets above and CONVEX_SITE_URL
docker compose up -d
```

`docker compose` runs a one-shot `n8n-import` container that imports the three workflows from `n8n/workflows/` and publishes them, then starts n8n on http://localhost:5678.

`CONVEX_SITE_URL` is the Convex **HTTP actions** URL (`https://<deployment>.convex.site`). For a local Convex backend reached from Docker, use `http://host.docker.internal:3211`.

Run the overdue workflow on demand instead of waiting for 09:00:

```bash
docker compose run --rm --no-deps --entrypoint "" \
  -e N8N_RUNNERS_BROKER_PORT=5690 -e NODE_FUNCTION_ALLOW_BUILTIN=crypto -e N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
  n8n n8n execute --id lendloopReminder
```

### 4. App

```bash
npm run dev     # http://localhost:3000
npm test        # signing + date unit tests
```

Make yourself admin after signing in once:

```bash
npx convex run users:setRole '{"email":"you@example.com","role":"admin"}'
```

---

## Environment variables

| Where | Name | Purpose |
|---|---|---|
| `.env.local` (Next.js) | `NEXT_PUBLIC_CONVEX_URL` | Convex client URL (written by `npx convex dev`) |
| | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | Clerk keys |
| Convex deployment | `CLERK_JWT_ISSUER_DOMAIN` | Issuer Convex trusts for Clerk JWTs |
| | `N8N_REQUEST_WEBHOOK_URL` | n8n webhook for loan events |
| | `N8N_OUTBOUND_SECRET` | Signs Convex → n8n requests |
| | `N8N_INBOUND_SECRET` | Verifies n8n → Convex requests |
| `.env.n8n` (n8n container) | `LENDLOOP_OUTBOUND_SECRET` | Same value as `N8N_OUTBOUND_SECRET` |
| | `LENDLOOP_INBOUND_SECRET` | Same value as `N8N_INBOUND_SECRET` |
| | `CONVEX_SITE_URL` | Convex HTTP actions base URL |
| | `N8N_ENCRYPTION_KEY` | Encrypts n8n's stored credentials |

All `.env*` files are git-ignored except the `*.example` templates. No secret appears in code or in the exported workflow JSON: the Code and HTTP nodes read them from `$env`.

---

## Architecture

```
Browser (Next.js + Clerk)
   │  Clerk session → JWT ("convex" template)
   ▼
Convex  ── queries/mutations: every one re-checks identity + role
   │  mutation changes loan status ──► schedules sendLoanEvent (same transaction)
   │                                     │ signed POST (HMAC)
   │                                     ▼
   │                            n8n "Request notification"
   │                            verify signature → 200 → dedupe by eventKey → notify (mock)
   │
   ◄── n8n "Overdue reminders" (daily 09:00)
         signed POST /n8n/overdue-loans → one item per loan → remind (mock)
         → signed POST /n8n/automation-status (idempotent write-back)
   n8n "Error handler": error workflow for both, logs a failure summary
```

**Data model** (`convex/schema.ts`)

- `users`: Clerk token identifier, display name, email, `role` (`admin` | `user`), `trustedLender`.
- `tools`: owner, name, category, condition, description.
- `loans`: tool, lender, borrower, `startDate`/`endDate` (inclusive), `status` (`requested` → `approved` | `declined`, `approved` → `returned`).
- `automationEvents`: one row per automation side effect, keyed by a unique `key`; this is what makes retries idempotent and what the UI shows as "Reminder sent 2 days ago".

**Pages**

- `/` (public): tagline, read-only list of tools (**name and category only**), "Sign in to lend or borrow".
- `/app` (signed in): All tools (filter by category, availability status), My listings, My requests, Incoming requests, and an Admin tab for admins.

---

## Security and data-minimization decisions

**Access control lives in Convex, not the UI.** Every query and mutation calls `requireUser`/`requireAdmin` (`convex/lib/auth.ts`) and checks ownership on the server:

- Only the owner can edit or delete a listing; admins can remove any listing.
- Only the lender can approve, decline or mark a loan returned; you can't borrow your own tool.
- Approval re-checks for overlapping approved loans, so two people can't be approved for the same days.
- Admin-only queries return nothing for non-admins. Roles can't be set from the browser at all (`setRole` is an internal function run from the CLI).
- `proxy.ts` (Clerk middleware) only redirects signed-out users away from `/app`. It's a UX convenience, not the security boundary.

**Input validation.** Argument validators on every function, trimmed and length-limited text, real calendar dates only, no past start dates, end ≥ start, and a 30-day maximum loan.

**Signed integration in both directions.** `signature = sha256=HMAC(secret, "<timestamp>.<raw body>")` in `X-LendLoop-Signature`, plus `X-LendLoop-Timestamp`. Receivers reject missing or invalid signatures (constant-time compare) and timestamps older than 5 minutes (replay protection). Each direction has its own secret, so a leak on one side doesn't let an attacker forge the other. n8n verifies the **raw** body bytes, not a re-serialized copy.

**Idempotency and retries.**

- Every outgoing event has a key (`notify:<loanId>:<status>:<updatedAt>`). Convex claims the key before sending, retries failures with backoff (30s, 60s, 120s, 240s; 5 attempts), and never sends a key twice once it's marked `sent`. The key also goes to n8n as `Idempotency-Key`, and n8n drops keys it has already processed.
- Reminders use `overdue:<loanId>:<date>`, so a retried n8n run updates the same row instead of creating a duplicate reminder. A row marked `sent` never flips back to `failed`.
- The HTTP Request nodes retry 3 times. Both workflows point to the error workflow, so failures show up instead of failing silently, and failed notifications are visible on the loan in the app.

**Data minimization.**

- The public page gets only tool names and categories: no owners, no conditions, no descriptions.
- Webhook payloads carry only what the message needs: event, tool name, dates, and the **recipient's** name and email (the lender for a new request, the borrower afterwards). n8n's verify step then strips everything else before the notify step.
- The overdue endpoint returns only loans still needing a reminder today, with the borrower's name and email.
- Users store only the Clerk identifier, display name and email. The error workflow logs node and error metadata, not payloads.

---

## What I'd change for production

- **Real delivery**: replace the mock nodes with transactional email (Resend/SES) using templates, plus per-user notification preferences and unsubscribe.
- **Secrets**: store them in a secrets manager and rotate them. Support two active secrets during rotation (`kid` header), and use n8n credentials with external secret stores instead of env vars.
- **n8n hardening**: run in queue mode with Postgres (not SQLite), put it behind TLS on a private network or IP allow-list, and restrict the webhook to Convex egress.
- **Observability**: send the error workflow to Slack or PagerDuty, add structured logs in Convex, and alert on `automationEvents` stuck in `failed` or `pending`.
- **Data lifecycle**: retention for old loans and automation events, account deletion that cascades, and an audit log of admin actions.
- **Product**: time zones per user (dates are UTC today), richer availability (calendar view), photos via Convex file storage, rate limiting on requests, and pagination for large neighborhoods.
- **Tests**: Convex function tests with `convex-test` for the access rules, and a Playwright end-to-end flow (list → request → approve → return).

---

## Repository layout

```
convex/            schema, queries/mutations, HTTP endpoints for n8n, signing helpers
src/app/           Next.js pages (public landing + dashboard)
src/proxy.ts       Clerk middleware (route protection)
n8n/workflows/     exported workflow JSON (request notification, overdue reminders, error handler)
docker-compose.yml n8n + one-shot workflow import
tests/             unit tests for signing and date logic
```
