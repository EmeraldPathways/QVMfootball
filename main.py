import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from config import settings
from backtesting import run_walk_forward_backtest
from data_pipeline import DataPipeline
from database import SessionLocal, ensure_schema, get_db
from execution import ExecutionAgent
from modeling import calculate_match_probabilities, rebuild_predictions
from models import (
    Fixture,
    AgentRun,
    MarketQuote,
    Prediction,
    SimulatedBet,
    Team,
    UserPortfolio,
)
from advanced_models import run_counterfactual

logging.basicConfig(
    filename="system.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("qvm.main")

app = FastAPI(
    title="QVM Football Workbench",
    description="Private quantitative value modeling and football paper-trading simulator.",
    version="1.0.0",
)
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


class PaperBetRequest(BaseModel):
    fixture_id: int
    selection: Literal["HOME", "DRAW", "AWAY"]


class CounterfactualRequest(BaseModel):
    bankroll: float
    probability: float
    odds: float
    stake: float
    probability_shift: float = 0.0
    odds_shift: float = 0.0
    commission_pct: float = 0.0


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "mode": "paper", "service": "qvm-football-workbench"}


@app.post("/api/counterfactual")
def counterfactual(request: CounterfactualRequest) -> dict[str, float]:
    return run_counterfactual(**request.model_dump())


def seed_initial_data(db: Session) -> None:
    if db.scalar(select(Team).limit(1)):
        return
    team_names = [
        "Arsenal",
        "Chelsea",
        "Liverpool",
        "Manchester City",
        "Newcastle United",
        "Tottenham Hotspur",
        "Brighton",
        "Aston Villa",
        "West Ham United",
        "Everton",
    ]
    teams = {name: Team(name=name, league="Premier League") for name in team_names}
    db.add_all(teams.values())
    db.flush()
    now = datetime.utcnow()
    fixture_specs = [
        ("Arsenal", "Chelsea", -12, 19, 2, 1, "COMPLETED"),
        ("Liverpool", "Tottenham Hotspur", -10, 16, 2, 2, "COMPLETED"),
        ("Manchester City", "Newcastle United", -8, 15, 3, 0, "COMPLETED"),
        ("Brighton", "Aston Villa", -6, 17, 1, 2, "COMPLETED"),
        ("West Ham United", "Everton", -4, 20, 1, 1, "COMPLETED"),
        ("Arsenal", "Liverpool", 3, 20, None, None, "SCHEDULED"),
        ("Manchester City", "Chelsea", 4, 17, None, None, "SCHEDULED"),
        ("Tottenham Hotspur", "Brighton", 5, 15, None, None, "SCHEDULED"),
        ("Aston Villa", "West Ham United", 6, 19, None, None, "SCHEDULED"),
    ]
    fixtures = []
    for home, away, day, hour, home_goals, away_goals, status in fixture_specs:
        match_date = now + timedelta(days=day)
        match_date = match_date.replace(hour=hour, minute=0, second=0, microsecond=0)
        fixtures.append(
            Fixture(
                home_team_id=teams[home].id,
                away_team_id=teams[away].id,
                match_date=match_date,
                home_goals=home_goals,
                away_goals=away_goals,
                status=status,
            )
        )
    db.add_all(fixtures)
    portfolio = UserPortfolio(
        current_bankroll=settings.paper_starting_balance,
        initial_bankroll=settings.paper_starting_balance,
    )
    db.add(portfolio)
    db.commit()
    rebuild_predictions(db)
    db.refresh(portfolio)

    quote_specs = {
        ("Arsenal", "Liverpool"): (2.55, 3.45, 2.95),
        ("Manchester City", "Chelsea"): (1.42, 4.8, 11.5),
        ("Tottenham Hotspur", "Brighton"): (2.1, 3.7, 3.65),
        ("Aston Villa", "West Ham United"): (2.05, 3.5, 3.85),
    }
    for fixture in fixtures:
        if fixture.status != "SCHEDULED":
            continue
        odds = quote_specs[(fixture.home_team.name, fixture.away_team.name)]
        db.add(
            MarketQuote(
                fixture_id=fixture.id,
                provider="Demo market",
                home_odds=odds[0],
                draw_odds=odds[1],
                away_odds=odds[2],
            )
        )
    db.commit()

    history_specs = [
        ("Arsenal", "Chelsea", "HOME", 2.2, 24, "WON"),
        ("Liverpool", "Tottenham Hotspur", "DRAW", 3.6, 20, "WON"),
        ("Manchester City", "Newcastle United", "HOME", 1.65, 30, "WON"),
        ("Brighton", "Aston Villa", "HOME", 2.8, 18, "LOST"),
        ("West Ham United", "Everton", "DRAW", 3.25, 22, "WON"),
    ]
    total_profit = 0.0
    for home, away, selection, odds, stake, outcome in history_specs:
        fixture = next(
            item
            for item in fixtures
            if item.home_team.name == home and item.away_team.name == away
        )
        prediction = db.scalar(
            select(Prediction).where(Prediction.fixture_id == fixture.id)
        )
        model = {
            "HOME": (
                prediction.true_home_prob,
                prediction.fair_home_odds,
            ),
            "DRAW": (
                prediction.true_draw_prob,
                prediction.fair_draw_odds,
            ),
            "AWAY": (
                prediction.true_away_prob,
                prediction.fair_away_odds,
            ),
        }[selection]
        profit_loss = stake * (odds - 1) if outcome == "WON" else -stake
        total_profit += profit_loss
        db.add(
            SimulatedBet(
                fixture_id=fixture.id,
                selection=selection,
                market_odds=odds,
                implied_prob=1 / odds,
                true_prob=model[0],
                edge_pct=(odds / model[1]) - 1,
                stake_amount=stake,
                status="SETTLED",
                outcome=outcome,
                profit_loss=profit_loss,
                placed_at=now - timedelta(days=8 - len(db.new)),
            )
        )
    portfolio.current_bankroll = round(portfolio.initial_bankroll + total_profit, 2)
    portfolio.updated_at = datetime.utcnow()
    db.commit()
    logger.info("Seeded QVM database with teams, fixtures, quotes, and paper history.")


