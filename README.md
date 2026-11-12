# Spendwise

Expense claims for small Indian teams, run from Claude.

An employee drops receipt photos into **their own Claude** and says *"Log these from my Bangalore trip."* Claude reads the receipts and sends the lines to Spendwise over MCP. Spendwise checks them against the company policy with plain code (limits, GSTIN, weekends, duplicates, trip dates), saves a draft claim, routes it to the manager, keeps an audit trail, and gives finance reports and a CSV export for Tally / Zoho Books / Xero.

**Spendwise never calls an AI API.** The customer's Claude does the reading; CI fails if an AI SDK or API-key env var ever appears in the repo.

---

## Try the demo

After `npm run seed` (or on a deployment with `SEED_DEMO=true`) the org **Acme Travel Pvt Ltd** exists with ~3 months of claims in every status.

| Login | Role | Password |
|---|---|---|
| `riya@acme.test` | Employee (reports to Priya) | `demo1234` |
| `arjun@acme.test` | Employee (reports to Priya) | `demo1234` |
| `manager@acme.test` | Manager — Priya Sharma | `demo1234` |
| `admin@acme.test` | Admin / finance — Kavita Rao | `demo1234` |

The seed prints **Riya's MCP connector URL**. To get a stable one for a public demo, set `DEMO_MCP_TOKEN` (e.g. `sw_` followed by 32 random URL-safe characters) before seeding; the URL is then `https://<your-host>/mcp/<DEMO_MCP_TOKEN>`.

> Anyone with a connector URL can act as that user. Only publish the demo token for a demo deployment.

### Connect Claude

1. Sign in to Spendwise → **Settings → Connect Claude** → **Generate connector URL** and copy it (or use the demo URL above).
2. In Claude, open **Settings → Connectors → Add custom connector**, name it *Spendwise*, paste the URL, save.
3. In a new chat, attach receipt photos and say: *"Log these receipts for my Bangalore trip, 3–5 Nov."*
4. Claude calls `get_policy`, then `create_claim`, and replies with the totals, any flags, and a link to the draft claim.
5. Open the link to attach the receipt images, fix anything, and submit (or tell Claude "submit it").

---

## Run locally

Requirements: Node 22+, Postgres 14+.

```bash
cp .env.example .env               # set DATABASE_URL and SESSION_SECRET
npm install
npm run migrate                    # apply migrations
npm run seed                       # demo org (npm run seed -- --reset to recreate)
npm run dev                        # http://localhost:3000
```

Receipts are stored in the database by default (table `receipt_files`), so one Postgres is all you need, locally and deployed.

Environment files: `.env.local` is loaded first, then `.env` (both git-ignored; real environment variables win). `neon deploy`, or pasting your Neon URLs, goes in `.env.local`. Tests never read these files except for `TEST_DATABASE_URL`, and refuse to run if it points at the same database as `DATABASE_URL`.

### Using Neon

