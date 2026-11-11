# Spendwise — Project Context

> Receipt and expense approvals for small teams, run from Claude.
> The customer's own Claude plan does the AI work. Spendwise does everything else.

This file is the source of truth for what we are building and why. Read it before writing code.

---

## 1. The idea in one paragraph

Employees at small companies (5–200 people) lose hours turning receipts into expense claims, and managers lose hours chasing and checking them. With Spendwise, an employee drops receipt photos into **their own Claude** and says *"Log these from my Bangalore trip."* Claude reads each receipt (merchant, date, amount, GST, category), checks it against the company's spending policy, and sends the claim to Spendwise through MCP. Spendwise stores it, puts it in the manager's approval queue, lets people fix mistakes, keeps an audit trail, and gives finance monthly reports and a CSV export for accounting.

**Spendwise has no AI inside it.** It holds no OpenAI, Anthropic or other model keys and makes no AI calls. Every bit of "reading" and "writing" happens in the customer's Claude. Spendwise is a normal web app plus an MCP server.

---

## 2. Hard requirements (from the assignment)

| # | Requirement | How Spendwise meets it |
|---|---|---|
| 1 | **Works from Claude.** Typing a request in Claude creates something real in the app. | `create_claim` MCP tool creates a claim with line items in the database. |
| 2 | **A person can change it.** Open the app, see what Claude created, edit it. | Claim detail page: edit any line, recategorise, attach receipt image, approve/reject. |
| 3 | **Live on the internet.** Reviewers can try it themselves. | Deployed on Render (or Railway/Fly) with a public URL and a demo org. |
| 4 | **No AI inside.** No AI keys anywhere. | No AI SDKs in `package.json`; CI check greps for them (see §11). |

---

## 3. Users and roles

| Role | Who | Can do |
|---|---|---|
| **Employee** | Anyone who spends company money | Create/edit own draft claims (via Claude or app), submit, see status |
| **Manager** | Team lead | Everything an employee can do, plus approve/reject claims from their direct reports |
| **Admin / Finance** | Founder, finance person | Everything, plus edit policy, manage members, see all claims, reports, CSV export, mark claims as paid |

One user belongs to one **organisation** (v1). Each user has one `manager_id` (nullable for top of tree; admins approve those).

---

## 4. Core flows

### 4.1 Employee logs a trip (the demo flow)
1. In Claude: *"Here are 5 receipts from my Bangalore trip, 3–5 Nov. Log them."*
2. Claude calls `get_policy` → learns categories, limits, rules.
3. Claude reads the photos and calls `create_claim` with a title, trip dates and one expense per receipt.
4. Spendwise saves the claim as **draft** and runs its **rule checks** (normal code, not AI): over limit, missing GSTIN above threshold, weekend spend, duplicate receipt, date outside trip. It returns the claim ID, the totals, any flags and a link to the claim.
5. Claude tells the user what was logged and what was flagged. If the user says "submit it", Claude calls `submit_claim`.
6. The employee can open the link, attach the receipt images, fix a line and submit from the app instead.

### 4.2 Manager approves
1. Manager opens **Approvals** in the web app and sees the queue with flags highlighted.
2. Opens a claim, changes "Meals" → "Client entertainment" on one line, rejects one line with a note ("personal, not reimbursable") and approves the rest.
3. Every change is written to the audit log (who, what, before → after, when).
4. Optional: the manager can also ask *their* Claude: "What's waiting for my approval?" → `list_pending_approvals`.

### 4.3 Finance closes the month
1. **Reports** page: spend by person, category and month; approved vs pending vs rejected.
2. **Mark as paid** on approved claims (single or bulk).
3. **Export CSV** for Tally / Zoho Books / Xero import.
4. Or in Claude: "Summarise October spend by team and tell me who's over budget" → `get_spend_report`.

---

## 5. Data model

