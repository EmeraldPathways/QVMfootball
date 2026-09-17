"""Optional player, lineup, injury and event feed connector.

The connector is intentionally provider-neutral. It accepts a JSON endpoint
configured by the user and stores the raw response before normalising records.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import httpx
from sqlalchemy import select
from sqlalchemy.orm import Session

from advanced_models import record_snapshot
from config import settings
from models import Fixture, Player, Team

logger = logging.getLogger("qvm.football_enrichment")


class FootballEnrichmentClient:
    def __init__(self, db: Session, endpoint: str | None = None, api_key: str | None = None) -> None:
        self.db = db
        self.endpoint = endpoint or settings.football_enrichment_url
        self.api_key = api_key or settings.football_enrichment_api_key

    @property
    def enabled(self) -> bool:
        return bool(self.endpoint and self.api_key)

    def fetch(self, fixture_id: int) -> dict[str, Any] | None:
        if not self.enabled:
            return None
        try:
            with httpx.Client(timeout=settings.request_timeout_seconds) as client:
                response = client.get(self.endpoint, params={"fixture_id": fixture_id}, headers={"x-api-key": self.api_key})
                response.raise_for_status()
                payload = response.json()
            record_snapshot(self.db, "football-enrichment", self.endpoint, payload)
            return payload if isinstance(payload, dict) else {"items": payload}
        except (httpx.HTTPError, ValueError):
            logger.exception("Optional football enrichment request failed for fixture %s.", fixture_id)
            return None

    def ingest(self, fixture_id: int) -> dict[str, int]:
        payload = self.fetch(fixture_id)
        if not payload:
            return {"players": 0, "events": 0}
        teams = {team.name.lower(): team for team in self.db.scalars(select(Team)).all()}
        players = 0
        for item in payload.get("players", []):
            if not isinstance(item, dict):
                continue
            team_name = str(item.get("team", "")).lower()
            team = teams.get(team_name)
            if not team or not item.get("name"):
                continue
            existing = self.db.scalar(select(Player).where(Player.team_id == team.id, Player.name == item["name"]))
            if not existing:
                existing = Player(team_id=team.id, name=str(item["name"]))
                self.db.add(existing)
            existing.position = item.get("position")
            existing.expected_minutes = float(item.get("expected_minutes", existing.expected_minutes or 0))
            existing.attack_rating = float(item.get("attack_rating", existing.attack_rating or 0))
            existing.defence_rating = float(item.get("defence_rating", existing.defence_rating or 0))
            existing.availability = str(item.get("availability", "UNKNOWN")).upper()
            existing.source = "football-enrichment"
            existing.source_updated_at = datetime.utcnow()
            players += 1
        self.db.commit()
        return {"players": players, "events": len(payload.get("events", [])) if isinstance(payload.get("events"), list) else 0}
