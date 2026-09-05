# Tool Routing Design

Status: **Stage D/E local gates PASS**

The routing boundary distinguishes no-tool, read, write, mixed, and ambiguous intents, shortlists
candidate Tools from the already capability-resolved Registry, and supplies a trusted per-turn goal
contract to the model. It cannot add a Tool that capability resolution removed, and the RX denylist
remains enforced before routing.

## Planning rules

- explicit no-tool and direct-actuator requests expose no Agent Tool;
- recognized goals expose only the minimum candidate set;
- multi-goal requests expose the union of required candidates;
- a genuinely ambiguous request retains the capability-resolved set for model clarification;
- the prompt contract requires one call per required goal and a stop as soon as the goal is met;
- protected R2/R3 intents are directed to the formal Tool call so deterministic Policy and trusted
  confirmation run; natural-language confirmation is not a substitute.

## Explicit argument binding

Before schema validation, a deterministic binder uses only values explicit in the current user
request to canonicalize destination, station ID, cabin temperature, seat/level, media volume, and
known assistance reason. If the request does not contain a value, the binder does not invent one
and leaves the model proposal for normal schema validation. Policy and confirmation therefore see
the same validated arguments that the executor later consumes.

## Measured gates

Frozen V2 source corpus:

- total cases: 600
- Agent Runtime cases: 565
- independently handled Urgent Processor cases: 35
- exact candidate plans: 565/565 (100%)
- candidate Tool recall: 100%
- candidate Tool precision: 100%
- explicit argument contracts checked: 548
- explicit argument validity: 548/548 (100%)
- direct RX actuator exposure: 0

The deterministic Policy matrix was rerun after routing integration: 10,000 cases / 20,000
evaluations, 7,335/7,335 critical decisions correct, zero decision mismatch, zero rule mismatch,
and zero nondeterminism.

These local gates validate routing, binding, and Policy independently of provider behavior. They do
not replace the frozen live Native benchmark.
