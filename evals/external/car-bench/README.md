# CAR-bench evaluation-only integration

This directory pins and adapts the official CAR-bench without changing production DriveGuard Tool, Policy, Confirmation, Executor or persistence modules.

Prerequisites:

1. Check out `https://github.com/CAR-bench/car-bench` at commit `54990894241f2c07e9b523928c2a29e9b693d313` outside this repository.
2. Install that checkout's official Python dependencies in an isolated Python 3.11+ environment.
3. Build DriveGuard with `npm run build`.
4. Export `DEEPSEEK_API_KEY` interactively. Never read `api_key.md`.

Focused smoke example:

```bash
python evals/external/car-bench/run_official.py \
  --car-bench-repo /tmp/driveguard-phase13-car-bench \
  --bridge dist/evals/external/car-bench/pi-bridge.js \
  --report-dir evals/reports \
  --limit 5
```

Final test omits `--limit`. The wrapper verifies the pinned official commit, uses the official `run()` and evaluator, runs Base/Hallucination/Disambiguation test tasks with one trial, and writes separate External reports. Compatibility is declared before model execution in `car-bench-compatibility.json`.

The evaluation-only wrapper installs transport patch `deepseek-chat-json-object-for-pydantic-response-format-v4` for the current DeepSeek Chat Completions API. Official CAR-bench passes Pydantic classes to LiteLLM, which serializes them as an unsupported `json_schema` response format. The adapter requests DeepSeek's documented `json_object` mode, injects the exact original JSON Schema plus a schema-derived example into the internal user/policy prompt, parses strict JSON first with a safe Python-literal fallback, retries validation at most four times, and leaves CAR-bench's original Pydantic validation, task data, evaluator and reward semantics unchanged.

Official diagnostic objects may contain Python non-finite floats such as `Infinity`. The aggregate report recursively normalizes only those non-finite diagnostic values to JSON `null` and serializes with `allow_nan=False`; scores, tasks, failures and evaluator semantics are unchanged.

The adapter passes official dynamic Tool schemas to the Pi/DeepSeek planning bridge and returns Tool calls to CAR-bench. CAR-bench remains responsible for Tool execution, world state, LLM user simulation and scoring. This track does not measure DriveGuard ConfirmationService, ReliableExecutor, durable idempotency or NATS urgent handling.
