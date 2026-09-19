# QVM Football Workbench on Windows

This bundle runs the local SQLAlchemy/SciPy model, historical importer, deterministic risk engine, and bounded Manager/Worker agents. It never places a real financial trade.

## 1. Install

Install Python 3.11, 3.12, or 3.13 x64 and make sure the Python Launcher (`py`) is available. The installer automatically selects the newest supported version. Open PowerShell in this folder and run:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\install_windows.ps1
```

The installer creates `.venv`, installs the pinned dependency ranges, and creates `.env` from `.env.windows.example` when needed.

## 2. Configure private values

Edit `.env`:

- `ODDS_API_KEY` enables the 10-second The Odds API refresh.
- `OPENAI_API_KEY` enables the two agent calls.
- `OPENAI_MODEL` must be the exact model identifier enabled for your account. `LUNA_MODEL_LABEL=Luna Max` is the operating profile label; do not guess a model ID.
- `QVM_SITE_URL` is the private Site URL.
- `QVM_WORKER_SHARED_SECRET` must match the private Site runtime variable with the same name. Generate a random value, for example: `[guid]::NewGuid().ToString("N")`.
- Keep `AUTO_PAPER_TRADES=false` until you have reviewed the full audit trail. Manager recommendations are manual-approval-required by default.

The worker sends only outbound HTTPS requests. It does not open an inbound port. Local data is stored in `qvm.sqlite3`; operational errors and agent status are written to `system.log`.

## 2a. Model and simulation controls

The default model is a conservative Dixon–Coles variant with a 10×10 score grid and explicit tail-mass reporting. The worker also records calibration buckets, model runs, data-quality scores, slippage, commission fields, and worker heartbeats. Set `MIN_DATA_QUALITY_SCORE=75` for a stricter production filter after importing a deep history.

Historical odds are required for meaningful ROI backtests. Without them, the dashboard reports predictive metrics but does not claim a historical trading return.

Optional enrichment can be enabled with `FOOTBALL_ENRICHMENT_URL` and `FOOTBALL_ENRICHMENT_API_KEY`; the connector stores player availability, lineup/event payloads and source snapshots without replacing the deterministic model. Historical quote imports can be run with `historical_odds.py` after configuring `HISTORICAL_ODDS_URL` and `HISTORICAL_ODDS_API_KEY`.

The Research Lab records decision replays, source hashes, calibration buckets, worker heartbeats, portfolio scenarios and champion/challenger experiment results. These records are retained locally in SQL for future benchmark comparisons.

## 3. Import history and run a smoke cycle

```powershell
& .\.venv\Scripts\python.exe seed_historical_data.py --seasons 2526 2425 2324
.\run_qvm_worker.ps1 -Once
```

The first worker run initializes the seed data if the database is empty, refreshes odds, recalculates strengths and predictions, runs the leakage-safe walk-forward evaluation, calls the Worker and Manager agents when configured, and synchronizes a capped snapshot to the private Site.

For continuous operation:

```powershell
.\run_qvm_worker.ps1 -Interval 300
```

For the local FastAPI dashboard:

```powershell
.\run_qvm_web.ps1
```

Then open `http://127.0.0.1:8000`.

## 4. Windows Task Scheduler

Create a task that runs `powershell.exe` with these arguments:

```text
-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\qvm\run_qvm_worker.ps1"
```

Use one instance only, start it after network availability, and run it under the Windows account that owns the `.env` and `.venv` files.

## Safety contract

The deterministic engine remains authoritative for probabilities, edge thresholds, Quarter-Kelly sizing, stale-quote checks, per-wager caps, fixture exposure, daily loss, and the kill switch. AI agents can explain and recommend paper action but cannot change those limits or execute a live trade.
