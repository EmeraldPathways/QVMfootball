"""Import historical market snapshots for honest ROI/CLV backtesting."""

from __future__ import annotations

import argparse
import logging
from datetime import datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from advanced_models import record_snapshot
from config import settings
from database import SessionLocal, ensure_schema
from data_pipeline import DataPipeline
from models import Fixture, MarketQuote, Team

logger = logging.getLogger("qvm.historical_odds")


def import_snapshot(db: Session, payload: Any) -> int:
    if not isinstance(payload, list):
        return 0
    teams = {DataPipeline._normalise(team.name): team for team in db.scalars(select(Team)).all()}
    fixtures = list(db.scalars(select(Fixture)).all())
    count = 0
    for event in payload:
        if not isinstance(event, dict):
            continue
        home = teams.get(DataPipeline._normalise(str(event.get("home_team", ""))))
        away = teams.get(DataPipeline._normalise(str(event.get("away_team", ""))))
        if not home or not away:
            continue
        fixture = next((item for item in fixtures if item.home_team_id == home.id and item.away_team_id == away.id), None)
        if not fixture:
            continue
        for bookmaker in event.get("bookmakers", []):
            market = next((item for item in bookmaker.get("markets", []) if item.get("key") == "h2h"), None)
            if not market:
                continue
            prices = {item.get("name"): item.get("price") for item in market.get("outcomes", [])}
            if not all(isinstance(prices.get(name), (int, float)) for name in (event.get("home_team"), event.get("away_team"), "Draw")):
                continue
            odds = [float(prices[event["home_team"]]), float(prices["Draw"]), float(prices[event["away_team"]])]
            overround = sum(1 / value for value in odds) - 1
            db.add(MarketQuote(fixture_id=fixture.id, provider=bookmaker.get("title", "historical"), home_odds=odds[0], draw_odds=odds[1], away_odds=odds[2], captured_at=datetime.fromisoformat(str(event.get("last_update", "")).replace("Z", "+00:00")).replace(tzinfo=None) if event.get("last_update") else datetime.utcnow(), bookmaker_count=1, overround=overround, market_type="1X2"))
            count += 1
    db.commit()
    return count


def fetch_and_import(url: str, api_key: str) -> int:
    ensure_schema()
    with httpx.Client(timeout=settings.request_timeout_seconds) as client:
        response = client.get(url, params={"apiKey": api_key, "regions": settings.odds_api_regions, "markets": "h2h", "oddsFormat": "decimal"})
        response.raise_for_status()
        payload = response.json()
    with SessionLocal() as db:
        record_snapshot(db, "historical-odds", url, payload)
        return import_snapshot(db, payload)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=settings.historical_odds_url)
    parser.add_argument("--api-key", default=settings.historical_odds_api_key)
    args = parser.parse_args()
    if not args.url or not args.api_key:
        raise SystemExit("Set HISTORICAL_ODDS_URL and HISTORICAL_ODDS_API_KEY first.")
    print(f"Imported {fetch_and_import(args.url, args.api_key)} historical market quotes.")


if __name__ == "__main__":
    main()
