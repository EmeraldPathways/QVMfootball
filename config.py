from dataclasses import dataclass
import os

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Settings:
    database_url: str = os.getenv("DATABASE_URL", "sqlite:///./qvm.sqlite3")
    odds_api_key: str = os.getenv("ODDS_API_KEY", "")
    odds_api_url: str = os.getenv(
        "ODDS_API_URL",
        "https://api.the-odds-api.com/v4/sports/soccer_epl/odds/",
    )
    odds_api_regions: str = os.getenv("ODDS_API_REGIONS", "uk")
    odds_api_markets: str = os.getenv("ODDS_API_MARKETS", "h2h")
    football_data_api_key: str = os.getenv("FOOTBALL_DATA_API_KEY", "")
    football_season: str = os.getenv("FOOTBALL_SEASON", "2026")
    paper_starting_balance: float = float(
        os.getenv("PAPER_STARTING_BALANCE", "1000.00")
    )
    edge_threshold: float = float(os.getenv("EDGE_THRESHOLD", "0.03"))
    max_stake_pct: float = float(os.getenv("MAX_STAKE_PCT", "0.10"))
    request_timeout_seconds: float = float(
        os.getenv("REQUEST_TIMEOUT_SECONDS", "10")
    )
    football_data_base_url: str = os.getenv(
        "FOOTBALL_DATA_BASE_URL", "https://football-data.co.uk"
    )
    historical_seasons: str = os.getenv(
        "HISTORICAL_SEASONS",
        "2526,2425,2324,2223,2122,2021,1920,1819,1718,1617",
    )
    # The public API model identifier is intentionally configurable.  "Luna
    # Max" is the operating profile; the exact identifier depends on the
    # models enabled for the user's OpenAI account.
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    openai_base_url: str = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")
    openai_model: str = os.getenv("OPENAI_MODEL", "")
    luna_model_label: str = os.getenv("LUNA_MODEL_LABEL", "Luna Max")
    site_url: str = os.getenv("QVM_SITE_URL", "")
    worker_shared_secret: str = os.getenv("QVM_WORKER_SHARED_SECRET", "")
    worker_interval_seconds: int = int(os.getenv("WORKER_INTERVAL_SECONDS", "300"))
    auto_paper_trades: bool = os.getenv("AUTO_PAPER_TRADES", "false").lower() == "true"
    max_open_exposure_pct: float = float(
        os.getenv("MAX_OPEN_EXPOSURE_PCT", "0.60")
    )
    max_daily_loss_pct: float = float(os.getenv("MAX_DAILY_LOSS_PCT", "0.05"))
    max_fixture_exposure_pct: float = float(
        os.getenv("MAX_FIXTURE_EXPOSURE_PCT", "0.10")
    )
    max_quote_age_seconds: int = int(os.getenv("MAX_QUOTE_AGE_SECONDS", "900"))
    kill_switch: bool = os.getenv("QVM_KILL_SWITCH", "false").lower() == "true"
    model_type: str = os.getenv("QVM_MODEL_TYPE", "dixon-coles")
    model_grid_size: int = int(os.getenv("QVM_MODEL_GRID_SIZE", "10"))
    min_data_quality_score: float = float(os.getenv("MIN_DATA_QUALITY_SCORE", "60"))
    paper_commission_pct: float = float(os.getenv("PAPER_COMMISSION_PCT", "0"))
    paper_slippage_pct: float = float(os.getenv("PAPER_SLIPPAGE_PCT", "0.002"))
    min_market_bookmakers: int = int(os.getenv("MIN_MARKET_BOOKMAKERS", "1"))
    football_enrichment_url: str = os.getenv("FOOTBALL_ENRICHMENT_URL", "")
    football_enrichment_api_key: str = os.getenv("FOOTBALL_ENRICHMENT_API_KEY", "")
    historical_odds_url: str = os.getenv("HISTORICAL_ODDS_URL", "")
    historical_odds_api_key: str = os.getenv("HISTORICAL_ODDS_API_KEY", "")


settings = Settings()