def portfolio_for(db: Session) -> UserPortfolio:
    portfolio = db.scalar(select(UserPortfolio).limit(1))
    if not portfolio:
        portfolio = UserPortfolio(
            current_bankroll=settings.paper_starting_balance,
            initial_bankroll=settings.paper_starting_balance,
        )
        db.add(portfolio)
        db.commit()
        db.refresh(portfolio)
    return portfolio


@app.get("/", response_class=HTMLResponse)
def dashboard(request: Request, db: Session = Depends(get_db)):
    seed_initial_data(db)
    return templates.TemplateResponse(
        request=request,
        name="dashboard.html",
        context={"request": request, "title": "System Overview"},
    )


@app.get("/edge-finder", response_class=HTMLResponse)
def edge_finder(request: Request, db: Session = Depends(get_db)):
    seed_initial_data(db)
    return templates.TemplateResponse(
        request=request,
        name="edge_finder.html",
        context={"request": request, "title": "Edge Finder"},
    )


@app.get("/performance", response_class=HTMLResponse)
def performance(request: Request, db: Session = Depends(get_db)):
    seed_initial_data(db)
    return templates.TemplateResponse(
        request=request,
        name="performance.html",
        context={"request": request, "title": "Performance Audit Hub"},
    )


@app.get("/agents", response_class=HTMLResponse)
def agents(request: Request, db: Session = Depends(get_db)):
    seed_initial_data(db)
    return templates.TemplateResponse(
        request=request,
        name="agents.html",
        context={"request": request, "title": "AI Operations"},
    )


