"""Windows-friendly QVM data, agent, and synchronisation worker."""

from __future__ import annotations

import argparse
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from backtesting import run_walk_forward_backtest
from config import settings
from data_pipeline import DataPipeline
from database import SessionLocal, ensure_schema
from execution import ExecutionAgent
from modeling import rebuild_predictions
from models import AgentRun, Fixture, MarketQuote, Team, WorkerHeartbeat
from calibration import fit_prediction_calibration
from qvm_agents import AgentReport, AuditorAgent, LunaClient, ManagerAgent, WorkerAgent
from advanced_models import portfolio_allocation, record_decision_replay, record_snapshot


LOGGER = logging.getLogger("qvm.worker_service")
if not LOGGER.handlers:
    handler = logging.FileHandler("system.log")
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    LOGGER.addHandler(handler)
    LOGGER.setLevel(logging.INFO)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class SiteClient:
    """Push worker snapshots to the private Site over outbound HTTPS only."""

    def __init__(self) -> None:
        self.base_url = settings.site_url.rstrip("/")
        self.secret = settings.worker_shared_secret

    @property
    def enabled(self) -> bool:
        return bool(self.base_url and self.secret)

    def sync(self, snapshot: dict[str, Any], reports: list[AgentReport]) -> dict[str, Any] | None:
        if not self.enabled:
            LOGGER.info("Site sync is disabled; QVM_SITE_URL or worker secret is missing.")
            return None
        payload = {
            **snapshot,
            "agent_runs": [report.as_dict() for report in reports],
        }
        try:
            # Site sync can take longer than a provider request because the
            # server persists fixtures, quotes, predictions, and agent runs.
            # Keep this timeout separate from the 10-second data-provider
            # timeout so a slow cold start does not lose a completed report.
            with httpx.Client(timeout=max(settings.request_timeout_seconds, 120)) as client:
                response = client.post(
                    f"{self.base_url}/api/qvm/worker/sync",
                    headers={"X-QVM-Worker-Key": self.secret},
                    json=payload,
                )
                response.raise_for_status()
                result = response.json()
                LOGGER.info(
                    "Private Site worker synchronisation completed: fixtures=%s quotes=%s agents=%s.",
                    result.get("fixturesCreated", 0) + result.get("fixturesUpdated", 0),
                    result.get("quotesCreated", 0),
                    result.get("agentsRecorded", 0),
                )
                return result
        except (httpx.HTTPError, ValueError):
            LOGGER.exception("Private Site worker synchronisation failed.")
            return None


class QvmWorkerService:
    """Run one bounded refresh/review/synchronisation cycle."""

    def __init__(self, client: LunaClient | None = None) -> None:
        self.luna = client or LunaClient()
        self.site = SiteClient()
        self.worker_agent = WorkerAgent(self.luna)
        self.manager_agent = ManagerAgent(self.luna)
        self.auditor_agent = AuditorAgent(self.luna)

    def run_once(self) -> dict[str, Any]:
        started = utc_now()
        with SessionLocal() as db:
            heartbeat = db.scalar(select(WorkerHeartbeat).where(WorkerHeartbeat.worker_name == "qvm-worker"))
            if not heartbeat:
                heartbeat = WorkerHeartbeat(worker_name="qvm-worker")
                db.add(heartbeat)
            heartbeat.status = "RUNNING"
            heartbeat.last_started_at = _parse_datetime(started)
            db.commit()
            refresh_error: str | None = None
            try:
                odds_updated = DataPipeline(db).refresh()
            except Exception as error:  # the cycle remains useful with stale data
                odds_updated = 0
                refresh_error = str(error)
                LOGGER.exception("Odds refresh failed; continuing with stored data.")

            DataPipeline(db).update_team_strengths()
            predictions_updated = rebuild_predictions(db)
            backtest = run_walk_forward_backtest(db, persist=True)
            calibration = fit_prediction_calibration(db)
            execution = ExecutionAgent(db)
            candidates = execution.evaluate_upcoming()
            live_snapshot = build_site_snapshot(db)
            available_markets = live_snapshot.get("markets", [])
            risk = execution.risk_summary()
            facts = {
                "run_started_at": started,
                "odds_updated": odds_updated,
                "predictions_updated": predictions_updated,
                "markets": available_markets,
                "available_market_count": len(available_markets),
                "candidates": candidates[:50],
                "risk": risk,
                "backtest": backtest,
                "calibration": {key: value for key, value in calibration.items() if key != "curves"},
                "data_quality": {
                    "refresh_error": refresh_error,
                    "site_sync_enabled": self.site.enabled,
                },
            }
            worker_report = self.worker_agent.run(facts)
            manager_report = self.manager_agent.run(worker_report, facts)
            auditor_report = self.auditor_agent.run(worker_report, manager_report, facts)
            facts["portfolio_allocations"] = portfolio_allocation(candidates, execution._portfolio().current_bankroll)
            snapshot = record_snapshot(db, "qvm-worker", "local-cycle", facts)
            self._save_agent_runs(db, [worker_report, manager_report, auditor_report])
            record_decision_replay(
                db,
                manager_report.payload.get("fixture_id"),
                manager_report.payload.get("decision", "NO_ACTION") if auditor_report.payload.get("status") != "BLOCK" else "BLOCKED_BY_AUDITOR",
                backtest.get("model_version", "unknown"),
                {"risk": risk, "calibration": calibration, "snapshot_id": snapshot.id, "audit": auditor_report.payload},
                [worker_report.as_dict(), manager_report.as_dict(), auditor_report.as_dict()],
            )
            heartbeat.status = "DEGRADED" if refresh_error else "READY"
            heartbeat.last_finished_at = _parse_datetime(utc_now())
            heartbeat.cycles_completed += 1
            heartbeat.last_error = refresh_error
            db.commit()

            paper_trade = self._maybe_place_paper_trade(
                db=db,
                manager_report=manager_report,
                candidates=candidates,
                auditor_report=auditor_report,
            )
            snapshot = build_site_snapshot(db)
            snapshot["model_runs"] = [backtest]
            sync_result = self.site.sync(snapshot, [worker_report, manager_report, auditor_report])

        result = {
            "started_at": started,
            "finished_at": utc_now(),
            "worker": worker_report.as_dict(),
            "manager": manager_report.as_dict(),
            "auditor": auditor_report.as_dict(),
            "paper_trade": paper_trade,
            "site_sync": sync_result,
        }
        cycle_status = "SUCCEEDED" if sync_result is not None else "DEGRADED"
        LOGGER.info(
            "QVM worker cycle completed: worker=%s manager=%s site_sync=%s.",
            worker_report.status,
            manager_report.status,
            cycle_status,
        )
        return result

    @staticmethod
    def _save_agent_runs(db: Session, reports: list[AgentReport]) -> None:
        for report in reports:
            db.add(
                AgentRun(
                    agent_name=report.agent_name,
                    role=report.role,
                    model=report.model,
                    status=report.status,
                    task=report.task,
                    summary=report.summary,
                    payload=json.dumps(report.payload, ensure_ascii=False, default=str),
                    started_at=_parse_datetime(report.started_at),
                    finished_at=_parse_datetime(report.finished_at),
                )
            )
        db.commit()

    @staticmethod
    def _maybe_place_paper_trade(
        db: Session,
        manager_report: AgentReport,
        candidates: list[dict[str, Any]],
        auditor_report: AgentReport,
    ) -> dict[str, Any]:
        if auditor_report.payload.get("status") == "BLOCK":
            return {"status": "BLOCKED_BY_AUDITOR", "violations": auditor_report.payload.get("violations", [])}
        if not settings.auto_paper_trades:
            return {"status": "MANUAL_APPROVAL_REQUIRED"}
        decision = manager_report.payload
        if decision.get("decision") != "PAPER_TRADE_RECOMMENDATION":
            return {"status": "NOT_RECOMMENDED"}
        fixture_id = decision.get("fixture_id")
        selection = decision.get("selection")
        candidate = next(
            (
                item
                for item in candidates
                if item.get("fixture_id") == fixture_id
                and item.get("selection") == selection
                and float(item.get("edge_pct", 0)) > settings.edge_threshold
            ),
            None,
        )
        if candidate is None:
            return {"status": "REJECTED_BY_DETERMINISTIC_GATE"}
        try:
            bet = ExecutionAgent(db).place_paper_bet(int(fixture_id), str(selection))
            return {"status": "PLACED", "bet_id": bet.id}
        except (TypeError, ValueError) as error:
            return {"status": "REJECTED_BY_DETERMINISTIC_GATE", "reason": str(error)}


