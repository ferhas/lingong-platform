# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

灵工云 — a Chinese flexible-employment (gig work) platform built on the **承揽后分包 (contract-then-subcontract) model**: the platform itself is the contracting party between companies (B端) and gig workers (C端), not a matchmaker. This drives everything: the platform issues full invoices to companies, withholds taxes for workers, holds funds in bank escrow, and must keep a complete "four flows" evidence chain (contracts / business / funds / invoices) for its own compliance.

Key documents (read these before significant feature work):
- `方案.txt` — the business/legal design spec all modules derive from
- `platform/README.md` — feature inventory (v2–v5 changelogs) and deployment checklist
- `platform/API.md` — the API contract (conventions, endpoints, state machines)

The codebase is written in Chinese (comments, UI copy, error messages). Keep new copy in Chinese and match existing tone — `tests/copy.test.mjs` regression-tests user-facing wording.

## Layout: four ends

| Directory | What | Stack | Port |
|---|---|---|---|
| `platform/server/` | API + jobs | Node 22, Express, better-sqlite3 (WAL), JWT | 3000 |
| `platform/web-company/` | Company (B端) web | Vue 3 + Vite + Element Plus + Pinia | 5173 |
| `platform/web-admin/` | Platform ops (Admin) web | Vue 3 + Vite + Element Plus + Pinia | 5174 |
| `platform/miniprogram-worker/` | Worker (C端) | Native WeChat miniprogram | — |

Both web apps proxy `/api` → `http://127.0.0.1:3000` in dev. The miniprogram's API base is hardcoded in `miniprogram-worker/app.js` (`globalData.apiBase`); open it with WeChat DevTools.

## Commands

```powershell
# Server (from platform/server/)
npm run dev          # node --watch
npm start
npm run seed         # creates admin 13800000001 / Admin@123456
npm test             # runs all 5 test files sequentially

# Single test file — tests are plain node scripts, no test runner:
node tests/integration.test.mjs    # also: migration / taxengine / copy / commercial

# Web apps (from platform/web-company/ or platform/web-admin/)
npm run dev / build / lint / format

# Ops scripts
node platform/scripts/acceptance.mjs            # full business-flow acceptance against a RUNNING server
node platform/server/scripts/backup.mjs         # SQLite snapshot backup (keeps 14)
node platform/scripts/screenshot.mjs <cfg.json> # headless Edge CDP screenshots
```

Tests self-bootstrap: each sets `NODE_ENV=test`, a temp `DB_PATH`/`UPLOAD_DIR`, and starts the app in-process — no server or setup needed. `NODE_ENV=test` skips rate limiting and enables `_testHooks.failNext` in `src/integrations/index.js` for injecting channel failures (e.g. bank outage during settlement).

## Server architecture

- **`src/db.js`** — entire schema plus idempotent migrations (CREATE IF NOT EXISTS + try/catch ALTER TABLE) in one file; runs on import. No migration tool. Money columns are INTEGER **cents (分)**; the API layer converts to yuan (`src/utils/money.js`). `migration.test.mjs` guards this file.
- **`src/routes/`** — split by audience: `worker` / `company` / `admin` + `adminOps` / `me` (cross-role) / `files` / `webhooks` / `openapi` (HMAC-signed partner API at `/api/open/v1`) / `metrics` (Prometheus). Roles are isolated; cross-role access is 403. Admin endpoints are gated by RBAC permission points (`middleware/rbac.js`, e.g. `company:review`, `tax:declare`); sensitive admin ops additionally require TOTP step-up (`X-TOTP-Code`).
- **`src/services/`** — business logic. The critical ones: `settlement.js` (two-phase settlement: idempotent settlement record → per-leg escrow transfers with idem keys; failures stay `pending` for job retry), `taxEngine.js` (routes by worker subject type — natural person gets cumulative-withholding income tax + VAT threshold monitoring; sole trader (个体户) requires an input invoice and no withholding), `configStore.js` (tax rates / thresholds / forbidden words etc. live in DB, editable from admin UI at runtime — don't hardcode business parameters).
- **`src/integrations/index.js`** — adapter layer for all external services (公安实名, escrow bank, 数电票, e-sign, tax bureau, insurance, SMS). These are mocks with production-identical signatures; production swaps implementations without changing callers. All calls are logged to `integration_calls`.
- **`src/jobs/`** — 10 node-cron jobs (settlement retry, withdrawal T+1 payout, auto-acceptance, daily reconciliation, dispute timeout flow, webhook replay, housekeeping…). Process role split via `ROLE` env: `all` (default) / `api` (multi-instance) / `worker` (jobs only, single instance).
- **Webhooks** (`/api/v1/webhooks/:provider`) verify HMAC over the **raw body** — the route is mounted before `express.json()` in `app.js`; keep it that way.

## Invariants to preserve

- **Four-flows hard validation** (the compliance core, enforced in code, not audit): no signed work order → no settlement; no deliverable → no acceptance; no acceptance → no invoice; no invoice basis → no fund split. Don't add bypasses.
- All fund operations happen inside SQLite transactions; escrow transfers carry idempotency keys. Local balances mirror the escrow bank — recharge is driven by bank inbound callbacks, not client requests.
- A dispute on a task freezes its settlement (neither unfreeze nor payout) until adjudicated.
- Error responses are always `{ error: { code: 'STRING_CODE', message: '人话描述' } }`; pagination is `?page&pageSize` → `{ list, total }`.
- Worker ID numbers are envelope-encrypted (`services/secrets.js`); phone numbers are masked by default — full PII requires the `user:read_pii` permission and is audited.
