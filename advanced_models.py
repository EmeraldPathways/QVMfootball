"""Advanced, testable research services for the QVM worker."""

from __future__ import annotations

import hashlib
import json
import math
import random
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from config import settings
from models import (
    DataSnapshot,
    DecisionReplay,
    ExperimentRun,
    Fixture,
    FixtureEvent,
    MarketQuote,
    Player,
    PortfolioScenario,
)


def record_snapshot(db: Session, source: str, endpoint: str, payload: Any) -> DataSnapshot:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False, default=str)
    snapshot = DataSnapshot(
        source=source,
        endpoint=endpoint,
        content_hash=hashlib.sha256(raw.encode()).hexdigest(),
        payload=raw,
    )
    db.add(snapshot)
    db.commit()
    return snapshot


def calculate_player_adjustment(db: Session, team_id: int) -> dict[str, float | int]:
    players = list(db.scalars(select(Player).where(Player.team_id == team_id)).all())
    available = [p for p in players if p.availability in ("AVAILABLE", "PROBABLE")]
    expected = sum(max(0.0, p.expected_minutes) for p in available)
    attack = sum(p.attack_rating * max(0.0, p.expected_minutes) for p in available) / max(expected, 1.0)
    defence = sum(p.defence_rating * max(0.0, p.expected_minutes) for p in available) / max(expected, 1.0)
    return {"available_players": len(available), "expected_minutes": round(expected, 1), "attack_delta": round(attack, 4), "defence_delta": round(defence, 4)}


def record_fixture_event(db: Session, fixture_id: int, minute: int, event_type: str, *, team_id: int | None = None, xg: float | None = None, payload: dict[str, Any] | None = None) -> FixtureEvent:
    event = FixtureEvent(fixture_id=fixture_id, minute=minute, event_type=event_type, team_id=team_id, xg=xg, payload=json.dumps(payload or {}))
    db.add(event)
    db.commit()
    return event


def portfolio_allocation(candidates: list[dict[str, Any]], bankroll: float, max_total_pct: float | None = None) -> list[dict[str, Any]]:
    """Allocate candidates under the configured total and fixture exposure caps."""
    eligible = [item for item in candidates if float(item.get("edge_pct", 0)) > 0 and float(item.get("suggested_stake", 0)) > 0]
    total_cap = bankroll * (settings.max_open_exposure_pct if max_total_pct is None else max_total_pct)
    raw_total = sum(float(item["suggested_stake"]) for item in eligible)
    scale = min(1.0, total_cap / raw_total) if raw_total else 0.0
    result = []
    bucket_totals: dict[str, float] = {}
    for item in sorted(eligible, key=lambda value: float(value["edge_pct"]), reverse=True):
        bucket = str(item.get("fixture_id", item.get("home_team", "unknown")))
        proposed = float(item["suggested_stake"]) * scale
        remaining = max(
            0.0,
            bankroll * settings.max_fixture_exposure_pct - bucket_totals.get(bucket, 0.0),
        )
        stake = min(proposed, remaining)
        bucket_totals[bucket] = bucket_totals.get(bucket, 0.0) + stake
        result.append({**item, "portfolio_stake": round(stake, 2), "correlation_bucket": bucket})
    return result


def run_counterfactual(bankroll: float, probability: float, odds: float, stake: float, *, probability_shift: float = 0.0, odds_shift: float = 0.0, commission_pct: float = 0.0, simulations: int = 1000) -> dict[str, float]:
    rng = random.Random(42)
    p = min(max(probability + probability_shift, 0.001), 0.999)
    effective_odds = max(1.001, odds + odds_shift)
    outcomes = []
    for _ in range(simulations):
        won = rng.random() < p
        gross = stake * (effective_odds - 1) if won else -stake
        commission = max(0.0, gross) * commission_pct
        outcomes.append(gross - commission)
    sorted_outcomes = sorted(outcomes)
    return {
        "expected_profit": round(sum(outcomes) / len(outcomes), 2),
        "p_loss": round(sum(value < 0 for value in outcomes) / len(outcomes), 4),
        "p05_profit": round(sorted_outcomes[max(0, int(len(outcomes) * 0.05))], 2),
        "p95_profit": round(sorted_outcomes[int(len(outcomes) * 0.95)], 2),
        "bankroll_after_expected": round(bankroll + sum(outcomes) / len(outcomes), 2),
    }


def record_decision_replay(db: Session, fixture_id: int | None, decision: str, model_version: str, checks: dict[str, Any], agent_reports: list[dict[str, Any]] | None = None) -> DecisionReplay:
    replay = DecisionReplay(fixture_id=fixture_id, decision=decision, model_version=model_version, deterministic_checks=json.dumps(checks, default=str), agent_reports=json.dumps(agent_reports or [], default=str))
    db.add(replay)
    db.commit()
    return replay


def detect_drift(recent_scores: list[float], baseline_scores: list[float], threshold: float = 0.05) -> dict[str, float | bool]:
    if not recent_scores or not baseline_scores:
        return {"drift": False, "delta": 0.0}
    recent = sum(recent_scores) / len(recent_scores)
    baseline = sum(baseline_scores) / len(baseline_scores)
    delta = recent - baseline
    return {"drift": abs(delta) >= threshold, "delta": round(delta, 6), "recent_mean": round(recent, 6), "baseline_mean": round(baseline, 6)}


def save_experiment(db: Session, name: str, champion: str, challenger: str, metrics: dict[str, Any]) -> ExperimentRun:
    run = ExperimentRun(experiment_name=name, champion_version=champion, challenger_version=challenger, metrics_json=json.dumps(metrics, default=str))
    db.add(run)
    db.commit()
    return run


def save_portfolio_scenario(db: Session, name: str, assumptions: dict[str, Any], result: dict[str, Any]) -> PortfolioScenario:
    scenario = PortfolioScenario(scenario_name=name, assumptions_json=json.dumps(assumptions), result_json=json.dumps(result))
    db.add(scenario)
    db.commit()
    return scenario
