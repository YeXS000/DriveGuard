"""Official CAR-bench Agent adapter backed by the DriveGuard Pi/DeepSeek planning bridge."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any

from car_bench.agents.base import Agent
from car_bench.types import AgentState

BRIDGE_TIMEOUT_SECONDS = 120


def sanitized_bridge_error(stderr: str) -> str:
    """Retain actionable provider diagnostics without exposing credentials."""
    compact = " ".join(stderr.strip().split())
    compact = re.sub(r"sk-[A-Za-z0-9_-]+", "[REDACTED]", compact)
    return compact[-1000:] if compact else "no stderr"


class CarBenchAgentAdapter(Agent):
    """Evaluation-only adapter. CAR-bench owns tools, state transitions and evaluation."""

    def __init__(self, tools_info: list[dict[str, Any]], wiki: str, bridge: Path) -> None:
        self.tools_info = tools_info
        self.wiki = wiki
        self.bridge = bridge

    def get_init_state(self, system_prompt: str, initial_observation: str) -> AgentState:
        return AgentState(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": initial_observation},
            ]
        )

    def generate_next_message(
        self, state: AgentState, tools_info: list[dict[str, Any]]
    ) -> tuple[dict[str, Any], AgentState]:
        if not os.environ.get("DEEPSEEK_API_KEY", "").strip():
            raise RuntimeError("DEEPSEEK_API_KEY is required for CAR-bench live evaluation")
        request = {
            "systemPrompt": self.wiki,
            "messages": state.messages,
            "tools": tools_info,
            "model": os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        }
        started = time.perf_counter()
        try:
            completed = subprocess.run(
                ["node", str(self.bridge)],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                check=False,
                env=os.environ.copy(),
                timeout=BRIDGE_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(
                f"DriveGuard Pi bridge timed out after {BRIDGE_TIMEOUT_SECONDS} seconds"
            ) from error
        latency_ms = (time.perf_counter() - started) * 1000
        if completed.returncode != 0:
            # Never include request data or environment values in this failure.
            detail = sanitized_bridge_error(completed.stderr)
            raise RuntimeError(
                f"DriveGuard Pi bridge failed with exit code {completed.returncode}: {detail}"
            )
        next_message = json.loads(completed.stdout)
        updated = AgentState(
            messages=state.messages + [next_message],
            total_cost=state.total_cost,
            total_llm_induced_latency_ms=state.total_llm_induced_latency_ms + latency_ms,
            turn_counter=state.turn_counter,
            least_prompt_tokens=state.least_prompt_tokens,
            latest_prompt_tokens=state.latest_prompt_tokens,
        )
        return next_message, updated


def factory(bridge: Path):
    def create(tools_info: list[dict[str, Any]], wiki: str, _args: Any) -> Agent:
        return CarBenchAgentAdapter(tools_info, wiki, bridge)

    return create
