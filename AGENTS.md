# Repository Guidelines

## Project Structure & Module Organization

This repository centers on `platform/`, a four-end gig-work system. The API lives in `platform/server/` with routes in `src/routes/`, services in `src/services/`, jobs in `src/jobs/`, and tests in `tests/*.test.mjs`. The admin and company web apps are `platform/web-admin/` and `platform/web-company/`; both are Vue 3 + Vite apps with pages in `src/views/`, API clients in `src/api/`, stores in `src/stores/`, and shared UI in `src/components/` or `src/layout/`. The worker mini program is in `platform/miniprogram-worker/`. Avoid editing generated `dist/`, `output/`, `screenshots/`, or `reports/` artifacts unless requested.

## Build, Test, and Development Commands

Run commands from the relevant package directory.

- `cd platform/server && npm install` installs API dependencies; `npm run dev` starts the API in watch mode; `npm start` runs it on port 3000.
- `npm run seed` creates local seed data; `npm test` runs migration, tax, copy, integration, and commercial regressions.
- `cd platform/web-admin && npm run dev` starts the admin UI.
- `cd platform/web-company && npm run dev` starts the company UI.
- In either web app, use `npm run build`, `npm run preview`, `npm run lint`, and `npm run format`.
- `node platform/scripts/acceptance.mjs` runs the end-to-end acceptance flow against running services.

## Coding Style & Naming Conventions

Use ES modules throughout JavaScript. Vue files use PascalCase names such as `DashboardView.vue`; route, service, utility, and store modules use lower camel case such as `taxEngine.js` and `configStore.js`. Follow two-space indentation. Web packages use ESLint flat config, `eslint-plugin-vue`, `eslint-config-prettier`, and Prettier.

## Testing Guidelines

Server tests are plain Node `.mjs` scripts under `platform/server/tests/` and are named by capability, for example `taxengine.test.mjs`. Add focused regressions for business rules, migrations, money movement, security controls, and API behavior. For UI changes, run the relevant web build and capture screenshots when layout or workflow behavior changes.

## Commit & Pull Request Guidelines

No Git history is present in this checkout, so use concise imperative commit messages such as `Add settlement retry regression test`. Pull requests should state the affected surface, summarize behavior changes, list verification commands, link issues, and include screenshots for visible UI changes.

## Security & Configuration Tips

Never commit production secrets, live database files, uploads, or private credentials. Production API deployments must set strong `JWT_SECRET`, `WEBHOOK_SECRET`, `SECRETS_KEY`, `METRICS_TOKEN`, and strict `CORS_ORIGINS`. Treat `server/data/`, backups, and adapter credentials as sensitive.
