# FlareFleet

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/reichiClaw/FlareFleet)

Fleet and equipment pool management, built **entirely on Cloudflare**: one
Worker serves the API and the mobile-first React app, with D1 (database),
R2 (photos, signatures, PDFs), KV (sessions, settings cache), a Durable
Object (per-vehicle locking), Cron Triggers (housekeeping, overdue digest) and
Cloudflare Email Service (transactional e-mail). No servers, no Docker, no
third-party SaaS.

FlareFleet is the successor of
[`fleet-tracking`](https://github.com/reichiClaw/fleet-tracking) (Django +
React + PostgreSQL on Docker). It keeps the proven functional model and moves
it to a single serverless Worker.

## What it does

```text
Excel import ─▶ announced ─▶ check-in ─▶ available ─▶ loan ─▶ return ─▶ check-out to manufacturer ─▶ archived
                              (protocol,   (pool,        (protocol,  (protocol,   (protocol, photos)
                               photos)      QR label)     photos)     photos,
                                                                      damages)
```

- **Import** the manufacturer's delivery list from Excel/CSV before the
  machines arrive; print QR labels.
- **Check in** vehicles with meter readings, condition, damages and photos.
- **Loan** vehicles from the pool to subcontractors or drivers with photos
  and optional signature; **return** them and document new damage.
- **Maintenance** and **damage** tracking with resolution protocols.
- **Check out** vehicles to the manufacturer and archive them.
- **Every step is protocolled**: immutable protocol snapshots, numbered PDF
  protocols (German/English), status history, append-only audit log, and a
  per-vehicle timeline. PDFs can be e-mailed to borrowers/suppliers.
- **QR quick access**: scan a label with the phone camera to open the vehicle;
  optional public read-only page for anyone who scans a label.
- **Three roles**: Super Admin (global settings, users), Admin (master data,
  imports, vehicle edits, status corrections, archive), User (daily workflows).
- **Mobile-first UI**: bottom navigation, big tap targets, four-step wizards
  for every workflow, camera capture with client-side image resizing, works
  in German and English.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers + Static Assets | one deployable unit, global, free tier friendly |
