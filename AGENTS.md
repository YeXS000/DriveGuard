# DriveGuard Engineering Instructions

## Source of truth

- `DriveGuard.md` is the authoritative architecture, implementation plan, stage-gate specification, and acceptance criteria for this repository.
- Read the relevant section of `DriveGuard.md` before implementing any phase.
- Do not silently change architecture, risk levels, safety boundaries, acceptance metrics, or technology choices.
- If an external library API has changed, verify the current official documentation and record the adjustment in an ADR.

## Project boundary

DriveGuard is a safety-aware driving service orchestration Agent Runtime.

The LLM may understand, plan, and request capabilities.

The LLM must never directly control:

- steering
- throttle
- braking
- AEB
- ESC
- other safety-critical vehicle actuators

RX capabilities must never be registered as LLM tools.

The side-effect path must remain:

LLM
-> Tool Contract
-> Policy Engine
-> Confirmation / Action State Machine
-> Reliable Executor
-> External Service / Simulator
-> Persistence / Audit

## Stage-gate workflow

- Implement only the phase explicitly requested in the current task.
- Do not begin the next phase automatically.
- Before editing, inspect the existing implementation and list the files/modules affected.
- Preserve interfaces already accepted by previous phases unless the current phase explicitly requires a change.
- Every phase must finish with tests and an explicit PASS/FAIL gate result.
- Never mark a phase PASS unless its acceptance criteria were actually executed and measured.

## Secrets

- Never read, print, summarize, log, copy, commit, or expose `api_key.md`.
- Never hard-code API keys.
- Application secrets must come from environment variables.
- Use `DEEPSEEK_API_KEY` for the DriveGuard runtime.
- Tests must mock the LLM provider by default.
- Live DeepSeek tests must be opt-in and must never print credentials.

## Engineering

- Use TypeScript strict mode.
- Use Node.js 22 or the minimum version required by the verified Pi Agent version, whichever is stricter.
- Use the repository-declared npm version and npm workspaces; do not introduce a second lockfile or package manager.
- Keep package-manager usage consistent across the repository.
- Prefer explicit typed interfaces over implicit object shapes.
- Validate external inputs at boundaries.
- Keep domain, policy, executor, persistence, simulator, and Agent Runtime separated.
- Avoid circular package dependencies.

## Testing

After modifying code, run the relevant:

- format
- lint
- typecheck
- unit tests
- contract tests
- integration tests

For safety-sensitive code, run safety and boundary tests.

Do not suppress failing tests merely to make CI pass.

## Safety-critical modules

Changes to:

- policy
- confirmation
- action state machine
- executor
- idempotency
- capability registry

must include tests for:

- normal behavior
- boundary behavior
- invalid inputs
- stale context
- duplicate requests
- failure behavior where relevant

## Documentation

Maintain:

`docs/implementation-status.md`

For every phase record:

- status
- scope
- files/modules implemented
- tests executed
- measured metrics
- gate result
- known limitations

Important architectural decisions must be added under:

`docs/adr/`

## Completion

A task is not complete simply because code compiles.

A phase is complete only when:

1. implementation is finished;
2. relevant tests pass;
3. acceptance metrics are checked;
4. code review finds no unresolved critical issue;
5. implementation-status.md is updated.

Never claim project-level target metrics before they have actually been measured.

## Repository and worktree layout

- Stable checkout: `/home/yej/work/Pi/DriveGuard` on `main`.
- Stage worktrees: sibling `DriveGuard_phase/<stage-name>`; create with `git worktree add`, never copy a repository folder.
- Each worktree is a full source checkout. Put stage-only reports and experiments in its `artifacts/` directory; never add numbered stage directories to the application root.
- Maintain reusable regression tests under `tests/`, reusable load tools under `benchmarks/`, and fault topology under `infra/faults/`.
- Main must not track stage-only artifacts. Before a phase merge, separate accepted application changes from phase evidence; retain evidence on the phase branch or an archive ref and exclude it from the main merge.
- A clean commit may preserve failed-stage evidence; it does not mean Stage Gate PASS or authorize merging the failed phase.
- Historical stage worktrees retain their historical tree and paths for reproducibility. Do not mass-update them to current main or hide tests to create a false clean view.
