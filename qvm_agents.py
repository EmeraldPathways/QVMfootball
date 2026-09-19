"""Bounded Manager and Worker agents for the Windows QVM process.

The agents review deterministic facts and return structured proposals. They
do not own the probability model, risk limits, bankroll, or execution path.
Those responsibilities stay in the Python modules that can be tested without
an LLM.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from typing import Any

import httpx

from config import settings


LOGGER = logging.getLogger("qvm.agents")


class AgentError(RuntimeError):
    """Raised when a configured model call cannot produce a valid response."""


WORKER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "status": {"type": "string", "enum": ["READY", "DEGRADED", "BLOCKED"]},
        "summary": {"type": "string"},
        "top_fixture_id": {"type": ["integer", "null"]},
        "top_selection": {"type": ["string", "null"]},
        "data_quality_flags": {"type": "array", "items": {"type": "string"}},
        "research_tasks": {"type": "array", "items": {"type": "string"}},
    },
    "required": [
        "status",
        "summary",
        "top_fixture_id",
        "top_selection",
        "data_quality_flags",
        "research_tasks",
    ],
}

MANAGER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "decision": {
            "type": "string",
            "enum": ["NO_ACTION", "REQUEST_MORE_DATA", "PAPER_TRADE_RECOMMENDATION"],
        },
        "summary": {"type": "string"},
        "fixture_id": {"type": ["integer", "null"]},
        "selection": {"type": ["string", "null"]},
        "confidence": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
        "risk_flags": {"type": "array", "items": {"type": "string"}},
        "rejection_reason": {"type": ["string", "null"]},
    },
    "required": [
        "decision",
        "summary",
        "fixture_id",
        "selection",
        "confidence",
        "risk_flags",
        "rejection_reason",
    ],
}

AUDITOR_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "status": {"type": "string", "enum": ["PASS", "BLOCK"]},
        "summary": {"type": "string"},
        "violations": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["status", "summary", "violations"],
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class AgentReport:
    agent_name: str
    role: str
    model: str
    status: str
    task: str
    summary: str
    payload: dict[str, Any]
    started_at: str
    finished_at: str

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class LunaClient:
    """Small Responses API client with an account-configurable model ID."""

    def __init__(
        self,
        api_key: str = settings.openai_api_key,
        base_url: str = settings.openai_base_url,
        model: str = settings.openai_model,
        timeout_seconds: float = max(settings.request_timeout_seconds, 30),
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout_seconds = timeout_seconds

    @property
    def enabled(self) -> bool:
        return bool(self.api_key and self.model)

    @property
    def display_model(self) -> str:
        return self.model or settings.luna_model_label

    def complete_json(
        self,
        *,
        instructions: str,
        facts: dict[str, Any],
        schema_name: str,
        schema: dict[str, Any],
    ) -> dict[str, Any] | None:
        if not self.enabled:
            LOGGER.info(
                "%s is not configured; using deterministic agent fallback.",
                settings.luna_model_label,
            )
            return None

        body = {
            "model": self.model,
            "input": [
                {
                    "role": "system",
                    "content": [{"type": "input_text", "text": instructions}],
                },
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": json.dumps(facts, ensure_ascii=False, default=str),
                        }
                    ],
                },
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": schema_name,
                    "strict": True,
                    "schema": schema,
                }
            },
        }
        try:
            with httpx.Client(timeout=self.timeout_seconds) as client:
                response = client.post(
                    f"{self.base_url}/responses",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "Content-Type": "application/json",
                    },
                    json=body,
                )
                response.raise_for_status()
                payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            LOGGER.exception("Luna agent request failed.")
            raise AgentError(str(error)) from error

        raw_text = self._extract_text(payload)
        if not raw_text:
            raise AgentError("The Luna response did not contain output text.")
        try:
            parsed = json.loads(self._strip_code_fence(raw_text))
        except json.JSONDecodeError as error:
            LOGGER.exception("Luna agent returned invalid JSON.")
            raise AgentError("The Luna response was not valid JSON.") from error
        if not isinstance(parsed, dict):
            raise AgentError("The Luna response was not a JSON object.")
        return parsed

    @staticmethod
    def _extract_text(payload: Any) -> str:
        if not isinstance(payload, dict):
            return ""
        output_text = payload.get("output_text")
        if isinstance(output_text, str):
            return output_text
        for item in payload.get("output", []):
            if not isinstance(item, dict):
                continue
            for content in item.get("content", []):
                if isinstance(content, dict) and isinstance(content.get("text"), str):
                    return content["text"]
        return ""

    @staticmethod
    def _strip_code_fence(value: str) -> str:
        cleaned = value.strip()
        if cleaned.startswith("```") and cleaned.endswith("```"):
            lines = cleaned.splitlines()
            return "\n".join(lines[1:-1]).strip()
        return cleaned


class WorkerAgent:
    """Data-quality and opportunity analyst with no execution authority."""

    def __init__(self, client: LunaClient | None = None) -> None:
        self.client = client or LunaClient()

    def run(self, facts: dict[str, Any]) -> AgentReport:
        started = utc_now()
        task = "Validate the latest QVM data and rank paper-trading candidates."
        deterministic = self._fallback(facts)
        status = "SUCCEEDED" if self.client.enabled else "DEGRADED"
        payload = deterministic
        try:
            model_output = self.client.complete_json(
                instructions=(
                    "You are the QVM Worker Agent. Review only the supplied facts. "
                    "Do not invent injuries, news, prices, or probabilities. Flag stale "
                    "or contradictory data. Rank candidates, but never approve or place "
                    "a wager. Return only the requested JSON schema."
                ),
                facts=facts,
                schema_name="qvm_worker_report",
                schema=WORKER_SCHEMA,
            )
            if model_output is not None:
                payload = model_output
        except AgentError as error:
            status = "DEGRADED"
            payload = {**deterministic, "data_quality_flags": [f"Luna unavailable: {error}"]}

        return AgentReport(
            agent_name="QVM Worker",
            role="WORKER",
            model=self.client.display_model,
            status=status,
            task=task,
            summary=str(payload.get("summary", "Worker analysis completed.")),
            payload=payload,
            started_at=started,
            finished_at=utc_now(),
        )

    @staticmethod
    def _fallback(facts: dict[str, Any]) -> dict[str, Any]:
        candidates = facts.get("candidates", [])
        top = max(
            (item for item in candidates if isinstance(item, dict)),
            key=lambda item: float(item.get("edge_pct", 0)),
            default=None,
        )
        quality_flags: list[str] = []
        if not facts.get("markets"):
            quality_flags.append("No current market quotes are available.")
        if facts.get("risk", {}).get("status") == "HALTED":
            quality_flags.append("Risk gate is halted; candidates are informational only.")
        return {
            "status": "DEGRADED" if quality_flags else "READY",
            "summary": (
                "Deterministic worker review selected the highest available edge."
                if top
                else "No qualifying candidate is currently available."
            ),
            "top_fixture_id": top.get("fixture_id") if top else None,
            "top_selection": top.get("selection") if top else None,
            "data_quality_flags": quality_flags,
            "research_tasks": [],
        }


class ManagerAgent:
    """Senior reviewer that can recommend paper action but cannot execute it."""

    def __init__(self, client: LunaClient | None = None) -> None:
        self.client = client or LunaClient()

    def run(
        self,
        worker_report: AgentReport,
        facts: dict[str, Any],
    ) -> AgentReport:
        started = utc_now()
        task = "Review the Worker report and issue a constrained paper-trade recommendation."
        deterministic = self._fallback(worker_report, facts)
        status = "SUCCEEDED" if self.client.enabled else "DEGRADED"
        payload = deterministic
        try:
            model_output = self.client.complete_json(
                instructions=(
                    "You are the QVM Manager Agent. Audit the Worker report against the "
                    "supplied deterministic facts. You may recommend paper trading only. "
                    "Never override the risk gate, invent evidence, change thresholds, "
                    "or place a bet. Choose REQUEST_MORE_DATA when facts are stale or "
                    "conflicting. Return only the requested JSON schema."
                ),
                facts={"worker_report": worker_report.as_dict(), **facts},
                schema_name="qvm_manager_decision",
                schema=MANAGER_SCHEMA,
            )
            if model_output is not None:
                payload = model_output
        except AgentError as error:
            status = "DEGRADED"
            payload = {**deterministic, "risk_flags": [f"Luna unavailable: {error}"]}

        return AgentReport(
            agent_name="QVM Manager",
            role="MANAGER",
            model=self.client.display_model,
            status=status,
            task=task,
            summary=str(payload.get("summary", "Manager review completed.")),
            payload=payload,
            started_at=started,
            finished_at=utc_now(),
        )

    @staticmethod
    def _fallback(worker_report: AgentReport, facts: dict[str, Any]) -> dict[str, Any]:
        risk = facts.get("risk", {})
        if risk.get("status") == "HALTED":
            return {
                "decision": "NO_ACTION",
                "summary": "No recommendation because the deterministic risk gate is halted.",
                "fixture_id": None,
                "selection": None,
                "confidence": "HIGH",
                "risk_flags": ["Risk gate halted"],
                "rejection_reason": "Daily loss, exposure, or kill-switch constraint.",
            }
        if worker_report.payload.get("data_quality_flags"):
            return {
                "decision": "REQUEST_MORE_DATA",
                "summary": "Additional validation is required before a paper proposal.",
                "fixture_id": None,
                "selection": None,
                "confidence": "MEDIUM",
                "risk_flags": list(worker_report.payload["data_quality_flags"]),
                "rejection_reason": "Worker identified data-quality flags.",
            }
        fixture_id = worker_report.payload.get("top_fixture_id")
        selection = worker_report.payload.get("top_selection")
        if fixture_id is None or selection is None:
            return {
                "decision": "NO_ACTION",
                "summary": "No qualifying paper-trading candidate is available.",
                "fixture_id": None,
                "selection": None,
                "confidence": "HIGH",
                "risk_flags": [],
                "rejection_reason": "No candidate exceeded the configured threshold.",
            }
        return {
            "decision": "PAPER_TRADE_RECOMMENDATION",
            "summary": "Candidate passes the deterministic edge threshold; manual review remains required.",
            "fixture_id": fixture_id,
            "selection": selection,
            "confidence": "MEDIUM",
            "risk_flags": [],
            "rejection_reason": None,
        }


class AuditorAgent:
    """Independent consistency checker with veto-only semantics."""

    def __init__(self, client: LunaClient | None = None) -> None:
        self.client = client or LunaClient()

    def run(self, worker_report: AgentReport, manager_report: AgentReport, facts: dict[str, Any]) -> AgentReport:
        started = utc_now()
        deterministic = self._fallback(worker_report, manager_report, facts)
        status = "SUCCEEDED" if self.client.enabled else "DEGRADED"
        payload = deterministic
        try:
            model_output = self.client.complete_json(
                instructions=(
                    "You are the QVM Auditor Agent. Check the reports against the supplied "
                    "facts. You have veto authority only. Do not change probabilities, odds, "
                    "stakes, thresholds, or execute anything. Return only the JSON schema."
                ),
                facts={"worker": worker_report.as_dict(), "manager": manager_report.as_dict(), **facts},
                schema_name="qvm_auditor_report",
                schema=AUDITOR_SCHEMA,
            )
            if model_output is not None:
                payload = model_output
        except AgentError as error:
            status = "DEGRADED"
            payload = {**deterministic, "violations": [f"Luna unavailable: {error}"]}
        return AgentReport(
            agent_name="QVM Auditor",
            role="AUDITOR",
            model=self.client.display_model,
            status=status,
            task="Verify evidence, deterministic gates and agent consistency.",
            summary=str(payload.get("summary", "Audit completed.")),
            payload=payload,
            started_at=started,
            finished_at=utc_now(),
        )

    @staticmethod
    def _fallback(worker: AgentReport, manager: AgentReport, facts: dict[str, Any]) -> dict[str, Any]:
        violations = []
        if facts.get("risk", {}).get("status") == "HALTED":
            violations.append("Risk gate is halted.")
        if manager.payload.get("decision") == "PAPER_TRADE_RECOMMENDATION" and not worker.payload.get("top_fixture_id"):
            violations.append("Manager recommendation has no Worker fixture.")
        if manager.payload.get("decision") == "PAPER_TRADE_RECOMMENDATION" and facts.get("calibration", {}).get("status") == "INSUFFICIENT_DATA":
            violations.append("Calibration sample is insufficient.")
        return {
            "status": "BLOCK" if violations else "PASS",
            "summary": "Audit blocked the recommendation." if violations else "Deterministic checks and agent outputs are consistent.",
            "violations": violations,
        }
