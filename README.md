## README

> ### ⚠️ This repository currently contains two apps
>
> A **Next.js** app has been migrated in alongside the existing **Rails 8** app.
> Both run against the same PostgreSQL database. The Rails app is still the one
> deployed; the Next app is not live yet, and removing Rails is a deliberate
> follow-up PR, not part of the migration PR.
>
> See [Next.js app](#nextjs-app) below, and
> [`vendor/droplet-sdk/README.md`](vendor/droplet-sdk/README.md) for the one
> known blocker.

Droplets are integrations between third-party services and Fluid. This is a repository intended to be used as an example for creating Droplets.

Documentation can be found in the [project's GitHub page](https://fluid-commerce.github.io/droplet-template/)

## Next.js app

The Next.js port of this droplet: the ShipStation integration, the embedded
configuration UI, the admin console, and signature verification via
`@fluid-studios/droplet-sdk`. It follows
[`fluid-commerce/droplet-template` PR #200](https://github.com/fluid-commerce/droplet-template/pull/200)
— the shared layer is that PR's, and this repo adds only what is
ShipStation-specific.

### Layout

| Path | What |
|---|---|
| `src/` | The Next app — **and its project directory**. `next.config.ts`, `tsconfig.json` and `next-env.d.ts` live here, not at the repo root. |
| `src/app/` | App Router: the embedded UI at `/`, the admin console, `/api/*` |
| `src/lib/shipstation/` | ShipStation V1/V2 clients, order push, cancel, shipments, tracking |
| `src/lib/fluid-api/` | Fluid commerce calls made with a company's install token |
| `src/lib/jobs/` | The two recurring jobs, now driven by Cloud Scheduler |
| `src/lib/rails/` | Active Record Encryption, reimplemented — see below |
| `src/components/embedded/` | The three-tab iframe UI (Configuration / Shipping Methods / Activity) |
| `prisma/schema.prisma` | The **existing Rails tables**, mapped with `@@map`/`@map` |
| `vendor/droplet-sdk/` | Temporary vendored copy of the SDK — see below |
| `Dockerfile.next` | Production image (the Rails `docker/Dockerfile` is untouched) |
| `.github/workflows/ci-next.yml` | Lint / typecheck / test / build / docker |

**Why `next.config.ts` is inside `src/`.** Next resolves its app directory with
`findDir(root, "app")`, which prefers `<root>/app` over `<root>/src/app` and
cannot be overridden. This repo still contains Rails' `app/`, so building from
the repo root makes Next scan Rails' directory and emit an empty app. Next is
therefore pointed at `src` as its project directory — `next build src`. When
Rails is removed, those three config files move up one level and the commands
drop the `src` argument. No source file moves and no import path changes.

### Commands

```bash
pnpm install
pnpm db:generate          # prisma generate
pnpm dev                  # next dev src
pnpm build                # prisma generate && next build src
pnpm test                 # vitest
pnpm lint
pnpm typecheck

pnpm setup:create-admin   # ADMIN_EMAIL / ADMIN_PASSWORD
pnpm settings:defaults    # create the default `settings` rows
```

The Rails frontend's Vite build is still here under `pnpm build:vite` and
`pnpm test:jest`. The repo's JS toolchain moved from yarn to pnpm when the Next
app took over the root `package.json`; nothing under `app/`, `config/` or
`Gemfile` changed.

### Route map

| Rails | Next |
|---|---|
| `POST /webhook` | `POST /api/webhooks` — HMAC-verified by `withFluidWebhook` |
| `POST /webhook/shipped` | `POST /api/webhooks/shipped` |
| `POST /integration_settings` | `POST /api/integration-settings` |
| `POST /integration_settings/test_connection` | `POST /api/integration-settings/test-connection` |
| `POST /integration_settings/test_v2_connection` | `POST /api/integration-settings/test-v2-connection` |
| `GET|POST /shipping_method_mappings` | `GET|POST /api/shipping-method-mappings` |
| `DELETE /shipping_method_mappings/:id` | `DELETE /api/shipping-method-mappings/:id` |
| `GET /shipping_catalog/*` | `GET /api/shipping-catalog/*` |
| `GET /orders`, `POST /orders/:id/resend` | `GET /api/orders`, `POST /api/orders/:id/resend` |
| `SyncTrackingJob` (recurring) | `POST /api/jobs/sync-tracking` |
| `ReleaseHeldOrdersJob` (recurring) | `POST /api/jobs/release-held-orders` |
| `GET /up` | `GET /api/health` |

### The rule this droplet is built around

**Never modify an order that already has a label.** ShipStation moves a labeled
order to the `shipped` status, so that status is the signal, and every path that
could touch a live ShipStation order checks it first:

- a Fluid-side edit is re-pushed only when the order is still open
  (`reconcileSubmitted` in `src/lib/shipstation/create-order.ts`);
- a cancellation is refused with `skipped_has_label`
  (`src/lib/shipstation/cancel-order.ts`);
- the lookup itself fails safe — on any error or ambiguity
  `isShipstationOrderShipped` answers `true`, so an order we cannot confirm is
  open is left alone (`src/lib/shipstation/order-status.ts`);
- the Activity tab's "Send now" excludes every terminal status, server-side.

`src/lib/shipstation/create-order.test.ts` pins all of it.

### Active Record Encryption

`integration_settings.settings` holds each company's ShipStation credentials
inside Active Record's encryption envelope (`encrypts :settings, deterministic:
true`). Both apps run against that same row, so `src/lib/rails/encrypted-attribute.ts`
reimplements the format — PBKDF2-HMAC-SHA1 key derivation, AES-256-GCM, the
deterministic IV, and the 140-byte deflate threshold — and its tests pin it to
byte-identical vectors generated by ActiveRecord::Encryption itself.

It reads the same three environment variables `config/application.rb` does, so a
deployment already running Rails needs no new secrets. They are **required**:
missing keys throw rather than defaulting, because a default here would write
ciphertext Rails cannot read.

### Scheduled jobs

Rails ran `SyncTrackingJob` and `ReleaseHeldOrdersJob` from Solid Queue's
recurring tasks. A standalone Next droplet on Cloud Run has no always-on worker,
so they are HTTP endpoints driven by Cloud Scheduler on the same schedule (30
and 5 minutes), authenticated with a `CRON_SECRET` bearer token. An unset
`CRON_SECRET` refuses every request — there is no open default for an endpoint
that force-sends orders to a carrier.

### Callbacks: this droplet registers none

There is no callback route here, and there never was one in Rails: no entry in
`config/routes.rb`, no controller, and `CallbackSyncService` creates every synced
`callbacks` row with `active: false`. The SDK's callback plumbing
(`fluid_callback_registrations`, `registerCallbacksForCompany`, the backfill
script) is carried over from the template so a fork can use it, but nothing is
registered and no definition name is claimed.

If a callback is ever added, the definition name must be one of the 22 files in
fluid at `app/lib/callback_definitions/*.yml` — a route directory name is not a
definition name — and the route must answer HTTP 200 for every outcome, auth
failures included, because Fluid blocks a live checkout on the response.

### The SDK is vendored, temporarily

`@fluid-studios/droplet-sdk` is **not published**, and cannot be under that
name: GitHub Packages requires the npm scope to match the repository owner, the
owner is `fluid-commerce`, and there is no `fluid-studios` GitHub org. So the
SDK source is vendored at `vendor/droplet-sdk` and depended on as
`"@fluid-studios/droplet-sdk": "link:./vendor/droplet-sdk"`. Import specifiers
stay `@fluid-studios/droplet-sdk`, so the eventual rename is a
find-and-replace — see
[`vendor/droplet-sdk/README.md`](vendor/droplet-sdk/README.md).

### Authentication

Auth.js (NextAuth v5) with a credentials provider, verifying bcrypt against the
existing `users.encrypted_password`. Devise's `config.pepper` is unset in this
app, so the digest is plain bcrypt at cost 12 and **existing user rows keep
working with no password reset**.

The embedded UI does not use it: it authenticates on the installation's
`droplet_installation_uuid` (the DRI) passed by Fluid, exactly as Rails'
`DriAuthenticatable` did. One difference — Rails cached the DRI in the session,
and that is dropped, because an ambient session cookie is what would make these
endpoints CSRF targets. The `X-Requested-With` requirement is kept.

### Cutting over from Rails

The two apps expose the webhook endpoint at different paths — Rails at `POST
/webhook`, Next at `POST /api/webhooks`. Fluid calls whatever URL is stored in
the `fluid_webhook` settings row, so the cutover is: point that row's `url` at
the Next deployment, press **Update Droplet** on the dashboard, and confirm an
install arrives. Per-company `order.*` webhooks are re-registered on install
from `src/lib/config/droplet.config.ts`; existing installations keep the URLs
Fluid already holds, so they need re-registering as part of the cutover.

### Deliberately not ported

- **Devise's `:registerable`, `:recoverable`, `:rememberable` flows.** Public
  sign-up on an internal admin console was not worth reproducing, and password
  reset needs a mailer this app does not have.
- **Solid Queue.** Webhook handlers run inline in the route — see the note in
  `src/lib/events/event-handler.ts` — and the two recurring jobs became
  scheduled endpoints.
- **`WebhookEventJob`'s surrounding transaction.** It wrapped each handler in one
  transaction, so a ShipStation rejection recorded as FAILED and then re-raised
  had that FAILED row rolled back — the audit trail vanished exactly when it
  mattered. Here each write commits on its own.
- **`Company.find(company_id)` on the shipped webhook.** Rails fell back to the
  primary key when `fluid_company_id` missed, so a caller passing `1` addressed
  whichever company was row 1. Only `fluid_company_id` is accepted now.
- **The `events` and `webhooks` tables' behaviour.** Model-only in the Rails app,
  with no call sites. Mapped in the Prisma schema so the database is fully
  described; no behaviour was invented for them.

## Rails app

### Production environment

### Google cloud infrastructure

- Google Cloud Run (Web)
- Google Cloud Storage (Terraform)
- Google Cloud SQL (postgreSQL)
- Google Cloud Build (CI/CD)
- Google Cloud Compute Engine (jobs console)
- Artifact Registry (Docker)

web: Google Cloud Run name `fluid-droplet-NAME`

jobs console: Google Cloud Compute Engine name `fluid-droplet-NAME-jobs-console`

### Deploy to google cloud

Run github action to deploy to google cloud `deploy production`
or run the following command to deploy to google cloud  

`gcloud beta builds submit --config cloudbuild-production.yml --region=us-west3 --substitutions=COMMIT_SHA=$(git rev-parse --short HEAD),_TIMESTAMP=$(date +%Y%m%d%H%M%S) --project=fluid-417204 .`

### Add environment variables to google cloud

Add environment variables to google cloud `add-update-env-gcloud.sh` and run the following command to add environment variables to google cloud
`sh add-update-env-gcloud.sh`

### Technology Stack

![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-336791?logo=postgresql&logoColor=white)
![Ruby](https://img.shields.io/badge/Ruby-3.4.2-CC342D?logo=ruby&logoColor=white)
![Rails](https://img.shields.io/badge/Rails-8.0.2-CC0000?logo=ruby-on-rails&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-23.8.0-339933?logo=node.js&logoColor=white)
![Yarn](https://img.shields.io/badge/Yarn-4.7.0-2C8EBB?logo=yarn&logoColor=white)
![Font Awesome](https://img.shields.io/badge/Font_Awesome-6.7.2-528DD7?logo=fontawesome&logoColor=white)
![Tailwind CSS 4.0](https://img.shields.io/badge/Tailwind_CSS-4.0-38B2AC?logo=tailwindcss&logoColor=white)
<br>

## Local environment

### Running locally

Install dependencies with `bundle install` and `yarn install`
and install foreman with `gem install foreman`  
Just the rails server (port 3000)<br>
`foreman start -f Procfile.dev`

Running everything (port 3200)<br>
`bin/dev`

### Running locally with docker

Configure your environment variables in `.env` file
and run the following command:  
`make install`
Running it as a docker service (port 3600)<br>
`make up`

Run `make help` to see all commands

### License

MIT License

Copyright (c) 2025 Fluid Commerce

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
