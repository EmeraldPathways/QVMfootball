from datetime import datetime

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    league: Mapped[str] = mapped_column(String(80), default="Premier League")

    home_fixtures: Mapped[list["Fixture"]] = relationship(
        back_populates="home_team",
        foreign_keys="Fixture.home_team_id",
    )
    away_fixtures: Mapped[list["Fixture"]] = relationship(
        back_populates="away_team",
        foreign_keys="Fixture.away_team_id",
    )
    stats: Mapped["TeamStats | None"] = relationship(
        back_populates="team",
        uselist=False,
        cascade="all, delete-orphan",
    )


class Fixture(Base):
    __tablename__ = "fixtures"
    __table_args__ = (
        Index("ix_fixtures_match_date", "match_date"),
        Index("ix_fixtures_status", "status"),
        Index("ix_fixtures_teams", "home_team_id", "away_team_id"),
        UniqueConstraint(
            "home_team_id",
            "away_team_id",
            "match_date",
            name="uq_fixtures_identity",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    home_team_id: Mapped[int] = mapped_column(
        ForeignKey("teams.id", ondelete="CASCADE"), index=True
    )
    away_team_id: Mapped[int] = mapped_column(
        ForeignKey("teams.id", ondelete="CASCADE"), index=True
    )
    match_date: Mapped[datetime] = mapped_column(DateTime)
    home_goals: Mapped[int | None] = mapped_column(Integer, nullable=True)
    away_goals: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="SCHEDULED")

    home_team: Mapped[Team] = relationship(
        back_populates="home_fixtures",
        foreign_keys=[home_team_id],
    )
    away_team: Mapped[Team] = relationship(
        back_populates="away_fixtures",
        foreign_keys=[away_team_id],
    )
    prediction: Mapped["Prediction | None"] = relationship(
        back_populates="fixture",
        uselist=False,
        cascade="all, delete-orphan",
    )
    bets: Mapped[list["SimulatedBet"]] = relationship(
        back_populates="fixture",
        cascade="all, delete-orphan",
    )
    quotes: Mapped[list["MarketQuote"]] = relationship(
        back_populates="fixture",
        cascade="all, delete-orphan",
    )


class TeamStats(Base):
    __tablename__ = "team_stats"
    __table_args__ = (UniqueConstraint("team_id", name="uq_team_stats_team_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    team_id: Mapped[int] = mapped_column(
        ForeignKey("teams.id", ondelete="CASCADE"), index=True
    )
    matches_played: Mapped[int] = mapped_column(Integer, default=0)
    goals_scored_home: Mapped[int] = mapped_column(Integer, default=0)
    goals_conceded_home: Mapped[int] = mapped_column(Integer, default=0)
    goals_scored_away: Mapped[int] = mapped_column(Integer, default=0)
    goals_conceded_away: Mapped[int] = mapped_column(Integer, default=0)
    attack_strength_home: Mapped[float] = mapped_column(Float, default=1.0)
    defense_strength_home: Mapped[float] = mapped_column(Float, default=1.0)
    attack_strength_away: Mapped[float] = mapped_column(Float, default=1.0)
    defense_strength_away: Mapped[float] = mapped_column(Float, default=1.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    team: Mapped[Team] = relationship(back_populates="stats")


class Prediction(Base):
    __tablename__ = "predictions"
    __table_args__ = (UniqueConstraint("fixture_id", name="uq_predictions_fixture_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), index=True
    )
    true_home_prob: Mapped[float] = mapped_column(Float)
    true_draw_prob: Mapped[float] = mapped_column(Float)
    true_away_prob: Mapped[float] = mapped_column(Float)
    fair_home_odds: Mapped[float] = mapped_column(Float)
    fair_draw_odds: Mapped[float] = mapped_column(Float)
    fair_away_odds: Mapped[float] = mapped_column(Float)
    calculated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    calibrated_home_prob: Mapped[float | None] = mapped_column(Float, nullable=True)
    calibrated_draw_prob: Mapped[float | None] = mapped_column(Float, nullable=True)
    calibrated_away_prob: Mapped[float | None] = mapped_column(Float, nullable=True)
    model_version: Mapped[str] = mapped_column(String(80), default="poisson-v2")
    grid_size: Mapped[int] = mapped_column(Integer, default=6)
    tail_mass: Mapped[float] = mapped_column(Float, default=0.0)
    data_quality_score: Mapped[float] = mapped_column(Float, default=0.0)

    fixture: Mapped[Fixture] = relationship(back_populates="prediction")


class MarketQuote(Base):
    __tablename__ = "market_quotes"
    __table_args__ = (
        Index("ix_market_quotes_fixture_captured", "fixture_id", "captured_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), index=True
    )
    provider: Mapped[str] = mapped_column(String(120), default="The Odds API")
    home_odds: Mapped[float] = mapped_column(Float)
    draw_odds: Mapped[float] = mapped_column(Float)
    away_odds: Mapped[float] = mapped_column(Float)
    captured_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    market_type: Mapped[str] = mapped_column(String(40), default="1X2")
    bookmaker_count: Mapped[int] = mapped_column(Integer, default=1)
    consensus_home_prob: Mapped[float | None] = mapped_column(Float, nullable=True)
    consensus_draw_prob: Mapped[float | None] = mapped_column(Float, nullable=True)
    consensus_away_prob: Mapped[float | None] = mapped_column(Float, nullable=True)
    overround: Mapped[float | None] = mapped_column(Float, nullable=True)

    fixture: Mapped[Fixture] = relationship(back_populates="quotes")


class SimulatedBet(Base):
    __tablename__ = "simulated_bets"
    __table_args__ = (
        Index("ix_simulated_bets_fixture_status", "fixture_id", "status"),
        Index("ix_simulated_bets_placed_at", "placed_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fixture_id: Mapped[int] = mapped_column(
        ForeignKey("fixtures.id", ondelete="CASCADE"), index=True
    )
    selection: Mapped[str] = mapped_column(String(8))
    market_odds: Mapped[float] = mapped_column(Float)
    implied_prob: Mapped[float] = mapped_column(Float)
    true_prob: Mapped[float] = mapped_column(Float)
    edge_pct: Mapped[float] = mapped_column(Float)
    stake_amount: Mapped[float] = mapped_column(Float)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    outcome: Mapped[str | None] = mapped_column(String(8), nullable=True)
    profit_loss: Mapped[float] = mapped_column(Float, default=0.0)
    closing_odds: Mapped[float | None] = mapped_column(Float, nullable=True)
    clv_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    placed_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    commission_amount: Mapped[float] = mapped_column(Float, default=0.0)
    slippage_pct: Mapped[float] = mapped_column(Float, default=0.0)
    data_quality_score: Mapped[float] = mapped_column(Float, default=0.0)
    approval_status: Mapped[str] = mapped_column(String(24), default="AUTO_GATED")

    fixture: Mapped[Fixture] = relationship(back_populates="bets")


class UserPortfolio(Base):
    __tablename__ = "user_portfolios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    current_bankroll: Mapped[float] = mapped_column(Float, default=1000.00)
    initial_bankroll: Mapped[float] = mapped_column(Float, default=1000.00)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ModelRun(Base):
    """Durable evaluation record for a walk-forward model run."""

    __tablename__ = "model_runs"
    __table_args__ = (Index("ix_model_runs_created_at", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model_version: Mapped[str] = mapped_column(String(80), default="poisson-v1")
    evaluation_type: Mapped[str] = mapped_column(String(40), default="WALK_FORWARD")
    fixtures_evaluated: Mapped[int] = mapped_column(Integer, default=0)
    brier_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    log_loss: Mapped[float | None] = mapped_column(Float, nullable=True)
    hit_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    average_tail_mass: Mapped[float | None] = mapped_column(Float, nullable=True)
    roi_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    max_drawdown_pct: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AgentRun(Base):
    """Audit record for the bounded Manager and Worker agents."""

    __tablename__ = "agent_runs"
    __table_args__ = (
        Index("ix_agent_runs_role_status", "role", "status"),
        Index("ix_agent_runs_started_at", "started_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_name: Mapped[str] = mapped_column(String(80))
    role: Mapped[str] = mapped_column(String(20))
    model: Mapped[str] = mapped_column(String(120), default="Luna Max")
    status: Mapped[str] = mapped_column(String(20), default="RUNNING")
    task: Mapped[str] = mapped_column(String(160))
    summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    payload: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ModelVersion(Base):
    """Registry for reproducible champion/challenger model evaluation."""

    __tablename__ = "model_versions"
    __table_args__ = (Index("ix_model_versions_active", "is_active"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80), unique=True)
    feature_set: Mapped[str] = mapped_column(Text, default="goals_home_away")
    training_start: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    training_end: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    parameters_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    git_commit: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="CHALLENGER")
    is_active: Mapped[bool] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class CalibrationBucket(Base):
    """Persisted reliability data for calibration monitoring."""

    __tablename__ = "calibration_buckets"
    __table_args__ = (Index("ix_calibration_buckets_model_bucket", "model_version", "bucket"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    model_version: Mapped[str] = mapped_column(String(80))
    outcome_class: Mapped[str] = mapped_column(String(12))
    bucket: Mapped[int] = mapped_column(Integer)
    prediction_count: Mapped[int] = mapped_column(Integer, default=0)
    predicted_probability: Mapped[float] = mapped_column(Float, default=0.0)
    observed_frequency: Mapped[float] = mapped_column(Float, default=0.0)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class WorkerHeartbeat(Base):
    """Operational heartbeat used by the local worker and dashboard."""

    __tablename__ = "worker_heartbeats"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    worker_name: Mapped[str] = mapped_column(String(80), unique=True)
    status: Mapped[str] = mapped_column(String(20), default="STARTING")
    last_started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    cycles_completed: Mapped[int] = mapped_column(Integer, default=0)


class Player(Base):
    __tablename__ = "players"
    __table_args__ = (Index("ix_players_team", "team_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(160))
    position: Mapped[str | None] = mapped_column(String(24), nullable=True)
    expected_minutes: Mapped[float] = mapped_column(Float, default=0.0)
    attack_rating: Mapped[float] = mapped_column(Float, default=0.0)
    defence_rating: Mapped[float] = mapped_column(Float, default=0.0)
    availability: Mapped[str] = mapped_column(String(20), default="UNKNOWN")
    source: Mapped[str] = mapped_column(String(120), default="manual")
    source_updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class FixtureEvent(Base):
    __tablename__ = "fixture_events"
    __table_args__ = (Index("ix_fixture_events_fixture_minute", "fixture_id", "minute"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fixture_id: Mapped[int] = mapped_column(ForeignKey("fixtures.id", ondelete="CASCADE"), index=True)
    minute: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(32))
    team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id", ondelete="SET NULL"), nullable=True)
    player_id: Mapped[int | None] = mapped_column(ForeignKey("players.id", ondelete="SET NULL"), nullable=True)
    xg: Mapped[float | None] = mapped_column(Float, nullable=True)
    payload: Mapped[str | None] = mapped_column(Text, nullable=True)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DataSnapshot(Base):
    """Immutable provenance record for every imported external response."""

    __tablename__ = "data_snapshots"
    __table_args__ = (Index("ix_data_snapshots_source_captured", "source", "captured_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    source: Mapped[str] = mapped_column(String(120))
    endpoint: Mapped[str] = mapped_column(String(240))
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    payload: Mapped[str] = mapped_column(Text)
    captured_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DecisionReplay(Base):
    __tablename__ = "decision_replays"
    __table_args__ = (Index("ix_decision_replays_created", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    fixture_id: Mapped[int | None] = mapped_column(ForeignKey("fixtures.id", ondelete="SET NULL"), nullable=True)
    decision: Mapped[str] = mapped_column(String(32))
    model_version: Mapped[str] = mapped_column(String(80))
    data_snapshot_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    deterministic_checks: Mapped[str] = mapped_column(Text)
    agent_reports: Mapped[str | None] = mapped_column(Text, nullable=True)
    approval_status: Mapped[str] = mapped_column(String(24), default="NOT_REQUIRED")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ExperimentRun(Base):
    __tablename__ = "experiment_runs"
    __table_args__ = (Index("ix_experiment_runs_created", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    experiment_name: Mapped[str] = mapped_column(String(120))
    champion_version: Mapped[str] = mapped_column(String(80))
    challenger_version: Mapped[str] = mapped_column(String(80))
    metrics_json: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="COMPLETED")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class PortfolioScenario(Base):
    __tablename__ = "portfolio_scenarios"
    __table_args__ = (Index("ix_portfolio_scenarios_created", "created_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    scenario_name: Mapped[str] = mapped_column(String(120))
    assumptions_json: Mapped[str] = mapped_column(Text)
    result_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
