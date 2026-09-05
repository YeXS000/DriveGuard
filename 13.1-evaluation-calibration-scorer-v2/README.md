# Phase 13.1 — Evaluation Calibration & Scorer V2

Phase 13.1 replaces fixed-trajectory scoring with versioned Task Contracts and action/outcome traces.
It does not change the Agent system prompt, Tool descriptions, Tool routing, production Policy rules,
confirmation semantics, Executor behavior, or model weights.

## Current status

- Scorer V2 implementation and trusted live baseline: complete; Stage Gate PASS.
- V2 dataset schema validation: 600/600 PASS.
- Required scorer regression matrix: 15/15 PASS.
- Live V2 trace: 600/600 quality and 600/600 serial latency observations complete.
- Offline delta: 600/600 scorable; 220 OLD PASS -> NEW PASS, 84 PASS -> FAIL, 32 FAIL -> PASS, and
  264 FAIL -> FAIL.
- Hard safety counters: Confirmation Bypass 0, Duplicate Side Effect 0, Forbidden Action Executed 0.
- Phase 13.2 Agent optimization: not started.

The deterministic 100% report proves only that dataset, scorer, runner, identity isolation, report
generation, and concurrency plumbing agree. It is explicitly not a model-quality result.

## Commands

```bash
npm run test:phase13.1
npm run eval:phase13.1:native
npm run eval:phase13.1:offline-rescore
npm run eval:phase13.1:native:live
npm run eval:phase13.1:latency:live
npm run eval:phase13.1:rescore:quality
npm run eval:phase13.1:rescore:latency
npm run eval:phase13.1:offline-rescore:live
```

Quality runs default to case concurrency 4. Latency runs default to concurrency 1 and are the only
V2 runs directly comparable with the Phase 13 serial latency conditions. Injected DriveGuard faults
are never retried by the benchmark runner.

## Artifacts

- `docs/evaluation-v2-design.md`: Task Contract, trace, isolation, taxonomy, and concurrency design.
- `docs/scorer-v1-vs-v2.md`: precise V1/V2 behavior changes.
- `docs/baseline-v2-report.md`: frozen quality, latency, delta, audit, and gate evidence.
- `tests/scorer-regression/scorer-v2.test.ts`: the required 15-case regression matrix.
- `reports/offline-rescore/`: legacy trace sufficiency and audit manifest; `live-v2/` holds the live
  V1-to-V2 transition report after the quality run exists.
- `reports/native-v2/deterministic/`: deterministic engineering baseline only.
- `reports/native-v2/quality-live/`: credential-backed quality run at concurrency 4.
- `reports/native-v2/latency-live/`: credential-backed serial latency run at concurrency 1.
- `reports/car-bench/`: independent CAR-bench trial-validity reclassification.
