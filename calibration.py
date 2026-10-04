"""Small dependency-light calibration and data-quality toolkit."""

from __future__ import annotations

from collections import defaultdict
from datetime import datetime
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from models import CalibrationBucket, Fixture, MarketQuote, Prediction


def isotonic_fit(values: Iterable[float], outcomes: Iterable[float]) -> list[tuple[float, float]]:
    """Fit a monotone reliability curve with the pool-adjacent-violators algorithm."""
    pairs = sorted((float(x), float(y)) for x, y in zip(values, outcomes))
    blocks: list[list[float]] = []
    for x, y in pairs:
        blocks.append([x, y, 1.0])
        while len(blocks) > 1 and blocks[-2][1] > blocks[-1][1]:
            left, right = blocks[-2], blocks[-1]
            weight = left[2] + right[2]
            blocks[-2] = [
                (left[0] * left[2] + right[0] * right[2]) / weight,
                (left[1] * left[2] + right[1] * right[2]) / weight,
                weight,
            ]
            blocks.pop()
    return [(block[0], block[1]) for block in blocks]


def isotonic_predict(curve: list[tuple[float, float]], value: float) -> float:
    if not curve:
        return min(max(value, 0.0), 1.0)
    result = curve[0][1]
    for threshold, fitted in curve:
        if value >= threshold:
            result = fitted
        else:
            break
    return min(max(result, 0.0), 1.0)


def fit_prediction_calibration(db: Session, model_version: str = "poisson-v2") -> dict:
    rows = list(
        db.execute(
            select(Prediction, Fixture)
            .join(Fixture, Prediction.fixture_id == Fixture.id)
            .where(Fixture.status == "COMPLETED", Fixture.home_goals.is_not(None))
        ).all()
    )
    if len(rows) < 30:
        return {"status": "INSUFFICIENT_DATA", "fixtures": len(rows), "minimum": 30}
    probabilities = [
        [row[0].true_home_prob, row[0].true_draw_prob, row[0].true_away_prob]
        for row in rows
    ]
    actuals = [
        0 if row[1].home_goals > row[1].away_goals else 1 if row[1].home_goals == row[1].away_goals else 2
        for row in rows
    ]
    calibrated = []
    for index, name in enumerate(("HOME", "DRAW", "AWAY")):
        curve = isotonic_fit((item[index] for item in probabilities), (a == index for a in actuals))
        for bucket in range(10):
            in_bucket = [position for position, item in enumerate(probabilities) if bucket / 10 <= item[index] < (bucket + 1) / 10]
            if in_bucket:
                db.add(CalibrationBucket(
                    model_version=model_version,
                    outcome_class=name,
                    bucket=bucket,
                    prediction_count=len(in_bucket),
                    predicted_probability=sum(probabilities[p][index] for p in in_bucket) / len(in_bucket),
                    observed_frequency=sum(actuals[p] == index for p in in_bucket) / len(in_bucket),
                    updated_at=datetime.utcnow(),
                ))
        calibrated.append(curve)
    db.commit()
    return {"status": "READY", "fixtures": len(rows), "model_version": model_version, "curves": calibrated}


def calculate_data_quality(db: Session, fixture: Fixture, prediction: Prediction | None = None) -> dict:
    """Return an explainable 0-100 tradeability score."""
    completed = db.query(Fixture).filter(
        Fixture.status == "COMPLETED",
        Fixture.home_team_id.in_([fixture.home_team_id, fixture.away_team_id]),
    ).count()
    quote = db.scalar(
        select(MarketQuote).where(MarketQuote.fixture_id == fixture.id).order_by(MarketQuote.captured_at.desc())
    )
    score = 35.0 if completed >= 10 else 20.0 if completed >= 5 else 8.0
    reasons = []
    if quote:
        score += min(25.0, quote.bookmaker_count * 5.0)
        if quote.overround is not None and quote.overround < 0.15:
            score += 10.0
        age = (datetime.utcnow() - quote.captured_at).total_seconds()
        if age <= 900:
            score += 15.0
        else:
            reasons.append("STALE_QUOTE")
    else:
        reasons.append("NO_MARKET_QUOTE")
    if prediction and prediction.tail_mass <= 0.02:
        score += 10.0
    elif prediction:
        reasons.append("HIGH_SCORE_GRID_TAIL")
    return {"score": round(min(score, 100.0), 1), "reasons": reasons}
