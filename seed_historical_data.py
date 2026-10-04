"""Import historical Premier League results into the local QVM database.

Football-Data.co.uk publishes one CSV per competition and season.  This
module downloads the requested E0 (Premier League) seasons, normalises team
names, inserts only new completed fixtures, and refreshes the strength table.

The importer is deliberately paper-trading only.  It writes to the database
configured by ``DATABASE_URL`` and never places a live wager.
"""

from __future__ import annotations

import argparse
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pandas as pd
from sqlalchemy import select
from sqlalchemy.orm import Session

from config import settings
from data_pipeline import DataPipeline
from database import Base, SessionLocal, engine
from models import Fixture, Team


LOGGER = logging.getLogger("qvm.seed_historical_data")
if not LOGGER.handlers:
    log_path = Path("system.log")
    file_handler = logging.FileHandler(log_path)
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    LOGGER.addHandler(file_handler)
    LOGGER.setLevel(logging.INFO)


DEFAULT_SEASONS = (
    "2526",
    "2425",
    "2324",
    "2223",
    "2122",
    "2021",
    "1920",
    "1819",
    "1718",
    "1617",
)
REQUIRED_COLUMNS = frozenset({"HomeTeam", "AwayTeam", "Date", "FTHG", "FTAG"})
CSV_COLUMNS = ("HomeTeam", "AwayTeam", "Date", "FTHG", "FTAG")

# Football-Data.co.uk uses short historical labels.  Reusing the seeded
# application's canonical names prevents duplicate clubs across data sources.
TEAM_ALIASES = {
    "Birmingham": "Birmingham City",
    "Blackburn": "Blackburn Rovers",
    "Blackpool": "Blackpool",
    "Bournemouth": "AFC Bournemouth",
    "Brighton": "Brighton",
    "Cardiff": "Cardiff City",
    "Coventry": "Coventry City",
    "Crystal Palace": "Crystal Palace",
    "Huddersfield": "Huddersfield Town",
    "Hull": "Hull City",
    "Leicester": "Leicester City",
    "Man City": "Manchester City",
    "Man United": "Manchester United",
    "Man Utd": "Manchester United",
    "Middlesbrough": "Middlesbrough",
    "Newcastle": "Newcastle United",
    "Nott'm Forest": "Nottingham Forest",
    "Norwich": "Norwich City",
    "QPR": "Queens Park Rangers",
    "Reading": "Reading",
    "Sheffield Utd": "Sheffield United",
    "Sheffield United": "Sheffield United",
    "Sheffield Weds": "Sheffield Wednesday",
    "Southampton": "Southampton",
    "Stoke": "Stoke City",
    "Swansea": "Swansea City",
    "Tottenham": "Tottenham Hotspur",
    "West Brom": "West Bromwich Albion",
    "West Ham": "West Ham United",
    "Wigan": "Wigan Athletic",
    "Wolves": "Wolverhampton Wanderers",
}


@dataclass
class SeedSummary:
    """Counters emitted by one historical import run."""

    seasons_requested: int = 0
    seasons_loaded: int = 0
    rows_seen: int = 0
    rows_skipped: int = 0
    teams_processed: int = 0
    teams_created: int = 0
    fixtures_processed: int = 0
    fixtures_inserted: int = 0
    fixtures_existing: int = 0
    strength_summary: dict[str, float | int] = field(default_factory=dict)