Put Neon's pooled connection string in `DATABASE_URL` and the direct one (host without `-pooler`) in `DATABASE_URL_UNPOOLED`, then `npm run migrate`. On Render, replace the `fromDatabase` entry for `DATABASE_URL` in `render.yaml` with your Neon URL (and drop the `databases:` block).

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with reload (tsx) |
| `npm run build` / `npm start` | Compile to `dist/`; start applies migrations, then serves |
| `npm run migrate` | Apply migrations (`migrate:generate` makes a new one after editing `src/db/schema.ts`) |
| `npm run seed` | Create the demo org (`-- --reset` to recreate) |
| `npm test` | Unit tests; integration tests too when `TEST_DATABASE_URL` is set |
| `npm run typecheck` / `npm run lint` | Types (src + tests) / ESLint |
| `npm run check:no-ai` | Fail on banned AI packages or env vars |

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string (on Neon: the pooled `-pooler` URL) |
| `DATABASE_URL_UNPOOLED` | no | Direct connection for migrations (on Neon: same URL without `-pooler`) |
| `SESSION_SECRET` | yes | Long random string (`openssl rand -hex 32`); also signs invite links |
| `APP_URL` | no | Public URL, no trailing slash. Defaults to `RENDER_EXTERNAL_URL` on Render, else `http://localhost:$PORT` |
| `RECEIPT_STORAGE` | no | `database` (default) or `disk` |
| `UPLOADS_DIR` | no | Receipt directory when `RECEIPT_STORAGE=disk` (default `./uploads`) |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION` | no | Optional: a private S3-compatible bucket (e.g. Cloudflare R2); overrides `RECEIPT_STORAGE` when set |
| `SEED_DEMO` | no | `true` seeds the demo org on boot if it doesn't exist |
| `DEMO_MCP_TOKEN` | no | Fixed demo connector token for Riya |
| `PORT` | no | Default 3000 |

---

## How it works

```
Claude ──MCP (POST /mcp/<token>)──┐
                                  ├─► src/domain/*  ──► Postgres (Drizzle)
Browser ──HTML forms / sessions───┘        │
                                           └─► receipts: Postgres (default), disk or private R2
```

- **One domain layer.** All business rules and permission checks live in `src/domain/`. The web routes (`src/web/routes/`) and the MCP tools (`src/mcp/tools/`) are thin wrappers, so Claude and people always get the same behaviour.
- **Money** is stored as integer paise; tools accept and return rupees.
- **Rule checks** add flags but never block a claim: `OVER_ITEM_LIMIT`, `OVER_DAY_LIMIT`, `MISSING_RECEIPT` (on submit), `MISSING_GSTIN`, `INVALID_GSTIN` (format + checksum), `GST_MISMATCH`, `WEEKEND`, `OUTSIDE_TRIP`, `POSSIBLE_DUPLICATE`.
- **Audit log.** Every change records who did it, before/after, and whether it came from `web` or `mcp`.
- **Receipts** are stored in Postgres by default and served only through `GET /receipts/<file>` after checking the viewer can see the claim (an optional R2 bucket can stay private for the same reason).

### MCP tools

Streamable HTTP, stateless, JSON responses. Authenticated by the per-user token in the URL (stored as a SHA-256 hash; revocable). Every tool runs as that user with the same permissions as the web app. Validation errors say exactly how to fix the call (e.g. *"Unknown category 'Food'. Valid categories: Meals (MEALS), Travel (TRAVEL), …"*).

| Tool | Who | Purpose |
|---|---|---|
| `get_policy` | all | Categories, limits, thresholds, notes, caller's role and manager |
| `create_claim` | all | New draft (or `submit: true`) from extracted receipt lines |
| `add_expenses` | owner, draft | Add lines |
| `update_expense` | owner (draft) / approver (submitted) | Change any field; flags re-checked |
| `submit_claim` | owner | Send to the manager |
| `list_my_claims` | all | Own claims, filter by status/date |
| `get_claim` | owner, their manager, admin | Lines, flags, comments, history |
| `list_pending_approvals` | manager, admin | Submitted claims waiting on you |
| `decide_claim` | manager (direct reports), admin | Approve/reject per line, or approve all |
| `get_spend_report` | manager (team), admin (org) | Totals by person / category / month |

### Web app

| Page | Who |
|---|---|
| `/claims`, `/claims/:id` | Everyone: list, edit lines, live totals, drag-and-drop receipts, comments, history, submit |
| `/approvals` | Managers & admins: queue (oldest first); admins also bulk **mark as paid** |
| `/reports` | Managers (team) & admins (org): by person / category / month; admins **Export CSV** |
| `/settings/connect` | Everyone: generate / revoke connector URLs |
| `/settings/policy` | Everyone reads; admins edit thresholds and categories |
| `/settings/team` | Admins: roles, managers, invite links |

CSV columns: `claim_id, employee, email, date, merchant, category, category_code, description, amount, currency, taxable, cgst, sgst, igst, gstin, payment_method, status, approver, decided_at, paid_at`. The default export is approved lines on approved / partly approved / paid claims; "All submitted lines" includes pending and rejected ones. Values that look like spreadsheet formulas are neutralised.

---

## Tests

```bash
npm test                                                        # unit tests only
createdb spendwise_test
TEST_DATABASE_URL=postgresql://localhost/spendwise_test npm test  # + integration
```

Integration tests only ever use `TEST_DATABASE_URL` (never `DATABASE_URL`). Each test file creates its own organisation, so they run in parallel without clearing data. They cover the claim lifecycle, every MCP tool over real HTTP with the official SDK client, permissions over both MCP and the web (including cross-team, cross-org and revoked tokens), web flows, CSV export and the demo seed.

CI (`.github/workflows/ci.yml`) runs the no-AI guard, type-check, lint, build, all tests against Postgres 16, a smoke test of the production build (`npm start` with migrate + seed, then the landing page and `tools/list` over MCP), and a Docker build.

---

## Deploy (Render + one Neon database)

One Neon database serves both your local copy and the deployed app (same connection string), and it also stores the receipt images, so there is no other service to set up.

1. **Neon.** From the Neon console, copy the **pooled** connection string (host contains `-pooler`) and the **direct** one (same, without `-pooler`).
2. **Render.** New → **Blueprint** → select this repo. `render.yaml` creates only the web service (Singapore, next to Neon `ap-southeast-1`). When prompted, paste the pooled URL as `DATABASE_URL` and the direct URL as `DATABASE_URL_UNPOOLED`; optionally set `DEMO_MCP_TOKEN` / `APP_URL`.
3. First boot applies migrations and, with `SEED_DEMO=true`, seeds the demo org if it isn't there yet. The connector URL is printed in the deploy logs (or derive it from `DEMO_MCP_TOKEN`).

Because local and deployed share the database, data you create locally appears on the deployed app and vice versa. Keep integration tests on a separate `TEST_DATABASE_URL` (they refuse to run against the app's database).

Free-plan caveats: the Render service sleeps when idle (the first request takes ~1 min), and Neon's free tier suspends the database when idle (a second or two on wake). Receipts are capped at 10 MB each.

A `Dockerfile` is included for other hosts. It runs as a non-root user, has a health check, and migrates on start.

### Post-deploy checklist

- [ ] Landing page loads over HTTPS
- [ ] Log in as `admin@acme.test` / `demo1234`
- [ ] Add Riya's connector URL to Claude → *"What's our expense policy?"* → `get_policy` answers
- [ ] Send 3 receipt photos with "log these" → a 3-line draft appears under Riya's claims, flags shown in Claude and on the page
- [ ] As Riya: attach a receipt image, edit a line, submit
- [ ] As Priya: recategorise a line, reject one with a note, approve the rest → **Partly approved**
- [ ] Claim history shows each change with *via Claude* / *via web*
- [ ] As admin: Reports by month, **Export CSV** opens correctly in Excel
- [ ] GitHub Actions: all CI jobs green