def _parse_datetime(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=None)


def build_site_snapshot(db: Session) -> dict[str, Any]:
    """Serialise local SQL rows into the small payload accepted by the Site."""

    teams = list(db.scalars(select(Team)).all())
    fixtures = list(
        db.scalars(select(Fixture).order_by(Fixture.match_date, Fixture.id)).all()
    )
    quotes = list(
        db.scalars(
            select(MarketQuote).order_by(
                MarketQuote.captured_at.desc(), MarketQuote.id.desc()
            )
        ).all()
    )
    names = {team.id: team.name for team in teams}
    latest_quotes: dict[int, MarketQuote] = {}
    for quote in quotes:
        latest_quotes.setdefault(quote.fixture_id, quote)
    fixture_payload = [
        {
            "home_team": names.get(fixture.home_team_id, ""),
            "away_team": names.get(fixture.away_team_id, ""),
            "match_date": fixture.match_date.isoformat(),
            "home_goals": fixture.home_goals,
            "away_goals": fixture.away_goals,
            "status": fixture.status,
        }
        for fixture in fixtures[-500:]
    ]
    markets = []
    for fixture in fixtures:
        quote = latest_quotes.get(fixture.id)
        if not quote:
            continue
        markets.append(
            {
                "home_team": names.get(fixture.home_team_id, ""),
                "away_team": names.get(fixture.away_team_id, ""),
                "match_date": fixture.match_date.isoformat(),
                "provider": quote.provider,
                "home_odds": quote.home_odds,
                "draw_odds": quote.draw_odds,
                "away_odds": quote.away_odds,
                "captured_at": quote.captured_at.isoformat(),
            }
        )
    return {
        "source": "windows-qvm-worker",
        "fetched_at": utc_now(),
        "fixtures": fixture_payload,
        "markets": markets[-500:],
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the QVM Windows worker.")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one refresh/agent/sync cycle and exit.",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=settings.worker_interval_seconds,
        help="Seconds between cycles when running continuously.",
    )
    return parser.parse_args()


def initialise_database() -> None:
    ensure_schema()
    with SessionLocal() as db:
        if db.scalar(select(Team).limit(1)) is None:
            # Reuse the application seed so the worker can run before the web
            # server has ever been opened on this Windows machine.
            from main import seed_initial_data

            seed_initial_data(db)


def main() -> int:
    args = parse_args()
    initialise_database()
    service = QvmWorkerService()
    if args.once:
        service.run_once()
        return 0
    interval = max(30, args.interval)
    while True:
        service.run_once()
        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