@app.get("/api/overview")
def api_overview(db: Session = Depends(get_db)):
    seed_initial_data(db)
    portfolio = portfolio_for(db)
    bets = list(db.scalars(select(SimulatedBet).order_by(SimulatedBet.placed_at.desc())))
    settled = [bet for bet in bets if bet.status == "SETTLED"]
    wins = [bet for bet in settled if bet.outcome == "WON"]
    profit = sum(bet.profit_loss for bet in settled)
    fixtures = {fixture.id: fixture for fixture in db.scalars(select(Fixture)).all()}
    return {
        "mode": "PAPER",
        "portfolio": {
            "current_bankroll": round(portfolio.current_bankroll, 2),
            "initial_bankroll": round(portfolio.initial_bankroll, 2),
            "roi_pct": round(profit / portfolio.initial_bankroll * 100, 2),
        },
        "kpis": {
            "total_placed_bets": len(bets),
            "settled_bets": len(settled),
            "pending_bets": len(bets) - len(settled),
            "win_rate_pct": round(len(wins) / len(settled) * 100, 1) if settled else 0,
            "profit_loss": round(profit, 2),
        },
        "risk": ExecutionAgent(db).risk_summary(),
        "active_trades": [
            {
                "id": bet.id,
                "fixture_id": bet.fixture_id,
                "selection": bet.selection,
                "odds": bet.market_odds,
                "edge_pct": bet.edge_pct,
                "stake": bet.stake_amount,
                "match": (
                    fixtures[bet.fixture_id].home_team.name
                    + " vs "
                    + fixtures[bet.fixture_id].away_team.name
                ),
            }
            for bet in bets
            if bet.status == "PENDING"
        ],
    }


@app.get("/api/backtest")
def api_backtest(db: Session = Depends(get_db)):
    seed_initial_data(db)
    return run_walk_forward_backtest(db, persist=False)


@app.get("/api/agents")
def api_agents(db: Session = Depends(get_db)):
    seed_initial_data(db)
    runs = list(
        db.scalars(
            select(AgentRun)
            .order_by(AgentRun.started_at.desc(), AgentRun.id.desc())
            .limit(20)
        ).all()
    )
    return {
        "model_profile": {
            "label": settings.luna_model_label,
            "exact_model": settings.openai_model or None,
            "api_configured": bool(settings.openai_api_key and settings.openai_model),
            "execution_authority": "NONE",
        },
        "policy": {
            "mode": "PAPER",
            "manual_approval_required": True,
            "worker_can_execute": False,
            "manager_can_execute": False,
        },
        "risk": ExecutionAgent(db).risk_summary(),
        "runs": [
            {
                "id": run.id,
                "agent_name": run.agent_name,
                "role": run.role,
                "model": run.model,
                "status": run.status,
                "task": run.task,
                "summary": run.summary,
                "started_at": run.started_at.isoformat() if run.started_at else None,
                "finished_at": run.finished_at.isoformat() if run.finished_at else None,
            }
            for run in runs
        ],
    }


@app.get("/api/markets")
def api_markets(db: Session = Depends(get_db)):
    seed_initial_data(db)
    portfolio = portfolio_for(db)
    fixtures = list(
        db.scalars(select(Fixture).where(Fixture.status == "SCHEDULED")).all()
    )
    markets = []
    for fixture in fixtures:
        prediction = fixture.prediction
        quote = max(fixture.quotes, key=lambda item: item.captured_at, default=None)
        if not prediction or not quote:
            continue
        model = calculate_match_probabilities(
            db, fixture.home_team_id, fixture.away_team_id
        )
        selections = []
        for selection, odds, probability, fair in [
            ("HOME", quote.home_odds, prediction.true_home_prob, prediction.fair_home_odds),
            ("DRAW", quote.draw_odds, prediction.true_draw_prob, prediction.fair_draw_odds),
            ("AWAY", quote.away_odds, prediction.true_away_prob, prediction.fair_away_odds),
        ]:
            edge = odds / fair - 1
            kelly = max((((probability * odds) - 1) / (odds - 1)) / 4, 0)
            stake = min(
                portfolio.current_bankroll * kelly,
                portfolio.current_bankroll * settings.max_stake_pct,
            )
            selections.append(
                {
                    "selection": selection,
                    "market_odds": odds,
                    "fair_odds": fair,
                    "true_prob": probability,
                    "edge_pct": edge,
                    "suggested_stake": round(stake, 2),
                }
            )
        markets.append(
            {
                "fixture_id": fixture.id,
                "home_team": fixture.home_team.name,
                "away_team": fixture.away_team.name,
                "match_date": fixture.match_date.isoformat(),
                "provider": quote.provider,
                "lambda_home": model["lambda_home"],
                "lambda_away": model["lambda_away"],
                "grid_mass": model["grid_mass"],
                "tail_mass": model["tail_mass"],
                "quote_captured_at": quote.captured_at.isoformat(),
                "quote_age_seconds": max(
                    0,
                    round((datetime.utcnow() - quote.captured_at).total_seconds()),
                ),
                "is_stale": datetime.utcnow() - quote.captured_at
                > timedelta(seconds=settings.max_quote_age_seconds),
                "selections": selections,
            }
        )
    averages = DataPipeline(db).update_team_strengths()
    return {"markets": markets, "model": averages}


