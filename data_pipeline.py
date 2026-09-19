import logging
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from config import settings
from models import Fixture, MarketQuote, Team, TeamStats

logger = logging.getLogger("qvm.data_pipeline")
if not logger.handlers:
    file_handler = logging.FileHandler("system.log")
    file_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    logger.addHandler(file_handler)
    logger.setLevel(logging.INFO)


TEAM_NAME_ALIASES = {
    "mancity": "manchestercity",
    "manchesterutd": "manchesterunited",
    "manchesterunited": "manchesterunited",
    "spurs": "tottenhamhotspur",
    "tottenham": "tottenhamhotspur",
    "brightonandhovealbion": "brighton",
    "brightonhovealbion": "brighton",
    "westham": "westhamunited",
    "newcastle": "newcastleunited",
}


class DataPipeline:
    def __init__(self, db: Session, config=settings):
        self.db = db
        self.config = config

    def fetch_odds(self) -> list[dict[str, Any]]:
        if not self.config.odds_api_key:
            logger.info("ODDS_API_KEY is not configured; using demo market data.")
            return []
        params = {
            "apiKey": self.config.odds_api_key,
            "regions": self.config.odds_api_regions,
            "markets": self.config.odds_api_markets,
            "oddsFormat": "decimal",
        }
        try:
            with httpx.Client(timeout=10.0) as client:
                response = client.get(self.config.odds_api_url, params=params)
                response.raise_for_status()
                parsed = self.parse_odds(response.json())
                logger.info("The Odds API returned %s parsed upcoming markets.", len(parsed))
                return parsed
        except (httpx.HTTPError, ValueError):
            logger.exception("The Odds API request or response parsing failed.")
            raise

    @staticmethod
    def parse_odds(payload: Any) -> list[dict[str, Any]]:
        parsed: list[dict[str, Any]] = []
        if not isinstance(payload, list):
            return parsed
        for event in payload:
            if not isinstance(event, dict):
                continue
            home = event.get("home_team")
            away = event.get("away_team")
            if not home or not away:
                continue
            for bookmaker in event.get("bookmakers", []):
                markets = bookmaker.get("markets", [])
                market = next(
                    (item for item in markets if item.get("key") == "h2h"),
                    None,
                )
                if not market:
                    continue
                outcomes = {
                    outcome.get("name"): outcome.get("price")
                    for outcome in market.get("outcomes", [])
                }
                if not all(
                    isinstance(outcomes.get(name), (int, float))
                    for name in (home, away, "Draw")
                ):
                    continue
                parsed.append(
                    {
                        "home_team": home,
                        "away_team": away,
                        "commence_time": event.get("commence_time"),
                        "provider": bookmaker.get("title", "The Odds API"),
                        "home_odds": float(outcomes[home]),
                        "draw_odds": float(outcomes["Draw"]),
                        "away_odds": float(outcomes[away]),
                    }
                )
                break
        return parsed

    def ingest_odds(self, markets: list[dict[str, Any]]) -> int:
        teams_by_name: dict[str, Team] = {}
        for team in self.db.scalars(select(Team)).all():
            key = self._normalise(team.name)
            existing = teams_by_name.get(key)
            if existing is None or (
                self._compact(team.name) == key
                and self._compact(existing.name) != key
            ):
                teams_by_name[key] = team
        fixtures = self.db.scalars(select(Fixture)).all()
        updated = 0
        for market in markets:
            home_name = market["home_team"].strip()
            away_name = market["away_team"].strip()
            home = teams_by_name.get(self._normalise(home_name))
            away = teams_by_name.get(self._normalise(away_name))

            # Live feeds are the source of truth for upcoming fixtures.  The
            # old implementation silently discarded valid events when a team
            # or fixture was not present in the demo seed database.
            if not home:
                home = Team(name=home_name, league="Premier League")
                self.db.add(home)
                self.db.flush()
                teams_by_name[self._normalise(home_name)] = home
            if not away:
                away = Team(name=away_name, league="Premier League")
                self.db.add(away)
                self.db.flush()
                teams_by_name[self._normalise(away_name)] = away

            match_date = self._parse_commence_time(market.get("commence_time"))
            if not match_date:
                continue

            fixture = next(
                (
                    item
                    for item in fixtures
                    if item.home_team_id == home.id
                    and item.away_team_id == away.id
                    and item.status == "SCHEDULED"
                ),
                None,
            )
            if not fixture:
                fixture = Fixture(
                    home_team_id=home.id,
                    away_team_id=away.id,
                    match_date=match_date,
                    status="SCHEDULED",
                )
                self.db.add(fixture)
                self.db.flush()
                fixtures.append(fixture)
            else:
                # Replace demo/stale dates with the live provider timestamp.
                fixture.match_date = match_date

            self.db.add(
                MarketQuote(
                    fixture_id=fixture.id,
                    provider=market["provider"],
                    home_odds=market["home_odds"],
                    draw_odds=market["draw_odds"],
                    away_odds=market["away_odds"],
                    captured_at=datetime.utcnow(),
                )
            )
            updated += 1
        self.db.commit()
        logger.info("Ingested %s upcoming markets.", updated)
        return updated

    @staticmethod
    def _parse_commence_time(value: Any) -> datetime | None:
        """Convert an Odds API ISO timestamp to a naive UTC datetime."""
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
            return parsed
        except ValueError:
            logger.warning("Skipping market with invalid commence_time=%r", value)
            return None

    def refresh(self) -> int:
        try:
            markets = self.fetch_odds()
            return self.ingest_odds(markets)
        except Exception:
            logger.exception("Odds refresh failed.")
            raise

    def update_team_strengths(self) -> dict[str, float | int]:
        completed = list(
            self.db.scalars(
                select(Fixture).where(
                    Fixture.status == "COMPLETED",
                    Fixture.home_goals.is_not(None),
                    Fixture.away_goals.is_not(None),
                )
            )
        )
        teams = list(self.db.scalars(select(Team)).all())
        fixture_count = len(completed)
        league_avg_goals_home = (
            sum(item.home_goals or 0 for item in completed) / fixture_count
            if fixture_count
            else 1.8
        )
        league_avg_goals_away = (
            sum(item.away_goals or 0 for item in completed) / fixture_count
            if fixture_count
            else 1.2
        )
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
        for fixture in completed:
            home = aggregate[fixture.home_team_id]
            away = aggregate[fixture.away_team_id]
            home["home_games"] += 1
            home["goals_scored_home"] += fixture.home_goals or 0
            home["goals_conceded_home"] += fixture.away_goals or 0
            away["away_games"] += 1
            away["goals_scored_away"] += fixture.away_goals or 0
            away["goals_conceded_away"] += fixture.home_goals or 0

        for team in teams:
            value = aggregate[team.id]
            stats = self.db.scalar(
                select(TeamStats).where(TeamStats.team_id == team.id)
            )
            if not stats:
                stats = TeamStats(team_id=team.id)
                self.db.add(stats)
            home_games = value["home_games"]
            away_games = value["away_games"]
            stats.matches_played = int(home_games + away_games)
            stats.goals_scored_home = int(value["goals_scored_home"])
            stats.goals_conceded_home = int(value["goals_conceded_home"])
            stats.goals_scored_away = int(value["goals_scored_away"])
            stats.goals_conceded_away = int(value["goals_conceded_away"])
            stats.attack_strength_home = self._strength(
                value["goals_scored_home"], home_games, league_avg_goals_home
            )
            stats.defense_strength_home = self._strength(
                value["goals_conceded_home"], home_games, league_avg_goals_away
            )
            stats.attack_strength_away = self._strength(
                value["goals_scored_away"], away_games, league_avg_goals_home
            )
            stats.defense_strength_away = self._strength(
                value["goals_conceded_away"], away_games, league_avg_goals_home
            )
            stats.updated_at = datetime.utcnow()
        self.db.commit()
        logger.info(
            "Team strengths refreshed using %s completed fixtures.",
            fixture_count,
        )
        return {
            "league_avg_goals_home": round(league_avg_goals_home, 3),
            "league_avg_goals_away": round(league_avg_goals_away, 3),
            "completed_fixtures": fixture_count,
        }

    @staticmethod
    def _compact(value: str) -> str:
        return "".join(
            character
            for character in value.lower().replace("football club", "").replace("fc", "")
            if character.isalnum()
        )

    @classmethod
    def _normalise(cls, value: str) -> str:
        compact = cls._compact(value)
        return TEAM_NAME_ALIASES.get(compact, compact)

    @staticmethod
    def _strength(total: float, games: float, average: float) -> float:
        if games <= 0 or average <= 0:
            return 1.0
        return round((total / games) / average, 6)
