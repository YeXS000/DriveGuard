#!/usr/bin/env python3
"""Generate the pre-run compatibility manifest from the pinned official CAR-bench test data."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from datasets import load_dataset

DATASET_REPO = "johanneskirmayr/car-bench-dataset"
DATASET_REVISION = "1fcf24ad802c42e04a0d8fe05b5ca0d481a4e7af"
TASK_TYPES = ("base", "hallucination", "disambiguation")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    entries: list[dict[str, object]] = []
    for task_type in TASK_TYPES:
        dataset = load_dataset(
            DATASET_REPO,
            f"tasks_{task_type}",
            split="test",
            revision=DATASET_REVISION,
        )
        for row in dataset:
            actions = json.loads(row["actions"])
            required_tools = list(dict.fromkeys(action["name"] for action in actions))
            entries.append(
                {
                    "taskId": row["task_id"],
                    "taskType": task_type,
                    "supported": True,
                    "reason": "Official dynamic tool schema is passed through the evaluation-only CarBenchAgentAdapter.",
                    "requiredTools": required_tools,
                    "mapping": {tool: "car-bench passthrough" for tool in required_tools},
                }
            )
    entries.sort(key=lambda item: (TASK_TYPES.index(str(item["taskType"])), str(item["taskId"])))
    payload = {
        "generatedBeforeModelRun": True,
        "repositoryCommit": "54990894241f2c07e9b523928c2a29e9b693d313",
        "datasetCommit": DATASET_REVISION,
        "testTaskCount": len(entries),
        "supportedCount": sum(1 for item in entries if item["supported"]),
        "coverage": f"{sum(1 for item in entries if item['supported'])}/{len(entries)}",
        "tasks": entries,
    }
    if len(entries) != 125:
        raise RuntimeError(f"Official test split count changed: expected 125, got {len(entries)}")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
