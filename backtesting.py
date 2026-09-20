"""Leakage-safe walk-forward evaluation for the local QVM model."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime
from math import exp, factorial, log
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import Fixture, ModelRun


GRID_SIZE = 6
DEFAULT_HOME_GOALS = 1.8
DEFAULT_AWAY_GOALS = 1.2


@dataclass
class BacktestResult:
    model_version: str
    evaluation_type: str
    fixtures_available: int
    fixtures_evaluated: int
    brier_score: float | None
    log_loss: float | None
    hit_rate: float | None
    average_tail_mass: float | None
    roi_pct: float | None
    max_drawdown_pct: float | None
    note: str
    created_at: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def _poisson_pmf(goals: int, mean: float) -> float:
    if mean <= 0:
        return 1.0 if goals == 0 else 0.0
    return exp(-mean) * (mean**goals) / factorial(goals)


def _strength(total: float, games: int, league_average: float) -> float:
    if games <= 0 or league_average <= 0:
        return 1.0
    return (total / games) / league_average


def _probabilities(lambda_home: float, lambda_away: float) -> tuple[float, float, float, float]:
    matrix = [
        [
            _poisson_pmf(home_goals, lambda_home)
            * _poisson_pmf(away_goals, lambda_away)
            for away_goals in range(GRID_SIZE)
        ]
        for home_goals in range(GRID_SIZE)
    ]
    mass = sum(sum(row) for row in matrix)
    if mass <= 0:
        return 1 / 3, 1 / 3, 1 / 3, 1.0
    home = sum(
        matrix[home_goals][away_goals]
        for home_goals in range(GRID_SIZE)
        for away_goals in range(GRID_SIZE)
        if home_goals > away_goals
    )
    draw = sum(
        matrix[home_goals][away_goals]
        for home_goals in range(GRID_SIZE)
        for away_goals in range(GRID_SIZE)
        if home_goals == away_goals
    )
    away = sum(
        matrix[home_goals][away_goals]
        for home_goals in range(GRID_SIZE)
        for away_goals in range(GRID_SIZE)
        if away_goals > home_goals
    )
    return home / mass, draw / mass, away / mass, max(0.0, 1.0 - mass)


def _actual_outcome(fixture: Fixture) -> int:
    if (fixture.home_goals or 0) > (fixture.away_goals or 0):
        return 0
    if (fixture.home_goals or 0) == (fixture.away_goals or 0):
        return 1
    return 2


def run_walk_forward_backtest(
    db: Session,
    persist: bool = True,
    grid_size: int = GRID_SIZE,
) -> dict[str, Any]:
    """Evaluate each fixture using only matches dated before it.

    This prevents future results from leaking into the prediction for the
    current fixture.  Historical odds are not part of the current schema, so
    ROI and drawdown remain ``None`` until closing prices are imported.
    """

    if grid_size != GRID_SIZE:
        raise ValueError("The QVM walk-forward evaluator currently uses a 6x6 grid.")

    fixtures = list(
        db.scalars(
            select(Fixture).where(
                Fixture.status == "COMPLETED",
                Fixture.home_goals.is_not(None),
                Fixture.away_goals.is_not(None),
            ).order_by(Fixture.match_date, Fixture.id)
        ).all()
    )
    totals = {"home": 0, "away": 0, "fixtures": 0}
    aggregate: dict[int, dict[str, float]] = defaultdict(
        lambda: {
            "home_games": 0,
            "away_games": 0,
            "goals_scored_home": 0,
            "goals_conceded_home": 0,
            "goals_scored_away": 0,
            "goals_conceded_away": 0,
        }
    )
    brier_total = 0.0
    log_loss_total = 0.0
    correct = 0
    tail_total = 0.0
    evaluated = 0

    for fixture in fixtures:
        fixtures_before = totals["fixtures"]
        league_home = (
            totals["home"] / fixtures_before
            if fixtures_before
            else DEFAULT_HOME_GOALS
        )
        league_away = (
            totals["away"] / fixtures_before
            if fixtures_before
            else DEFAULT_AWAY_GOALS
        )
        home = aggregate[fixture.home_team_id]
        away = aggregate[fixture.away_team_id]
        lambda_home = (
            _strength(home["goals_scored_home"], int(home["home_games"]), league_home)
            * _strength(away["goals_conceded_away"], int(away["away_games"]), league_home)
            * league_home
        )
        lambda_away = (
            _strength(away["goals_scored_away"], int(away["away_games"]), league_home)
            * _strength(home["goals_conceded_home"], int(home["home_games"]), league_away)
            * league_away
        )
        probabilities = _probabilities(lambda_home, lambda_away)
        predicted = probabilities[:3]
        actual = _actual_outcome(fixture)
        indicators = [1.0 if index == actual else 0.0 for index in range(3)]
        brier_total += sum(
            (probability - indicator) ** 2
            for probability, indicator in zip(predicted, indicators)
        )
        log_loss_total += -log(max(predicted[actual], 1e-12))
        correct += int(max(range(3), key=lambda index: predicted[index]) == actual)
        tail_total += probabilities[3]
        evaluated += 1

        home_goals = fixture.home_goals or 0
        away_goals = fixture.away_goals or 0
        totals["home"] += home_goals
        totals["away"] += away_goals
        totals["fixtures"] += 1
        home["home_games"] += 1
        home["goals_scored_home"] += home_goals
        home["goals_conceded_home"] += away_goals
        away["away_games"] += 1
        away["goals_scored_away"] += away_goals
        away["goals_conceded_away"] += home_goals

    result = BacktestResult(
        model_version="poisson-v2-walk-forward",
        evaluation_type="WALK_FORWARD",
        fixtures_available=len(fixtures),
        fixtures_evaluated=evaluated,
        brier_score=round(brier_total / evaluated, 6) if evaluated else None,
        log_loss=round(log_loss_total / evaluated, 6) if evaluated else None,
        hit_rate=round(correct / evaluated, 6) if evaluated else None,
        average_tail_mass=round(tail_total / evaluated, 6) if evaluated else None,
        roi_pct=None,
        max_drawdown_pct=None,
        note=(
            "Leakage-safe evaluation. ROI and drawdown require historical market "
            "prices; the 6x6 score grid reports omitted tail probability."
        ),
        created_at=datetime.utcnow().isoformat(),
    )
    if persist:
        db.add(
            ModelRun(
                model_version=result.model_version,
                evaluation_type=result.evaluation_type,
                fixtures_evaluated=result.fixtures_evaluated,
                brier_score=result.brier_score,
                log_loss=result.log_loss,
                hit_rate=result.hit_rate,
                average_tail_mass=result.average_tail_mass,
                roi_pct=result.roi_pct,
                max_drawdown_pct=result.max_drawdown_pct,
            )
        )
        db.commit()
    return result.as_dict()