@app.get("/api/performance")
def api_performance(db: Session = Depends(get_db)):
    seed_initial_data(db)
    portfolio = portfolio_for(db)
    bets = list(
        db.scalars(
            select(SimulatedBet)
            .where(SimulatedBet.status == "SETTLED")
            .order_by(SimulatedBet.placed_at)
        ).all()
    )
    running = portfolio.initial_bankroll
    history = []
    for bet in bets:
        running += bet.profit_loss
        history.append(
            {
                "id": bet.id,
                "selection": bet.selection,
                "market_odds": bet.market_odds,
                "stake_amount": bet.stake_amount,
                "outcome": bet.outcome,
                "profit_loss": round(bet.profit_loss, 2),
                "closing_odds": bet.closing_odds,
                "clv_pct": bet.clv_pct,
                "running_bankroll": round(running, 2),
                "match": bet.fixture.home_team.name + " vs " + bet.fixture.away_team.name,
                "score": str(bet.fixture.home_goals) + "–" + str(bet.fixture.away_goals),
            }
        )
    return {
        "initial_bankroll": portfolio.initial_bankroll,
        "current_bankroll": portfolio.current_bankroll,
        "history": history,
    }


@app.post("/api/scan")
def api_scan(db: Session = Depends(get_db)):
    seed_initial_data(db)
    created = ExecutionAgent(db).scan_upcoming()
    return {"created": len(created), "mode": "PAPER"}


@app.post("/api/paper-bet")
def api_paper_bet(payload: PaperBetRequest, db: Session = Depends(get_db)):
    seed_initial_data(db)
    try:
        bet = ExecutionAgent(db).place_paper_bet(
            payload.fixture_id, payload.selection
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    return {"id": bet.id, "status": bet.status}


@app.post("/api/settle")
def api_settle(db: Session = Depends(get_db)):
    seed_initial_data(db)
    pending = list(
        db.scalars(
            select(SimulatedBet).where(SimulatedBet.status == "PENDING")
        ).all()
    )
    portfolio = portfolio_for(db)
    settled_count = 0
    for bet in pending:
        fixture = bet.fixture
        if fixture.status != "COMPLETED":
            continue
        actual = (
            "HOME"
            if fixture.home_goals > fixture.away_goals
            else "AWAY"
            if fixture.away_goals > fixture.home_goals
            else "DRAW"
        )
        bet.outcome = "WON" if actual == bet.selection else "LOST"
        bet.profit_loss = (
            bet.stake_amount * (bet.market_odds - 1)
            if bet.outcome == "WON"
            else -bet.stake_amount
        )
        quote = max(bet.fixture.quotes, key=lambda item: item.captured_at, default=None)
        if quote:
            bet.closing_odds = {
                "HOME": quote.home_odds,
                "DRAW": quote.draw_odds,
                "AWAY": quote.away_odds,
            }[bet.selection]
            if bet.closing_odds > 1:
                bet.clv_pct = round(
                    (bet.market_odds / bet.closing_odds - 1) * 100,
                    4,
                )
        bet.status = "SETTLED"
        portfolio.current_bankroll += bet.profit_loss
        settled_count += 1
    portfolio.updated_at = datetime.utcnow()
    db.commit()
    return {"settled": settled_count, "current_bankroll": portfolio.current_bankroll}


@app.on_event("startup")
def initialize_database() -> None:
    ensure_schema()
    with SessionLocal() as db:
        seed_initial_data(db)
    logger.info("QVM FastAPI application initialized.")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
