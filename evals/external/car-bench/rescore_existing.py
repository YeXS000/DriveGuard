#!/usr/bin/env python3
"""Reclassify the frozen Phase 13 CAR-bench report without rerunning or changing rewards."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from classification import classify_trial_payload


def classify_split(split: dict[str, Any]) -> dict[str, Any]:
    failures = []
    counts = {"VALID": int(split.get("passes", 0)), "AGENT_FAILURE": 0, "INFRA_FAILURE": 0, "EVALUATOR_FAILURE": 0}
    for failure in split.get("failures", []):
        actual = failure.get("actual", {})
        classification = classify_trial_payload(0.0, actual)
        counts[classification] += 1
        failures.append({
            "caseId": failure.get("caseId"),
            "classification": classification,
            "retryCount": 0,
            "originalFailureReason": failure.get("failureReason"),
        })
    valid = counts["VALID"] + counts["AGENT_FAILURE"]
    return {
        "tasks": split.get("tasks", 0),
        "classificationCounts": counts,
        "rawPassAt1": split.get("passAt1", 0),
        "validPassAt1": counts["VALID"] / valid if valid else 0,
        "failures": failures,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=Path("evals/reports/external-car-bench.json"))
    parser.add_argument("--output-dir", type=Path, default=Path("13.1-evaluation-calibration-scorer-v2/reports/car-bench"))
    args = parser.parse_args()
    source = json.loads(args.input.read_text(encoding="utf-8"))
    categories = {name: classify_split(value) for name, value in source["categories"].items()}
    totals = {name: sum(split["classificationCounts"][name] for split in categories.values()) for name in ("VALID", "AGENT_FAILURE", "INFRA_FAILURE", "EVALUATOR_FAILURE")}
    valid = totals["VALID"] + totals["AGENT_FAILURE"]
    payload = {
        "sourceRunId": source["benchmarkRunId"],
        "benchmark": "CAR-bench",
        "coverage": source["coverage"],
        "nativeScoreCombined": False,
        "rerunPerformed": False,
        "retryPolicy": {
            "maxInfraRetries": 0,
            "retryableClassifications": ["INFRA_FAILURE"],
            "agentFailureRetries": 0,
            "originalResultsRetained": True,
        },
        "categories": categories,
        "overall": {
            "classificationCounts": totals,
            "rawPassAt1": source["overall"]["passAt1"],
            "validPassAt1": totals["VALID"] / valid if valid else 0,
        },
    }
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "car-bench-v2.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = [
        "# CAR-bench V2 Trial Classification",
        "",
        f"- Source run: `{payload['sourceRunId']}`",
        f"- Coverage: `{payload['coverage']}`",
        "- Rerun performed: `false`",
        "- Native score combined: `false`",
        "",
        "| Split | VALID | AGENT_FAILURE | INFRA_FAILURE | EVALUATOR_FAILURE | Raw Pass@1 | Valid Pass@1 |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for name in ("base", "hallucination", "disambiguation"):
        split = categories[name]
        count = split["classificationCounts"]
        lines.append(f"| {name} | {count['VALID']} | {count['AGENT_FAILURE']} | {count['INFRA_FAILURE']} | {count['EVALUATOR_FAILURE']} | {split['rawPassAt1']:.2%} | {split['validPassAt1']:.2%} |")
    (args.output_dir / "car-bench-v2.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
