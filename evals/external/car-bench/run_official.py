#!/usr/bin/env python3
"""Run the pinned official CAR-bench evaluator with CarBenchAgentAdapter."""

from __future__ import annotations

import argparse
import ast
import importlib.util
import json
import math
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

from pydantic import BaseModel

PINNED_COMMIT = "54990894241f2c07e9b523928c2a29e9b693d313"
TASK_COUNTS = {"base": 50, "hallucination": 50, "disambiguation": 25}
TRANSPORT_COMPATIBILITY_PATCH = "deepseek-chat-json-object-for-pydantic-response-format-v4"


def json_safe(value: Any) -> Any:
    """Normalize official diagnostic metadata so the aggregate is strict JSON."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: json_safe(child) for key, child in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(child) for child in value]
    return value


def sanitized_validation_error(error: Exception) -> str:
    compact = " ".join(str(error).split())
    compact = re.sub(r"sk-[A-Za-z0-9_-]+", "[REDACTED]", compact)
    return compact[:600]


def parse_json_compatible_object(content: str) -> dict[str, Any]:
    """Parse strict JSON first, then a Python literal object without executing code."""
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        parsed = ast.literal_eval(content)
    if not isinstance(parsed, dict):
        raise TypeError("DeepSeek structured response must be an object")
    return parsed


def load_official(repo: Path) -> ModuleType:
    commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"], text=True).strip()
    if commit != PINNED_COMMIT:
        raise RuntimeError(f"CAR-bench checkout must be pinned to {PINNED_COMMIT}; got {commit}")
    sys.path.insert(0, str(repo))
    spec = importlib.util.spec_from_file_location("official_car_bench_run", repo / "run.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("Unable to load the official CAR-bench run.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def install_deepseek_response_format_compatibility() -> None:
    """Keep official Pydantic validation while using DeepSeek Chat JSON mode."""
    import litellm
    import car_bench.envs.policy_evaluator as policy_evaluator_module
    import car_bench.envs.user.user as user_module

    original_completion = litellm.completion

    def example_for_schema(schema: dict[str, Any]) -> Any:
        if "enum" in schema:
            return schema["enum"][0]
        schema_type = schema.get("type")
        if schema_type == "object":
            properties = schema.get("properties", {})
            required = schema.get("required", list(properties))
            return {
                key: example_for_schema(properties[key])
                for key in required
                if key in properties
            }
        if schema_type == "array":
            return []
        if schema_type in {"number", "integer"}:
            return 0
        if schema_type == "boolean":
            return False
        return "example"

    def compatible_completion(*args: Any, **kwargs: Any) -> Any:
        response_format = kwargs.get("response_format")
        provider = kwargs.get("custom_llm_provider")
        if (
            provider == "deepseek"
            and isinstance(response_format, type)
            and issubclass(response_format, BaseModel)
        ):
            schema = response_format.model_json_schema()
            messages = [dict(message) for message in kwargs.get("messages", [])]
            schema_instruction = (
                "Return only one valid JSON object matching this exact JSON Schema; "
                "use JSON literals such as true, false, and null; do not use Python literals, "
                "markdown, comments, or prose. JSON Schema: "
                + json.dumps(schema, ensure_ascii=False, separators=(",", ":"))
                + ". Example valid JSON: "
                + json.dumps(example_for_schema(schema), ensure_ascii=False, separators=(",", ":"))
            )
            if messages and messages[0].get("role") == "system":
                messages[0]["content"] = f"{messages[0].get('content', '')}\n\n{schema_instruction}"
            else:
                messages.insert(0, {"role": "system", "content": schema_instruction})
            kwargs["messages"] = messages
            kwargs["response_format"] = {"type": "json_object"}
            last_error: Exception | None = None
            for attempt in range(4):
                attempt_kwargs = dict(kwargs)
                attempt_messages = [dict(message) for message in messages]
                if attempt > 0 and last_error is not None:
                    validation_detail = sanitized_validation_error(last_error)
                    attempt_messages[0]["content"] = (
                        f"{attempt_messages[0].get('content', '')}\n\n"
                        "The previous response failed validation: "
                        f"{validation_detail}. Return exactly one corrected JSON object now."
                    )
                attempt_kwargs["messages"] = attempt_messages
                result = original_completion(*args, **attempt_kwargs)
                try:
                    content = result.choices[0].message.content
                    parsed = parse_json_compatible_object(content)
                    response_format.model_validate(parsed)
                    result.choices[0].message.content = json.dumps(
                        parsed, ensure_ascii=False, separators=(",", ":")
                    )
                    return result
                except Exception as error:
                    last_error = error
                    if attempt < 3:
                        time.sleep(2 ** (attempt + 1))
            raise RuntimeError(
                "DeepSeek did not return valid JSON for the official CAR-bench response schema: "
                f"{sanitized_validation_error(last_error or RuntimeError('unknown validation error'))}"
            ) from last_error
        return original_completion(*args, **kwargs)

    user_module.completion = compatible_completion
    policy_evaluator_module.completion = compatible_completion


def count_named_lists(value: Any, names: set[str]) -> int:
    if isinstance(value, dict):
        return sum(
            (len(child) if key in names and isinstance(child, list) else count_named_lists(child, names))
            for key, child in value.items()
        )
    if isinstance(value, list):
        return sum(count_named_lists(child, names) for child in value)
    return 0


def result_metrics(results: list[Any], task_type: str | None = None) -> dict[str, Any]:
    passes = sum(1 for result in results if abs(float(result.reward) - 1.0) <= 1e-6)
    tool_errors = 0
    policy_errors = 0
    capability_failures = 0
    failures: list[dict[str, Any]] = []
    for result in results:
        info = result.info if isinstance(result.info, dict) else {}
        tool_errors += count_named_lists(info, {"tool_execution_errors"})
        policy_errors += count_named_lists(info, {"policy_llm_errors", "policy_aut_errors"})
        if float(result.reward) != 1.0:
            failures.append(
                {
                    "caseId": result.task_id,
                    "track": "external",
                    "category": "official-car-bench",
                    "expected": "official reward = 1",
                    "actual": result.info,
                    "failureReason": "official evaluator reward = 0",
                }
            )
            if task_type == "hallucination":
                capability_failures += 1
    return {
        "tasks": len(results),
        "passes": passes,
        "passAt1": passes / len(results) if results else 0,
        "toolExecutionErrors": tool_errors,
        "policyErrors": policy_errors,
        "unsupportedOrHallucinatedCapabilityFailures": capability_failures,
        "failures": failures,
    }


def namespace(task_type: str, num_tasks: int) -> SimpleNamespace:
    return SimpleNamespace(
        num_trials=1,
        env="car_voice_assistant",
        model=os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash"),
        model_provider="deepseek",
        user_model="deepseek/deepseek-chat",
        user_model_provider="deepseek",
        policy_evaluator_model="deepseek/deepseek-chat",
        policy_evaluator_model_provider="deepseek",
        agent_strategy="tool-calling",
        temperature=0.0,
        task_type=task_type,
        task_split="test",
        num_tasks=num_tasks,
        task_id_filter=None,
        log_dir="evals/reports/car-bench-raw",
        max_concurrency=1,
        seed=13,
        shuffle=0,
        user_strategy="llm",
        policy_evaluator_strategy="llm",
        few_shot_displays_path=None,
        evaluate_policy=True,
        score_tool_execution_errors=True,
        score_policy_errors=True,
        use_user_as_a_tool_tools=False,
        thinking=False,
        user_thinking=False,
        reasoning_effort="none",
        interleaved_thinking=False,
        remove_non_standard_fields_from_tools=False,
        planning_and_thinking_tool=True,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--car-bench-repo", type=Path, required=True)
    parser.add_argument("--bridge", type=Path, required=True)
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if not os.environ.get("DEEPSEEK_API_KEY", "").strip():
        raise RuntimeError("DEEPSEEK_API_KEY is required; api_key.md is not a permitted source")
    official = load_official(args.car_bench_repo.resolve())
    install_deepseek_response_format_compatibility()
    from car_bench_adapter import factory
    args.report_dir.mkdir(parents=True, exist_ok=True)
    started = datetime.now(timezone.utc).isoformat()
    all_results: list[Any] = []
    categories: dict[str, Any] = {}
    remaining = args.limit
    for task_type, full_count in TASK_COUNTS.items():
        count = full_count if remaining is None else min(full_count, max(remaining, 0))
        if count == 0:
            continue
        checkpoint = args.report_dir / "car-bench-raw" / f"{task_type}.json"
        results = official.run(
            namespace(task_type, count),
            str(checkpoint),
            custom_agent_factory=factory(args.bridge.resolve()),
        )
        categories[task_type] = result_metrics(results, task_type)
        all_results.extend(results)
        if remaining is not None:
            remaining -= count
    overall = result_metrics(all_results)
    overall["toolExecutionErrors"] = sum(item["toolExecutionErrors"] for item in categories.values())
    overall["policyErrors"] = sum(item["policyErrors"] for item in categories.values())
    overall["unsupportedOrHallucinatedCapabilityFailures"] = sum(
        item["unsupportedOrHallucinatedCapabilityFailures"] for item in categories.values()
    )
    full = len(all_results) == 125
    payload = {
        "benchmarkRunId": f"car-bench-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}",
        "repository": "https://github.com/CAR-bench/car-bench",
        "commit": PINNED_COMMIT,
        "benchmarkVersion": "0.1.0",
        "datasetCommit": "1fcf24ad802c42e04a0d8fe05b5ca0d481a4e7af",
        "resultName": "CAR-bench Full Test" if full else "CAR-bench Compatible Test Subset",
        "coverage": f"{len(all_results)}/125",
        "numTrials": 1,
        "startedAt": started,
        "completedAt": datetime.now(timezone.utc).isoformat(),
        "categories": categories,
        "overall": overall,
        "officialEvaluatorSemanticsModified": False,
        "externalTasksModified": 0,
        "postResultCherryPicking": 0,
        "transportCompatibilityPatch": TRANSPORT_COMPATIBILITY_PATCH,
        "transportCompatibilityReason": (
            "DeepSeek Chat Completions supports json_object but not LiteLLM's Pydantic json_schema request"
        ),
        "transportCompatibilityPreservesPydanticValidation": True,
        "nonFiniteOfficialMetadataNormalizedToNull": True,
    }
    json_path = args.report_dir / "external-car-bench.json"
    json_path.write_text(
        json.dumps(json_safe(payload), indent=2, ensure_ascii=False, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    markdown = [
        "# CAR-bench External Benchmark",
        "",
        f"- Commit: `{PINNED_COMMIT}`",
        f"- Result: {payload['resultName']}",
        f"- Coverage: {payload['coverage']}",
        f"- Overall Pass@1: {overall['passAt1']:.2%}",
        "",
        "| Split | Tasks | Pass@1 | Tool errors | Policy errors | Unsupported / hallucinated failures |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for task_type in TASK_COUNTS:
        if task_type in categories:
            item = categories[task_type]
            markdown.append(
                f"| {task_type} | {item['tasks']} | {item['passAt1']:.2%} | {item['toolExecutionErrors']} | {item['policyErrors']} | {item['unsupportedOrHallucinatedCapabilityFailures']} |"
            )
    (args.report_dir / "external-car-bench.md").write_text("\n".join(markdown) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