Postgres in production (SQLite allowed for local dev). Money is stored as **integer paise** (`amount_minor`), never floats. Default currency INR.

```
organisations
  id, name, base_currency (default 'INR'), created_at

users
  id, org_id, email (unique), name, password_hash (scrypt/argon2),
  role ('employee'|'manager'|'admin'), manager_id (nullable → users.id),
  created_at

mcp_tokens
  id, user_id, token_hash, label, last_used_at, created_at, revoked_at
  -- the raw token is shown once; only the hash is stored

policy  (one row per org)
  org_id, receipt_required_above_minor, gstin_required_above_minor,
  allow_weekend_spend (bool), notes (free text shown to Claude)

categories
  id, org_id, name, code (for accounting export), per_item_limit_minor (nullable),
  per_day_limit_minor (nullable), active

claims
  id, org_id, user_id, title, purpose, trip_start, trip_end,
  status ('draft'|'submitted'|'approved'|'partially_approved'|'rejected'|'paid'),
  submitted_at, decided_at, decided_by, paid_at, source ('claude'|'web'),
  created_at, updated_at

expenses
  id, claim_id, date, merchant, category_id, description,
  amount_minor, currency, fx_rate (nullable, for non-INR),
  gstin (nullable), taxable_minor, cgst_minor, sgst_minor, igst_minor,
  payment_method ('personal_card'|'cash'|'upi'|'company_card'),
  receipt_url (nullable), status ('pending'|'approved'|'rejected'),
  reviewer_note, flags (json array of flag codes), created_at, updated_at

comments
  id, claim_id, user_id, body, created_at

audit_log
  id, org_id, actor_user_id, actor_via ('web'|'mcp'), entity, entity_id,
  action, before (json), after (json), created_at
```

### Rule checks (deterministic code, run on create/update)
| Flag code | Rule |
|---|---|
| `OVER_ITEM_LIMIT` | amount > category.per_item_limit |
| `OVER_DAY_LIMIT` | sum for category on that date > per_day_limit |
| `MISSING_RECEIPT` | amount > receipt_required_above and no receipt_url (only checked on submit) |
| `MISSING_GSTIN` | amount > gstin_required_above and gstin empty |
| `GST_MISMATCH` | taxable + cgst + sgst + igst ≠ amount (±₹1 tolerance) |
| `WEEKEND` | date is Sat/Sun and policy disallows weekend spend |
| `OUTSIDE_TRIP` | date outside trip_start..trip_end |
| `POSSIBLE_DUPLICATE` | same user, merchant, date and amount in another claim |
| `INVALID_GSTIN` | GSTIN fails format/checksum validation |

Flags are warnings for the approver, not blockers.

---

## 6. MCP server

