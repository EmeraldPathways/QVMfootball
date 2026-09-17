from typing import Any

from scipy.stats import poisson
from sqlalchemy import select
from sqlalchemy.orm import Session

from data_pipeline import DataPipeline
from models import Fixture, TeamStats
from config import settings


def calculate_match_probabilities(
    db: Session,
    home_team_id: int,
    away_team_id: int,
    *,
    model: str = "poisson",
    grid_size: int = 10,
) -> dict[str, Any]:
    averages = DataPipeline(db).update_team_strengths()
    home_stats = db.scalar(
        select(TeamStats).where(TeamStats.team_id == home_team_id)
    )
    away_stats = db.scalar(
        select(TeamStats).where(TeamStats.team_id == away_team_id)
    )
    home_attack = home_stats.attack_strength_home if home_stats else 1.0
    home_defense = home_stats.defense_strength_home if home_stats else 1.0
    away_attack = away_stats.attack_strength_away if away_stats else 1.0
    away_defense = away_stats.defense_strength_away if away_stats else 1.0
    lambda_home = (
        home_attack * away_defense * averages["league_avg_goals_home"]
    )
    lambda_away = (
        away_attack * home_defense * averages["league_avg_goals_away"]
    )
    grid_size = max(6, min(int(grid_size), 15))
    matrix = [
        [
            float(poisson.pmf(home_goals, lambda_home))
            * float(poisson.pmf(away_goals, lambda_away))
            for away_goals in range(grid_size)
        ]
        for home_goals in range(grid_size)
    ]
    if model == "dixon-coles":
        # Low-score dependence correction; rho is deliberately conservative
        # and can later be estimated by the model registry.
        rho = -0.08
        for home_goals, away_goals, tau in (
            (0, 0, 1 - lambda_home * lambda_away * rho),
            (0, 1, 1 + lambda_home * rho),
            (1, 0, 1 + lambda_away * rho),
            (1, 1, 1 - rho),
        ):
            matrix[home_goals][away_goals] *= max(tau, 0.01)
    grid_mass = sum(sum(row) for row in matrix)
    true_home_prob = sum(
        matrix[home_goals][away_goals]
        for home_goals in range(grid_size)
        for away_goals in range(grid_size)
        if home_goals > away_goals
    )
    true_draw_prob = sum(
        matrix[home_goals][away_goals]
        for home_goals in range(grid_size)
        for away_goals in range(grid_size)
        if home_goals == away_goals
    )
    true_away_prob = sum(
        matrix[home_goals][away_goals]
        for home_goals in range(grid_size)
        for away_goals in range(grid_size)
        if away_goals > home_goals
    )

    def fair_odds(probability: float) -> float:
        return round(1.0 / max(probability, 0.000001), 6)

    return {
        "lambda_home": round(lambda_home, 6),
        "lambda_away": round(lambda_away, 6),
        "probability_matrix": matrix,
        "true_home_prob": round(true_home_prob / grid_mass, 6),
        "true_draw_prob": round(true_draw_prob / grid_mass, 6),
        "true_away_prob": round(true_away_prob / grid_mass, 6),
        "fair_home_odds": fair_odds(true_home_prob / grid_mass),
        "fair_draw_odds": fair_odds(true_draw_prob / grid_mass),
        "fair_away_odds": fair_odds(true_away_prob / grid_mass),
        "grid_mass": round(grid_mass, 6),
        "tail_mass": round(max(0.0, 1.0 - grid_mass), 6),
        "grid_size": grid_size,
        "model_version": f"{model}-v1",
    }


def rebuild_predictions(db: Session) -> int:
    from models import Prediction

    fixtures = list(db.scalars(select(Fixture)).all())
    count = 0
    for fixture in fixtures:
        values = calculate_match_probabilities(
            db,
            fixture.home_team_id,
            fixture.away_team_id,
            model=settings.model_type,
            grid_size=settings.model_grid_size,
        )
        prediction = db.scalar(
            select(Prediction).where(Prediction.fixture_id == fixture.id)
        )
        if not prediction:
            prediction = Prediction(fixture_id=fixture.id)
            db.add(prediction)
        prediction.true_home_prob = values["true_home_prob"]
        prediction.true_draw_prob = values["true_draw_prob"]
        prediction.true_away_prob = values["true_away_prob"]
        prediction.fair_home_odds = values["fair_home_odds"]
        prediction.fair_draw_odds = values["fair_draw_odds"]
        prediction.fair_away_odds = values["fair_away_odds"]
        prediction.model_version = values["model_version"]
        prediction.grid_size = values["grid_size"]
        prediction.tail_mass = values["tail_mass"]
        from calibration import calculate_data_quality

        prediction.data_quality_score = calculate_data_quality(db, fixture, prediction)["score"]
        count += 1
    db.commit()
    return count
