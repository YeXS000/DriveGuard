# ADR 0001: Phase 0 toolchain and Pi package coordinates

- Status: Accepted
- Date: 2026-08-25

## Context

`DriveGuard.md` names Pi Agent Core and Pi AI but may contain package coordinates that drift over time. Phase 0 must establish a reproducible TypeScript monorepo without integrating DriveGuard business behavior.

The official Pi repository, release, package manifests, and registry metadata were checked on 2026-08-25 before installation. The repository has moved from `badlogic/pi-mono` to `earendil-works/pi`, and the maintained npm scope is now `@earendil-works`. The latest release and registry version were both `0.84.3`. Both maintained packages require Node.js `>=22.19.0`. The old `@mariozechner/pi-agent-core` and `@mariozechner/pi-ai` packages are deprecated in favor of the new scope.

The current primary API is also different from older examples:

- `@earendil-works/pi-agent-core` exposes `Agent`, `AgentTool`, event subscriptions, and low-level agent loops.
- `@earendil-works/pi-ai` uses `createModels()` plus explicit provider factories; the resulting model collection supplies `streamSimple` to `Agent`.
- Tool arguments are validated before the `beforeToolCall` preflight hook. This hook may block execution, but DriveGuard's later deterministic Policy/Confirmation/Executor chain remains the authoritative side-effect boundary.
- Tool schemas use the maintained `typebox` package.

Official references:

- <https://github.com/earendil-works/pi/releases/tag/v0.84.3>
- <https://github.com/earendil-works/pi/tree/main/packages/agent>
- <https://github.com/earendil-works/pi/tree/main/packages/ai>
- <https://pi.dev/docs/latest>

## Decision

- Use npm 10 workspaces and commit `package-lock.json`.
- Require Node.js `>=22.19.0`.
- Pin `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `typebox` to the verified versions recorded in `package.json`.
- Use TypeScript strict mode, ESLint flat config, Prettier, and Vitest.
- Install Pi packages in Phase 0 but do not instantiate an Agent, configure a live provider, register tools, or execute an LLM request.

## Consequences

- Phase 1 and later work must use the maintained package scope and current provider-registration API.
- The DriveGuard policy and execution architecture is unchanged by the upstream rename or API evolution.
- Any future Pi upgrade requires current official-document verification and a new ADR.