### Transport and auth
- **Streamable HTTP** at `POST /mcp` (spec: https://modelcontextprotocol.io). JSON responses; SSE not required for v1.
- Use the official TypeScript SDK `@modelcontextprotocol/sdk` (`StreamableHTTPServerTransport`, stateless mode).
- **Auth v1:** per-user secret in the connector URL: `https://<host>/mcp/<token>`. The user copies it from **Settings → Connect Claude** and adds it in Claude as a custom connector. Look up by `sha256(token)`; reject revoked tokens.
- **Auth v2 (later):** OAuth 2.1 with dynamic client registration, so the user just logs in.
- Every tool runs **as the token's user** and obeys the same permission rules as the web app. Every write goes to `audit_log` with `actor_via='mcp'`.

### Tools

Descriptions matter: Claude reads them to decide what to do. Keep them clear, and tell Claude to call `get_policy` first.

| Tool | Who | Input | Returns |
|---|---|---|---|
| `get_policy` | all | – | categories (name, code, limits), thresholds, weekend rule, policy notes, user's role and manager |
| `create_claim` | all | `title`, `purpose?`, `trip_start?`, `trip_end?`, `expenses[]` (see below), `submit?` (default false) | claim id, status, totals (gross, GST), per-line flags, `app_url` |
| `add_expenses` | owner, draft only | `claim_id`, `expenses[]` | updated totals + flags |
| `update_expense` | owner (draft) or approver | `expense_id`, any expense field | updated line + flags |
| `submit_claim` | owner | `claim_id` | new status, approver name |
| `list_my_claims` | all | `status?`, `from?`, `to?` | claims with totals and status |
| `get_claim` | owner, approver, admin | `claim_id` | full claim, lines, flags, comments, history |
| `list_pending_approvals` | manager, admin | – | submitted claims awaiting this user |
| `decide_claim` | manager, admin | `claim_id`, `decisions[]` `{expense_id, approve: bool, note?}` or `approve_all: bool`, `note?` | new status |
| `get_spend_report` | admin (managers: own team) | `from`, `to`, `group_by` ('user'\|'category'\|'month') | rows of totals + counts |

Expense input shape (used by `create_claim` and `add_expenses`):
```json
{
  "date": "2026-11-03",
  "merchant": "Truffles, Koramangala",
  "category": "Meals",            // name or code; must match get_policy
  "description": "Team dinner with client",
  "amount": 2360.00,              // in major units; server converts to paise
  "currency": "INR",
  "gstin": "29ABCDE1234F1Z5",
  "taxable_amount": 2000.00,
  "cgst": 180.00, "sgst": 180.00, "igst": 0,
  "payment_method": "personal_card"
}
```

**Receipt images:** in v1 Claude sends the extracted *fields*, not the image bytes (large base64 blobs through tool calls are unreliable). The employee attaches the image on the claim page (drag-and-drop, stored in S3-compatible storage or on local disk in dev). `MISSING_RECEIPT` reminds them.

Validation errors must be returned as clear tool errors (e.g. *"Unknown category 'Food'. Valid categories: Meals, Travel, Lodging, …"*) so Claude can correct itself and retry.

---

## 7. Web app

Server-rendered pages (simple HTML + a little JS) are fine for v1. Mobile-friendly.

| Route | Page |
|---|---|
| `/` | Landing page: what it is, how it works (3 steps), pricing, "Try the demo" |
| `/signup`, `/login`, `/logout` | Email + password. Signup creates an org and makes the user admin |
| `/claims` | My claims, filter by status |
| `/claims/:id` | Claim detail: editable line table, live totals, flags as badges, receipt upload per line, comments, history, Submit / Approve / Reject buttons by role |
| `/approvals` | Manager queue, oldest first, flag counts shown |
| `/reports` | Admin: spend by person/category/month, date filter, **Export CSV** |
| `/settings/policy` | Admin: categories, limits, thresholds, policy notes |
| `/settings/team` | Admin: invite members (invite link), set role and manager |
| `/settings/connect` | Generate/revoke MCP token, copy connector URL, step-by-step "Add to Claude" instructions |

CSV export columns: `claim_id, employee, email, date, merchant, category, category_code, description, amount, currency, taxable, cgst, sgst, igst, gstin, payment_method, status, approver, decided_at, paid_at`.

---

## 8. Tech stack

- **Runtime:** Node.js 22, TypeScript
- **HTTP:** Express (or Hono)
- **MCP:** `@modelcontextprotocol/sdk`
- **DB:** Postgres (Neon or Render Postgres free tier) via Drizzle or Kysely, with migrations checked in
- **Validation:** Zod (shared between MCP tool schemas and web forms)
- **Auth:** session cookie (httpOnly, secure, sameSite=lax), passwords hashed with scrypt/argon2
- **Files:** S3-compatible bucket (Cloudflare R2) for receipt images; local disk in dev
- **Views:** server-rendered templates (EJS/Eta) or a small React SPA; keep it simple
- **Tests:** Vitest; an MCP integration test that calls each tool over HTTP

**Explicitly banned dependencies:** `openai`, `@anthropic-ai/sdk`, `@google/generative-ai`, `langchain`, `ai` (Vercel AI SDK), `cohere-ai`, `@mistralai/*`, and any OCR/vision API client. Claude does the reading.

---

## 9. Repo layout

```
/
├─ CONTEXT.md            ← this file
├─ README.md             ← setup, deploy, "connect to Claude" guide
├─ package.json
├─ .env.example          ← DATABASE_URL, SESSION_SECRET, APP_URL, S3_* (no AI keys)
├─ render.yaml           ← web service + Postgres
├─ Dockerfile
├─ src/
│  ├─ server.ts          ← Express app, mounts web routes and /mcp
│  ├─ mcp/
│  │  ├─ server.ts       ← MCP server + transport, token auth
│  │  └─ tools/*.ts      ← one file per tool
│  ├─ domain/
│  │  ├─ claims.ts       ← create/update/submit/decide (used by BOTH web and MCP)
│  │  ├─ rules.ts        ← rule checks → flags
│  │  ├─ gstin.ts        ← GSTIN format + checksum
│  │  ├─ reports.ts
│  │  └─ money.ts        ← major↔minor units, formatting (₹1,23,456.00)
│  ├─ db/ (schema.ts, migrations/, seed.ts)
│  ├─ web/ (routes/, views/, public/)
│  └─ auth/
└─ tests/
```

**Rule:** business logic lives only in `src/domain/`. The web routes and the MCP tools are thin layers over the same functions, so Claude and humans always get the same behaviour and permissions.

---

## 10. Demo data and reviewer access

`npm run seed` creates the org **Acme Travel Pvt Ltd**:
- `admin@acme.test` (admin/finance), `manager@acme.test` (manager), `riya@acme.test` and `arjun@acme.test` (employees reporting to the manager). Password for all: `demo1234`.
- Categories: Travel (flights/trains/cabs), Lodging (₹6,000/night), Meals (₹1,500/item, ₹2,500/day), Client entertainment (₹10,000), Software, Office supplies, Other.
- Policy: receipt required above ₹500, GSTIN required above ₹2,000, no weekend spend without a note.
- About 3 months of past claims across all statuses, so reports look real.
- The README shows the MCP URL for Riya's demo token, so reviewers can connect Claude in one step.

---

## 11. Definition of done (v1)

- [ ] Deployed at a public HTTPS URL; landing page loads.
- [ ] A reviewer can add the connector URL to Claude, send 3 receipt photos with "log these", and see a new **draft claim with 3 correct lines** in the web app.
- [ ] Rule flags show in both the tool response and the web UI.
- [ ] The employee can edit a line and upload a receipt image in the app, then submit.
- [ ] The manager sees it in **Approvals**, recategorises one line, rejects one with a note and approves the rest → status `partially_approved`.
- [ ] Audit log shows each change and whether it came from `web` or `mcp`.
- [ ] Admin report shows the month's totals; CSV export downloads and opens in Excel.
- [ ] Permissions: an employee's token can't read another employee's claim (test).
- [ ] **No-AI check passes:** CI fails if `package.json` or the source contains any banned package or an env var matching `/(OPENAI|ANTHROPIC|GEMINI|MISTRAL|COHERE)_/`.

## 12. Out of scope for v1 (roadmap)

OAuth connector login · company card feed and auto-matching · multi-level approvals · per-diem rules · multi-currency FX lookup · email/Slack notifications for approvals · Tally/Zoho direct sync · mobile app · reimbursements via bank payout (a natural Volopay hook).

## 13. Business model

- **Free:** up to 5 users, 50 claims/month.
- **Team:** ₹199 per user per month: unlimited claims, reports, CSV export.
- **Business:** ₹399 per user per month: multi-level approvals, accounting sync, SSO.

Spendwise's running cost per customer is close to zero because it never pays for AI. The customer's Claude does the receipt reading.