class HistoricalDataSeeder:
    """Download Football-Data.co.uk result files and seed SQLAlchemy models."""

    def __init__(
        self,
        db: Session,
        base_url: str = settings.football_data_base_url,
        timeout_seconds: float = settings.request_timeout_seconds,
    ) -> None:
        self.db = db
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def run(self, seasons: Iterable[str]) -> SeedSummary:
        season_codes = tuple(self._validate_season_code(season) for season in seasons)
        summary = SeedSummary(seasons_requested=len(season_codes))
        team_cache = self._load_team_cache()
        fixture_keys = self._load_fixture_keys()
        processed_team_keys: set[str] = set()

        # This health check intentionally visits the source root supplied by
        # the user.  Individual CSV requests still run so a root-page outage
        # does not prevent a valid season file from being imported.
        self.check_source()

        try:
            for season in season_codes:
                frame = self.fetch_season(season)
                if frame is None:
                    continue
                summary.seasons_loaded += 1
                self._import_frame(
                    frame=frame,
                    season=season,
                    team_cache=team_cache,
                    fixture_keys=fixture_keys,
                    processed_team_keys=processed_team_keys,
                    summary=summary,
                )

            # Make historical rows visible to the pipeline before it computes
            # league averages and the four normalised strength parameters.
            self.db.commit()
            summary.strength_summary = DataPipeline(self.db).update_team_strengths()
            summary.teams_processed = len(processed_team_keys)
            LOGGER.info(
                "Historical seed complete: %s teams, %s fixtures processed "
                "(%s inserted, %s already present, %s skipped rows).",
                summary.teams_processed,
                summary.fixtures_processed,
                summary.fixtures_inserted,
                summary.fixtures_existing,
                summary.rows_skipped,
            )
            return summary
        except Exception:
            self.db.rollback()
            LOGGER.exception("Historical Football-Data.co.uk seed failed.")
            raise

    def check_source(self) -> bool:
        """Check the Football-Data.co.uk root endpoint with a bounded timeout."""

        try:
            request = Request(
                self.base_url,
                headers={"User-Agent": "QVM-Football-Workbench/1.0"},
            )
            with urlopen(request, timeout=self.timeout_seconds) as response:
                response.read(256)
            LOGGER.info("Football-Data.co.uk source check succeeded.")
            return True
        except HTTPError as error:
            LOGGER.exception(
                "Football-Data.co.uk source check returned HTTP %s.", error.code
            )
        except (TimeoutError, URLError, OSError):
            LOGGER.exception("Football-Data.co.uk source check failed.")
        return False

    def fetch_season(self, season: str) -> pd.DataFrame | None:
        """Read one E0 CSV with pandas while enforcing a ten-second timeout."""

        csv_url = f"{self.base_url}/mmz4281/{season}/E0.csv"
        try:
            request = Request(
                csv_url,
                headers={"User-Agent": "QVM-Football-Workbench/1.0"},
            )
            # pandas performs the CSV parsing directly from the HTTP response;
            # urllib supplies the explicit connection/read timeout.
            with urlopen(request, timeout=self.timeout_seconds) as response:
                frame = pd.read_csv(response, encoding="latin-1")
            frame.columns = [
                str(column).strip().lstrip("\ufeff") for column in frame.columns
            ]
            missing = REQUIRED_COLUMNS.difference(frame.columns)
            if missing:
                LOGGER.error(
                    "Skipping season %s; CSV is missing columns: %s.",
                    season,
                    ", ".join(sorted(missing)),
                )
                return None
            LOGGER.info("Downloaded %s historical rows for season %s.", len(frame), season)
            return frame
        except HTTPError as error:
            LOGGER.exception(
                "HTTP error downloading season %s from Football-Data.co.uk: %s.",
                season,
                error.code,
            )
        except (TimeoutError, URLError, OSError):
            LOGGER.exception(
                "Network timeout or connection error downloading season %s.", season
            )
        except (
            pd.errors.EmptyDataError,
            pd.errors.ParserError,
            UnicodeError,
            ValueError,
        ):
            LOGGER.exception("CSV parsing failed for Football-Data.co.uk season %s.", season)
        return None

    def _import_frame(
        self,
        frame: pd.DataFrame,
        season: str,
        team_cache: dict[str, Team],
        fixture_keys: set[tuple[int, int, datetime]],
        processed_team_keys: set[str],
        summary: SeedSummary,
    ) -> None:
        fixtures_processed_before = summary.fixtures_processed
        rows_skipped_before = summary.rows_skipped
        summary.rows_seen += len(frame)
        frame = frame.loc[:, list(CSV_COLUMNS)]

        for home_raw, away_raw, date_raw, home_goals_raw, away_goals_raw in frame.itertuples(
            index=False, name=None
        ):
            match_date = self._parse_match_date(date_raw)
            home_goals = self._parse_goal(home_goals_raw)
            away_goals = self._parse_goal(away_goals_raw)
            home_name = self._team_name(home_raw)
            away_name = self._team_name(away_raw)
            if (
                match_date is None
                or home_goals is None
                or away_goals is None
                or home_name is None
                or away_name is None
            ):
                summary.rows_skipped += 1
                continue

            home = self._get_or_create_team(home_name, team_cache, summary)
            away = self._get_or_create_team(away_name, team_cache, summary)
            processed_team_keys.add(self._team_key(home.name))
            processed_team_keys.add(self._team_key(away.name))

            fixture_key = (home.id, away.id, match_date)
            summary.fixtures_processed += 1
            if fixture_key in fixture_keys:
                summary.fixtures_existing += 1
                continue

            self.db.add(
                Fixture(
                    home_team_id=home.id,
                    away_team_id=away.id,
                    match_date=match_date,
                    home_goals=home_goals,
                    away_goals=away_goals,
                    status="COMPLETED",
                )
            )
            fixture_keys.add(fixture_key)
            summary.fixtures_inserted += 1

        LOGGER.info(
            "Processed season %s: %s valid fixtures, %s invalid rows skipped.",
            season,
            summary.fixtures_processed - fixtures_processed_before,
            summary.rows_skipped - rows_skipped_before,
        )

    def _load_team_cache(self) -> dict[str, Team]:
        cache: dict[str, Team] = {}
        for team in self.db.scalars(select(Team)).all():
            key = self._team_key(TEAM_ALIASES.get(team.name, team.name))
            cache.setdefault(key, team)
        return cache

    def _load_fixture_keys(self) -> set[tuple[int, int, datetime]]:
        keys: set[tuple[int, int, datetime]] = set()
        for fixture in self.db.scalars(select(Fixture)).all():
            if fixture.match_date is None:
                continue
            keys.add(
                (
                    fixture.home_team_id,
                    fixture.away_team_id,
                    self._normalise_datetime(fixture.match_date),
                )
            )
        return keys

    def _get_or_create_team(
        self,
        name: str,
        team_cache: dict[str, Team],
        summary: SeedSummary,
    ) -> Team:
        canonical_name = TEAM_ALIASES.get(name, name)
        key = self._team_key(canonical_name)
        existing = team_cache.get(key)
        if existing is not None:
            return existing

        team = Team(name=canonical_name, league="Premier League")
        self.db.add(team)
        self.db.flush()
        team_cache[key] = team
        summary.teams_created += 1
        LOGGER.info("Created historical team: %s.", canonical_name)
        return team

    @staticmethod
    def _team_name(value: object) -> str | None:
        if pd.isna(value):
            return None
        name = str(value).strip()
        return name if name and name.casefold() != "nan" else None

    @staticmethod
    def _team_key(value: str) -> str:
        return "".join(character for character in value.casefold() if character.isalnum())

    @staticmethod
    def _normalise_datetime(value: datetime) -> datetime:
        return value.replace(hour=0, minute=0, second=0, microsecond=0, tzinfo=None)

    @classmethod
    def _parse_match_date(cls, value: object) -> datetime | None:
        if pd.isna(value):
            return None
        raw = str(value).strip()
        if not raw or raw.casefold() == "nan":
            return None
        for date_format in ("%d/%m/%Y", "%d/%m/%y"):
            try:
                return cls._normalise_datetime(datetime.strptime(raw, date_format))
            except ValueError:
                continue
        parsed = pd.to_datetime(raw, dayfirst=True, errors="coerce")
        if pd.isna(parsed):
            return None
        return cls._normalise_datetime(parsed.to_pydatetime())

    @staticmethod
    def _parse_goal(value: object) -> int | None:
        if pd.isna(value):
            return None
        try:
            numeric = float(pd.to_numeric(value, errors="coerce"))
        except (TypeError, ValueError):
            return None
        if pd.isna(numeric) or not numeric.is_integer() or numeric < 0:
            return None
        return int(numeric)

    @staticmethod
    def _validate_season_code(value: object) -> str:
        season = str(value).strip()
        if not re.fullmatch(r"\d{4}", season):
            raise ValueError(f"Invalid season code {value!r}; use a four-digit code such as 2425.")
        return season


