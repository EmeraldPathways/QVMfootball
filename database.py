from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from config import settings


class Base(DeclarativeBase):
    pass


connect_args = (
    {"check_same_thread": False}
    if settings.database_url.startswith("sqlite")
    else {}
)

engine = create_engine(
    settings.database_url,
    connect_args=connect_args,
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def ensure_schema() -> None:
    """Create new tables and apply tiny backwards-compatible SQLite upgrades."""

    Base.metadata.create_all(bind=engine)
    if not settings.database_url.startswith("sqlite"):
        return
    with engine.begin() as connection:
        upgrades = {
            "simulated_bets": {
                "closing_odds": "REAL",
                "clv_pct": "REAL",
                "commission_amount": "REAL DEFAULT 0",
                "slippage_pct": "REAL DEFAULT 0",
                "data_quality_score": "REAL DEFAULT 0",
                "approval_status": "VARCHAR(24) DEFAULT 'AUTO_GATED'",
            },
            "predictions": {
                "calibrated_home_prob": "REAL",
                "calibrated_draw_prob": "REAL",
                "calibrated_away_prob": "REAL",
                "model_version": "VARCHAR(80) DEFAULT 'poisson-v2'",
                "grid_size": "INTEGER DEFAULT 6",
                "tail_mass": "REAL DEFAULT 0",
                "data_quality_score": "REAL DEFAULT 0",
            },
            "market_quotes": {
                "market_type": "VARCHAR(40) DEFAULT '1X2'",
                "bookmaker_count": "INTEGER DEFAULT 1",
                "consensus_home_prob": "REAL",
                "consensus_draw_prob": "REAL",
                "consensus_away_prob": "REAL",
                "overround": "REAL",
            },
        }
        for table, table_upgrades in upgrades.items():
            columns = {
                row[1]
                for row in connection.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            }
            for column, definition in table_upgrades.items():
                if column not in columns:
                    connection.exec_driver_sql(
                        f"ALTER TABLE {table} ADD COLUMN {column} {definition}"
                    )
