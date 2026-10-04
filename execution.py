import logging
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from config import settings
from models import Fixture, MarketQuote, Prediction, SimulatedBet, UserPortfolio
from calibration import calculate_data_quality

logger = logging.getLogger("qvm.execution")

Selection = Literal["HOME", "DRAW", "AWAY"]


class ExecutionAgent:
    def __init__(self, db: Session, config=settings):
        self.db = db
        self.config = config

    def scan_upcoming(self) -> list[SimulatedBet]:
        portfolio = self._portfolio()
        risk = self.risk_summary()
        if risk["status"] == "HALTED":
            logger.warning("Paper edge scan blocked by risk gate: %s", risk["flags"])
            return []
        fixtures = list(
            self.db.scalars(
                select(Fixture).where(Fixture.status == "SCHEDULED")
            ).all()
        )
        created: list[SimulatedBet] = []
        reserved_exposure = float(risk["open_exposure"])
        for fixture in fixtures:
            prediction = fixture.prediction or self.db.scalar(
                select(Prediction).where(Prediction.fixture_id == fixture.id)
            )
            quote = self._latest_quote(fixture.id)
            if not prediction or not quote:
                continue
            if self._quote_is_stale(quote.captured_at):
                logger.info("Skipping stale quote for fixture %s.", fixture.id)
                continue
            quality = calculate_data_quality(self.db, fixture, prediction)
            if quality["score"] < self.config.min_data_quality_score:
                logger.info("Skipping low-quality fixture %s: %s", fixture.id, quality)
                continue
            options = self._evaluations(prediction, quote, portfolio.current_bankroll)
            for evaluation in options:
                existing = self.db.scalar(
                    select(SimulatedBet).where(
                        SimulatedBet.fixture_id == fixture.id,
                        SimulatedBet.selection == evaluation["selection"],
                        SimulatedBet.status == "PENDING",
                    )
                )
                if existing or evaluation["edge_pct"] <= self.config.edge_threshold:
                    continue
                if evaluation["stake_amount"] <= 0:
                    continue
                if not self._risk_allows(
                    fixture.id,
                    evaluation["stake_amount"],
                    reserved_exposure,
                ):
                    continue
                bet = SimulatedBet(
                    fixture_id=fixture.id,
                    selection=evaluation["selection"],
                    market_odds=evaluation["market_odds"],
                    implied_prob=evaluation["implied_prob"],
                    true_prob=evaluation["true_prob"],
                    edge_pct=evaluation["edge_pct"],
                    stake_amount=evaluation["stake_amount"],
                    status="PENDING",
                    placed_at=datetime.utcnow(),
                    data_quality_score=quality["score"],
                    slippage_pct=self.config.paper_slippage_pct,
                    commission_amount=0.0,
                )
                self.db.add(bet)
                created.append(bet)
                reserved_exposure += evaluation["stake_amount"]
        self.db.commit()
        logger.info(
            "Completed paper edge scan; created %s simulated bets.",
            len(created),
        )
        return created

    def evaluate_upcoming(self) -> list[dict[str, float | int | str]]:
        """Return deterministic candidates without writing paper positions."""

        portfolio = self._portfolio()
        fixtures = list(
            self.db.scalars(
                select(Fixture).where(Fixture.status == "SCHEDULED")
            ).all()
        )
        candidates: list[dict[str, float | int | str]] = []
        for fixture in fixtures:
            prediction = fixture.prediction or self.db.scalar(
                select(Prediction).where(Prediction.fixture_id == fixture.id)
            )
            quote = self._latest_quote(fixture.id)
            if not prediction or not quote or self._quote_is_stale(quote.captured_at):
                continue
            quality = calculate_data_quality(self.db, fixture, prediction)
            if quality["score"] < self.config.min_data_quality_score:
                continue
            for evaluation in self._evaluations(
                prediction, quote, portfolio.current_bankroll
            ):
                candidates.append(
                    {
                        "fixture_id": fixture.id,
                        "home_team": fixture.home_team.name,
                        "away_team": fixture.away_team.name,
                        "match_date": fixture.match_date.isoformat(),
                        "quote_captured_at": quote.captured_at.isoformat(),
                        "selection": evaluation["selection"],
                        "market_odds": evaluation["market_odds"],
                        "fair_odds": evaluation["fair_odds"],
                        "true_prob": evaluation["true_prob"],
                        "edge_pct": evaluation["edge_pct"],
                        "suggested_stake": evaluation["stake_amount"],
                        "data_quality_score": quality["score"],
                        "quality_reasons": ",".join(quality["reasons"]),
                        "market_overround": quote.overround or 0.0,
                    }
                )
        return sorted(
            candidates,
            key=lambda item: float(item["edge_pct"]),
            reverse=True,
        )

    def risk_summary(self) -> dict[str, float | int | str | bool | list[str]]:
        portfolio = self._portfolio()
        bets = list(
            self.db.scalars(
                select(SimulatedBet).order_by(SimulatedBet.placed_at)
            ).all()
        )
        pending = [bet for bet in bets if bet.status == "PENDING"]
        settled = [bet for bet in bets if bet.status == "SETTLED"]
        now = datetime.utcnow()
        day_start = datetime(now.year, now.month, now.day)
        daily_loss = sum(
            max(0.0, -bet.profit_loss)
            for bet in settled
            if bet.placed_at and bet.placed_at >= day_start
        )
        open_exposure = sum(bet.stake_amount for bet in pending)
        bankroll = max(0.0, portfolio.current_bankroll)
        max_open_exposure = bankroll * self.config.max_open_exposure_pct
        max_daily_loss = bankroll * self.config.max_daily_loss_pct
        peak = max(portfolio.initial_bankroll, 0.01)
        running = portfolio.initial_bankroll
        max_drawdown = 0.0
        for bet in settled:
            running += bet.profit_loss
            peak = max(peak, running)
            max_drawdown = max(max_drawdown, (peak - running) / peak)
        flags: list[str] = []
        if self.config.kill_switch:
            flags.append("Kill switch enabled")
        if daily_loss >= max_daily_loss > 0:
            flags.append("Daily loss limit reached")
        if open_exposure >= max_open_exposure > 0:
            flags.append("Open exposure limit reached")
        status = "HALTED" if flags else "READY"
        return {
            "status": status,
            "flags": flags,
            "kill_switch": self.config.kill_switch,
            "current_bankroll": round(bankroll, 2),
            "open_exposure": round(open_exposure, 2),
            "open_exposure_limit": round(max_open_exposure, 2),
            "daily_loss": round(daily_loss, 2),
            "daily_loss_limit": round(max_daily_loss, 2),
            "max_drawdown_pct": round(max_drawdown * 100, 2),
            "pending_bets": len(pending),
        }

    def place_paper_bet(self, fixture_id: int, selection: Selection) -> SimulatedBet:
        fixture = self.db.get(Fixture, fixture_id)
        if not fixture or fixture.status != "SCHEDULED":
            raise ValueError("Fixture is not available for paper trading.")
        prediction = fixture.prediction
        quote = self._latest_quote(fixture.id)
        if not prediction or not quote:
            raise ValueError("Prediction or market quote is unavailable.")
        quality = calculate_data_quality(self.db, fixture, prediction)
        if quality["score"] < self.config.min_data_quality_score:
            raise ValueError(f"Data-quality score {quality['score']} is below the trade threshold.")
        portfolio = self._portfolio()
        if self._quote_is_stale(quote.captured_at):
            raise ValueError("Market quote is stale; refresh the feed first.")
        evaluation = next(
            (
                item
                for item in self._evaluations(
                    prediction, quote, portfolio.current_bankroll
                )
                if item["selection"] == selection
            ),
            None,
        )
        if evaluation is None:
            raise ValueError("Selection is unavailable in the current market quote.")
        if evaluation["edge_pct"] <= self.config.edge_threshold:
            raise ValueError("Selection is below the strict 3% edge threshold.")
        risk = self.risk_summary()
        if risk["status"] == "HALTED":
            raise ValueError("Risk gate is halted: " + ", ".join(risk["flags"]))
        if not self._risk_allows(
            fixture.id,
            float(evaluation["stake_amount"]),
            float(risk["open_exposure"]),
        ):
            raise ValueError("Selection would exceed the configured exposure limits.")
        bet = SimulatedBet(
            fixture_id=fixture.id,
            selection=selection,
            market_odds=evaluation["market_odds"],
            implied_prob=evaluation["implied_prob"],
            true_prob=evaluation["true_prob"],
            edge_pct=evaluation["edge_pct"],
            stake_amount=evaluation["stake_amount"],
            status="PENDING",
            data_quality_score=quality["score"],
            slippage_pct=self.config.paper_slippage_pct,
            approval_status="MANUAL_APPROVED",
        )
        self.db.add(bet)
        self.db.commit()
        self.db.refresh(bet)
        return bet

    def _evaluations(
        self,
        prediction: Prediction,
        quote: MarketQuote,
        bankroll: float,
    ) -> list[dict[str, float | str]]:
        values = [
            ("HOME", quote.home_odds, prediction.true_home_prob, prediction.fair_home_odds),
            ("DRAW", quote.draw_odds, prediction.true_draw_prob, prediction.fair_draw_odds),
            ("AWAY", quote.away_odds, prediction.true_away_prob, prediction.fair_away_odds),
        ]
        evaluations = []
        for selection, odds, true_prob, fair_odds in values:
            if odds <= 1.0 or fair_odds <= 0.0:
                continue
            effective_odds = max(1.0, odds * (1.0 - self.config.paper_slippage_pct))
            edge_pct = (effective_odds / fair_odds) - 1.0
            kelly_f = ((true_prob * effective_odds) - 1.0) / (effective_odds - 1.0)
            quarter_kelly_f = max(kelly_f / 4.0, 0.0)
            stake = min(
                bankroll * quarter_kelly_f,
                bankroll * self.config.max_stake_pct,
            )
            evaluations.append(
                {
                    "selection": selection,
                    "market_odds": round(effective_odds, 6),
                    "fair_odds": round(fair_odds, 6),
                    "implied_prob": round(1.0 / odds, 6),
                    "true_prob": round(true_prob, 6),
                    "edge_pct": round(edge_pct, 6),
                    "stake_amount": round(stake, 2),
                }
            )
        return evaluations

    def _latest_quote(self, fixture_id: int) -> MarketQuote | None:
        return self.db.scalar(
            select(MarketQuote)
            .where(MarketQuote.fixture_id == fixture_id)
            .order_by(MarketQuote.captured_at.desc(), MarketQuote.id.desc())
        )

    def _quote_is_stale(self, captured_at: datetime) -> bool:
        return datetime.utcnow() - captured_at > timedelta(
            seconds=self.config.max_quote_age_seconds
        )

    def _risk_allows(self, fixture_id: int, stake: float, reserved_exposure: float) -> bool:
        if stake <= 0:
            return False
        portfolio = self._portfolio()
        bankroll = max(0.0, portfolio.current_bankroll)
        if stake > bankroll * self.config.max_stake_pct:
            return False
        if reserved_exposure + stake > bankroll * self.config.max_open_exposure_pct:
            return False
        fixture_exposure = sum(
            bet.stake_amount
            for bet in self.db.scalars(
                select(SimulatedBet).where(
                    SimulatedBet.fixture_id == fixture_id,
                    SimulatedBet.status == "PENDING",
                )
            ).all()
        )
        return fixture_exposure + stake <= bankroll * self.config.max_fixture_exposure_pct

    def _portfolio(self) -> UserPortfolio:
        portfolio = self.db.scalar(select(UserPortfolio).limit(1))
        if not portfolio:
            portfolio = UserPortfolio(
                current_bankroll=self.config.paper_starting_balance,
                initial_bankroll=self.config.paper_starting_balance,
            )
            self.db.add(portfolio)
            self.db.commit()
            self.db.refresh(portfolio)
        return portfolio