def configured_seasons() -> tuple[str, ...]:
    """Read comma-separated season codes from .env, with a deep default history."""

    raw = settings.historical_seasons.strip()
    seasons = tuple(item.strip() for item in raw.split(",") if item.strip())
    return seasons or DEFAULT_SEASONS


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Seed completed EPL fixtures from Football-Data.co.uk."
    )
    parser.add_argument(
        "--seasons",
        nargs="+",
        default=configured_seasons(),
        help="Season codes such as 2425 2324 (default: configured deep history).",
    )
    parser.add_argument(
        "--base-url",
        default=settings.football_data_base_url,
        help="Football-Data.co.uk base URL.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=settings.request_timeout_seconds,
        help="Network timeout in seconds (default: 10).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    Base.metadata.create_all(bind=engine)
    db = SessionLocal()
    try:
        summary = HistoricalDataSeeder(
            db=db,
            base_url=args.base_url,
            timeout_seconds=args.timeout,
        ).run(args.seasons)
    except Exception:
        print("Historical data seed failed; see system.log for the traceback.")
        return 1
    finally:
        db.close()

    print("Historical data seed complete.")
    print(f"Teams processed: {summary.teams_processed} (created: {summary.teams_created})")
    print(
        "Historical fixtures processed: "
        f"{summary.fixtures_processed} "
        f"(inserted: {summary.fixtures_inserted}, already present: {summary.fixtures_existing}, "
        f"invalid rows skipped: {summary.rows_skipped})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
