"""Dependency-free CAR-bench trial validity taxonomy."""

from __future__ import annotations

import json
from typing import Any


def classify_trial_payload(reward: float, info: Any) -> str:
    """Classify transport/evaluator validity without changing the official reward."""
    if abs(float(reward) - 1.0) <= 1e-6:
        return "VALID"
    if not isinstance(info, dict):
        return "EVALUATOR_FAILURE"
    text = json.dumps(info, ensure_ascii=False, default=str).lower()
    evaluator_markers = (
        "official evaluator crashed",
        "evaluator failure",
        "reward evaluator error",
        "invalid evaluator output",
    )
    if any(marker in text for marker in evaluator_markers):
        return "EVALUATOR_FAILURE"
    infra_markers = (
        "timed out",
        "timeoutexpired",
        "bridge timeout",
        "connection reset",
        "econnreset",
        "rate limit",
        "http 429",
        "service unavailable",
        "official user simulator",
        "simulator crash",
        "subprocess",
    )
    if "error" in info or any(marker in text for marker in infra_markers):
        return "INFRA_FAILURE"
    return "AGENT_FAILURE"