| API | [Hono](https://hono.dev) | tiny, fast, built for Workers |
| Frontend | React 18 + Vite 6 + Tailwind 4 + TanStack Query | Vite is the officially supported build tool for Workers (`@cloudflare/vite-plugin`): one `vite dev` runs the SPA *and* the Worker with real local D1/R2/KV emulation, and `vite build` produces the deployable Worker + assets. Alternatives (Next.js, Remix/React Router framework mode, Astro) add server rendering that this app does not need |
| Database | D1 (SQLite) | relational, transactional `batch()`, migrations built in |
| Files | R2 | photos, signatures, PDFs; served through the Worker with auth |
| Sessions/cache | KV | cookie sessions, settings cache, rate limiting |
| Concurrency | Durable Object `VehicleLock` | serialises writes per vehicle |
| PDF | `pdf-lib` | pure JS, no browser rendering needed |
| Excel | `fflate` + minimal XLSX reader/writer | small, no Node dependencies |
| E-mail | Cloudflare Email Service (`send_email` binding) | no SMTP credentials or third-party provider |
| Validation | Zod, shared between Worker and SPA | one source of truth |

Everything runs on the Workers **Free plan** (D1, R2, KV, Durable Objects
with SQLite storage, Cron Triggers and Email Service all have free tiers).
Paid plan only becomes relevant for very high traffic or storage.

## Repository layout

```text
worker/            Hono API, Durable Object, cron handlers
  routes/          auth, users, settings, master data, vehicles, protocols, media, imports, dashboard, audit, public
  services/        vehicles, workflows (check-in/loan/return/…), pdf, imports, media, lock (DO)
  lib/             db, auth/sessions, crypto, settings, audit, email, i18n, xlsx, qr
web/               React SPA (pages, components, i18n, api client)
shared/            types, Zod schemas, status machine and capability rules (used by both sides)
migrations/        D1 SQL migrations
scripts/           setup-cloudflare.mjs installer, resolve-bindings.mjs (fills resource ids before deploy)
docs/              Specification (design target; see note below)
wrangler.jsonc     Worker configuration and bindings
```

The `docs/` folder contains the full specification written before
implementation. The implementation deliberately simplifies a few points to
stay on the free plan and keep operations trivial: PDFs are rendered with
`pdf-lib` instead of Browser Rendering, images are resized in the browser
instead of the Images binding, background work uses `waitUntil` + Cron instead
of Queues, and drafts/reservations are not implemented.

---

## Deployment manual (Cloudflare)

There are three ways to install, from easiest to most manual. All three end
at the same place: open the Worker URL and complete the setup screen.

### Option A: Deploy to Cloudflare button (no local tools)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/reichiClaw/FlareFleet)

Click the button, sign in to Cloudflare and connect your GitHub or GitLab
account. Cloudflare then:

1. Copies this repository into a new repository on your account (you own the
   code and can keep developing).
2. Shows one configuration page: Worker name, names for the D1 database, KV
   namespace and R2 bucket, and the variables `EMAIL_FROM` / `EMAIL_ENABLED`
   (`PUBLIC_BASE_URL` can stay empty). Each field carries a short
   description. Set `EMAIL_ENABLED` to `false` if you have not onboarded a
   sending domain yet; you can switch it on later.
3. Provisions the D1 database, KV namespace, R2 bucket and the `VehicleLock`
   Durable Object, writes their ids into `wrangler.jsonc` in your new
   repository, runs the D1 migrations (part of the `deploy` script), builds
   and deploys.
4. Sets up Workers Builds: every push to your new repository's main branch
   redeploys automatically, and pull requests get preview URLs.

When the build finishes, open the Worker URL (`https://<worker>.<your
subdomain>.workers.dev`). The setup screen creates the first super admin and
records that URL for QR labels and e-mail links; nothing else to configure.

Requirements: the source repository must be public (it is), and R2 must be
enabled once on your account (dashboard → R2 Object Storage → Get started,
free). If the first build fails with an R2 error, enable R2 and hit *Retry
build* in Workers & Pages → your Worker → Deployments.

#### Updating a Deploy-button copy

Your copy differs from this repository in exactly one file: `wrangler.jsonc`
holds the ids of *your* D1 database and KV namespace. Pull updates with a
merge, not a force-push, so that file keeps your ids:

```bash
git remote add upstream https://github.com/reichiClaw/FlareFleet.git
git fetch upstream
git merge upstream/main        # keep your wrangler.jsonc if it conflicts
git push                       # Workers Builds deploys
```

If the ids do get lost (for example after force-pushing upstream over your
copy), the deploy does not break: `npm run deploy` first runs
`scripts/resolve-bindings.mjs`, which fills placeholders from, in order, the
build variables `D1_DATABASE_ID` / `KV_NAMESPACE_ID` / `R2_BUCKET_NAME`, the
bindings of the currently deployed Worker, existing resources with the
configured names, and only as a last resort creates new ones. To pin your
resources explicitly, set those three variables under **Workers & Pages →
your Worker → Settings → Build → Variables** (ids are shown under **Settings
→ Bindings**).

### Option B: Installer script

You need: a Cloudflare account, Node.js 20+, and (for e-mail) a domain whose
DNS is managed by Cloudflare.

```bash
git clone <this repository> flarefleet
cd flarefleet
npm install
npm run setup:cloudflare
```

The installer logs you in (opens the browser if needed), creates the D1
database, KV namespace and R2 bucket (or reuses existing ones), writes their
ids into `wrangler.jsonc`, asks for the public URL and e-mail sender, applies
the migrations, builds and deploys. It ends with the URL to open for the
setup screen. Re-running it is safe; it only creates what is missing.

Non-interactive use (CI, scripted installs):

```bash
npm run setup:cloudflare -- --yes                                  # workers.dev URL, e-mail off
npm run setup:cloudflare -- --yes --base-url https://fleet.example.com --email-from fleet@example.com
npm run setup:cloudflare -- --skip-deploy                          # resources + config only
```

If R2 has never been used on the account the script stops and asks you to
enable it once in the dashboard (**R2 Object Storage → Get started**, free),
then run it again. E-mail additionally needs the sender domain onboarded
(step 5 below); the script reminds you.

### Option C: Manual steps

The same thing by hand, useful to understand what the button and the script
do.

### 1. Install and log in

```bash
git clone <this repository> flarefleet
cd flarefleet
npm install
npx wrangler login          # opens the browser, authorises Wrangler
npx wrangler whoami         # shows your account id
```

### 2. Create the Cloudflare resources

```bash
# D1 database
npx wrangler d1 create flarefleet-db
# -> prints "database_id": "xxxxxxxx-xxxx-...". Copy it.

# KV namespace (sessions, settings cache)
npx wrangler kv namespace create KV
# -> prints "id": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx". Copy it.

# R2 bucket (photos, signatures, PDFs)
npx wrangler r2 bucket create flarefleet-media
```

If `r2 bucket create` says R2 is not enabled, open the Cloudflare dashboard
once: **R2 Object Storage → Get started** (the free tier needs no payment
method to activate; it just has to be switched on once).

### 3. Configure `wrangler.jsonc`

Open `wrangler.jsonc` and replace the placeholders:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "flarefleet-db",
    "database_id": "PASTE_D1_DATABASE_ID", "migrations_dir": "./migrations" }
],
"kv_namespaces": [
  { "binding": "KV", "id": "PASTE_KV_NAMESPACE_ID" }
],
```

and set the variables:

```jsonc
"vars": {
  "APP_NAME": "FlareFleet",
  "PUBLIC_BASE_URL": "",                  // empty = recorded automatically at first-run setup; set for a custom domain
  "EMAIL_FROM": "fleet@yourdomain.com",   // must be on a domain onboarded in Email Service (step 5)
  "EMAIL_ENABLED": "true"                 // "false" if you skip e-mail for now
}
```

Nothing else needs secrets: there is no SMTP password, no API key. The first
super admin is created through the app on first start.

### 4. Create the database schema

```bash
npm run db:migrate
```

This applies `migrations/*.sql` to the remote D1 database. Run it again after
every update that ships new migration files (it only applies new ones).

### 5. Enable e-mail (optional but recommended)

FlareFleet sends invitations, password resets, protocol copies and the daily
overdue digest through Cloudflare Email Service. Setup is done in the
dashboard, no code or secrets required:

1. Cloudflare dashboard → **Compute → Email Service → Email Sending**.
2. **Onboard Domain** → pick the domain you want to send from (it must use
   Cloudflare DNS). Cloudflare adds the required MX/SPF/DKIM/DMARC records
   to a `cf-bounce` subdomain automatically. Select **Done**.
3. Make sure `EMAIL_FROM` in `wrangler.jsonc` uses that domain
   (e.g. `fleet@yourdomain.com`).

The `send_email` binding is already declared in `wrangler.jsonc`. If you skip
this step, set `EMAIL_ENABLED` to `"false"`; the app then shows temporary
passwords on screen instead of mailing them, and everything else works
normally. You can verify delivery later from **Settings → Send test e-mail**
inside the app.

### 6. Build and deploy

```bash
npm run deploy
```

This applies pending migrations, runs `vite build` (SPA + Worker) and
`wrangler deploy`. The first deploy also creates the `VehicleLock` Durable
Object class and registers the two cron triggers. Wrangler prints the URL,
typically `https://flarefleet.<your-subdomain>.workers.dev`.

The URL used in QR labels and e-mail links is recorded automatically when you
complete the setup screen (step 7) and can be changed any time under
**Settings → Public URL**; `PUBLIC_BASE_URL` in `wrangler.jsonc` only needs a
value if you want to pin it.

### 7. First start: create the super admin

Open the URL. Because no user exists yet, the app shows the **Setup** screen:
enter organisation name, your name, e-mail and a password (10+ characters).
This creates the first **Super Admin** and logs you in. The setup screen is
disabled permanently afterwards.

Then, as Super Admin:

1. **Settings**: language, minimum photos per workflow, signature
   requirements, default loan duration, public QR page on/off, e-mail
   recipients for the overdue digest, PDF footer.
2. **Categories**: create vehicle categories and their meter mode
   (odometer / operating hours / both / none).
3. **Partners**: suppliers (manufacturers) and subcontractors/drivers.
4. **Users**: invite admins and users. With e-mail enabled they receive an
   invitation with a temporary password; otherwise the password is shown to
   you once.
5. **Import**: download the Excel template, fill it with the delivery list,
   upload, review, commit. The vehicles appear as *announced* and can be
   checked in when they arrive.

### 8. Custom domain (optional)

In the dashboard: **Workers & Pages → flarefleet → Settings → Domains &
Routes → Add → Custom domain** and enter e.g. `fleet.yourdomain.com` (the
zone must be on Cloudflare). Then change the public URL to
`https://fleet.yourdomain.com` either in the app (**Settings → Public URL**,
takes effect immediately) or via `PUBLIC_BASE_URL` in `wrangler.jsonc`
followed by `npm run deploy`.

### 9. Updating

```bash
git pull
npm install
npm run db:migrate      # applies new migrations, if any
npm run deploy
```

Deployments are atomic; users keep their sessions.

### Operations cheat sheet

| Task | How |
|---|---|
| Live logs | `npm run tail` (or dashboard → Workers → flarefleet → Logs; observability is enabled) |
| Database console | `npx wrangler d1 execute flarefleet-db --remote --command "SELECT count(*) FROM vehicles"` |
| Export database | `npx wrangler d1 export flarefleet-db --remote --output backup.sql` |
| Point-in-time restore | D1 Time Travel: `npx wrangler d1 time-travel restore flarefleet-db --timestamp=<ISO date>` (30 days on the free plan) |
| Files | dashboard → R2 → `flarefleet-media` (keys: `photo/`, `signature/`, `pdf/`, `import/`, one folder per day) |
| Scheduled jobs | hourly: retry pending/failed PDFs, purge staged uploads that were never attached; daily 06:00 UTC: overdue-loan digest. Sessions expire via KV TTL |
| Rotate all sessions | delete the keys with prefix `session:` in the KV namespace (dashboard → KV) |
| Reset a locked-out super admin | `npx wrangler d1 execute flarefleet-db --remote --command "UPDATE users SET is_active=1, failed_logins=0, locked_until=NULL WHERE email='you@example.com'"` then use *Forgot password* (needs e-mail) or have another super admin reset it |

### Troubleshooting

The UI shows a generic "Unexpected error" for any server-side failure; the
real cause is in the Worker logs: dashboard → Workers & Pages → your Worker →
**Logs** (live), or `npm run tail` locally. Common ones:

| Symptom / log line | Cause | Fix |
|---|---|---|
| `no such table: users` | Migrations not applied | `npm run db:migrate` (Deploy button: check the build log of the deploy step) |
| `Invalid property: databaseId => Invalid uuid` in the deploy log | `wrangler.jsonc` still has placeholder ids (e.g. after force-updating a copy) | Fixed automatically by `npm run deploy` since the resolver step; or paste the ids from **Settings → Bindings** into `wrangler.jsonc` |
| `Pbkdf2 failed: iterations too high` | `PBKDF2_ITERATIONS` above 100000 | Set it to 100000 or less (default 20000) |
| `Worker exceeded CPU time limit` on login/setup | `PBKDF2_ITERATIONS` too high for the free plan | Lower it to 20000 |
| `E_SENDER_NOT_VERIFIED` / `E_SENDER_DOMAIN_NOT_AVAILABLE` | Sender domain not onboarded in Email Service | Onboard the domain or set `EMAIL_ENABLED` to `false` |
| Uploads fail with an R2 error | R2 not enabled on the account | Enable R2 once in the dashboard, redeploy |

### Multiple environments (optional)

To run a staging copy, add an environment block to `wrangler.jsonc` with its
own D1/KV/R2 ids and `PUBLIC_BASE_URL`, then use `wrangler deploy --env
staging` and `wrangler d1 migrations apply flarefleet-db-staging --remote --env staging --config wrangler.jsonc`.

---

## Local development

```bash
npm install
npm run db:migrate:local      # creates the local SQLite database
npm run dev                   # http://localhost:5173
```

`npm run dev` starts Vite with the Cloudflare plugin: the React app has hot
reload and the Worker runs in the real `workerd` runtime with local D1, R2,
KV and Durable Object emulation. E-mails are not sent locally; Wrangler prints
them to the console. Open http://localhost:5173, complete the setup screen,
and start clicking. Optional local overrides go into `.dev.vars` (see
`.dev.vars.example`).

Useful scripts:

| Script | Purpose |
|---|---|
| `npm run typecheck` | TypeScript for SPA and Worker |
| `npm run build` | production build into `dist/` |
| `npm run preview` | serve the production build locally |
| `npm run cf-typegen` | regenerate Worker binding types from `wrangler.jsonc` |
| `npm run setup:cloudflare` | guided Cloudflare installer (see deployment manual) |
| `npm run resolve:bindings` | fill placeholder resource ids in `wrangler.jsonc` (runs automatically in `db:migrate`/`deploy`) |

## Using the app (quick tour)

- **Dashboard**: counts per status, expected arrivals, overdue loans, vehicles
  needing attention, recent activity.
- **Vehicles**: search and filter; open a vehicle for its overview, history
  timeline, damages, photos, loans, QR label and the actions that are valid in
  its current status.
- **Workflows** (check-in, loan, return, maintenance, check-out, correction)
  are four-step wizards: details → photos → condition/damages → confirm. Each
  produces a numbered protocol with a PDF.
- **Scan**: point the phone camera at a QR label to jump to the vehicle.
- **Documents**: all protocols with PDF download; failed PDFs can be
  regenerated.
- **Import**: Excel/CSV upload with validation preview before commit.
- **Audit**: filterable, exportable log of everything that happened.

## Specification

The design documents in [`docs/`](docs/) describe the target system in detail:

| Document | Content |
|---|---|
| [01 Vision and scope](docs/01-vision-and-scope.md) | Goals, feature inventory, simplifications vs. the old app |
| [02 Architecture](docs/02-architecture.md) | Cloudflare building blocks, request flow, concurrency model, auth |
| [03 Roles and permissions](docs/03-roles-and-permissions.md) | Super admin / admin / user, permission matrix, capability flags |
| [04 Data model](docs/04-data-model.md) | D1 DDL, snapshot shapes, R2/KV layout |
| [05 Workflows](docs/05-workflows.md) | Status machine and function-level rules for every workflow |
| [06 API](docs/06-api.md) | REST endpoints |
| [07 Frontend](docs/07-frontend.md) | Routes, wizards, components |
| [08 Excel import](docs/08-excel-import.md) | Columns, validation, commit |
| [09 Media and PDF](docs/09-media-and-pdf.md) | Photos, signatures, PDF protocols, document register |
| [10 Protocol and audit](docs/10-protocol-and-audit.md) | Audit log, vehicle timeline, retention |
| [11 Settings](docs/11-settings.md) | Super-admin global settings |
| [12 Implementation plan](docs/12-implementation-plan.md) | Milestones, work packages, risks |
| [13 Testing and operations](docs/13-testing-and-operations.md) | Tests, CI/CD, observability, backups |
