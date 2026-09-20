# QVM Football Workbench

Private full-stack quantitative value modeling (QVM) workbench for Premier League football research and paper-trading simulation.

## Runtime surfaces

- The hosted Site uses a D1-backed Cloudflare Worker API and a responsive Tailwind interface.
- The root Python modules implement the requested FastAPI, SQLAlchemy, HTTP ingestion, SciPy Poisson engine, and Quarter-Kelly parity backend for local or VPS execution.
- Live financial execution is intentionally absent. All seeded and scanned positions are simulated paper bets.

## Hosted data and controls

The first request initializes 10 clubs, 5 completed fixtures, 4 scheduled fixtures, default team metrics, predictions, demo odds, a paper portfolio, and settled history. D1 schema migrations live under drizzle/.

Set ODDS_API_KEY as a private Site runtime variable to enable the 10-second The Odds API refresh path. Without it, the seeded demo snapshot remains usable.

## Local Python parity backend

    python -m venv .venv
    python -m pip install -r requirements.txt
    uvicorn main:app --reload

The FastAPI service exposes /, /edge-finder, /performance, /api/overview, /api/markets, /api/scan, /api/paper-bet, and /api/settle.

The local worker adds `backtesting.py`, `qvm_agents.py`, and `worker_service.py`. Each cycle refreshes odds, recalculates strengths, rebuilds predictions, runs a leakage-safe walk-forward evaluation, applies stale-quote and exposure guardrails, records Manager/Worker reports, and can synchronise a capped snapshot to the private Site. The AI calls use the Responses API with structured JSON output when `OPENAI_API_KEY` and the exact account-enabled `OPENAI_MODEL` are configured; otherwise a deterministic degraded fallback keeps the paper system usable. `README-Windows.md` contains the Windows launcher scripts and Task Scheduler setup.

The hosted Site includes an AI Ops view, model-run metrics, risk status, worker authentication, idempotent fixture/quote synchronisation, closing-price/CLV fields, and a walk-forward backtest route. Set the same random `QVM_WORKER_SHARED_SECRET` in the Windows `.env` and the private Site runtime before enabling sync.

## Windows historical data worker

The historical importer is a local Python worker. It reads EPL E0 result CSVs from Football-Data.co.uk, dynamically adds missing clubs, skips duplicate fixtures, and refreshes `TeamStats` after the import. It uses the local SQLAlchemy database configured by `DATABASE_URL`; it does not place real trades or execute Python inside the hosted Site.

In PowerShell from the project folder:

    py -3.11 -m venv .venv
    .\.venv\Scripts\Activate.ps1
    python -m pip install --upgrade pip
    python -m pip install -r requirements.txt
    Copy-Item .env.example .env
    python seed_historical_data.py
    uvicorn main:app --reload

To import a specific set of seasons, use four-digit Football-Data.co.uk season codes:

    python seed_historical_data.py --seasons 2526 2425 2324

If PowerShell blocks activation, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` for the current terminal only, or invoke `.\.venv\Scripts\python.exe seed_historical_data.py` without activating the environment.

## Mathematical contract

The model uses a 6×6 (0–5 goals) independent Poisson grid, the exact strength normalizations requested, direct fair decimal odds of 1 / probability, a strict edge threshold above 3%, and Quarter-Kelly stake sizing capped at 10% of bankroll. Paper-trading risk controls cap total open exposure at 60% of bankroll and exposure per fixture at 10%.

A clean full-stack starter running on [vinext](https://github.com/cloudflare/vinext), with optional Cloudflare D1 and Drizzle support.

## Prerequisites

- Node.js `>=22.13.0`
- Linux with `flock`, `curl`, and GNU `timeout`

## Sites Lifecycle

The Sites lifecycle CLI runs the locked dependency install before returning this checkout. Edit the source under `app/`, then checkpoint when a coherent milestone is ready to inspect or share. The remote Sites builder runs `npm run build` against the pushed commit. Do not repeat install or build as a normal pre-checkpoint step.

This starter does not use `wrangler.jsonc`.

`install:ci` is intentionally a single, non-retrying `npm ci`. It refuses a concurrent install for the same project, consumes a matching image-seeded npm cache with `--prefer-offline` while retaining registry fallback for a missing cache object, otherwise downloads and verifies the complete vinext tarball recorded in `package-lock.json`, limits npm to one socket, and terminates a stalled install. `build` applies a short timeout. These helpers target Linux and use GNU `timeout`; they are not native macOS scripts.

Scripts that need writable project-scoped home, npm, XDG, and temporary paths use `scripts/sites-env.sh`. The `dev` and `start` scripts honor the caller's runtime environment and keep Wrangler logs inside the checkout. The generated `.sites-runtime/` directory is disposable and ignored by Git.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from `oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Diagnostic Commands

- `npm run install:ci`: perform the one bounded lockfile install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: start the built Vinext application
- `npm test`: build and verify the rendered development-preview metadata
- `npm run db:generate`: generate Drizzle migrations after schema changes

Use build commands for targeted diagnosis after a remote failure, not as part of the normal checkpoint path.

The timeout defaults can be overridden for a controlled canary with `SITES_INSTALL_TIMEOUT`, `SITES_INSTALL_KILL_AFTER`, `SITES_BUILD_TIMEOUT`, and `SITES_BUILD_KILL_AFTER`. A timeout fails the command; the helpers never retry an unchanged install or build.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
