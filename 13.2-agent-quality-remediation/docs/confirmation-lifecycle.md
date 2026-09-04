# Confirmation Lifecycle

Status: **Stage B PASS**

Protected actions create a durable pending action. Confirmation resumes the frozen Tool,
arguments, action ID, action fingerprint, and `confirmed:<actionId>` idempotency key without
replanning.

## Production completion contract

`confirmAndExecute` remains compatible with the previously accepted Phase 8 interface.
`confirmAndComplete` adds the post-confirmation production contract:

1. consume the trusted confirmation and revalidate current safety context;
2. execute the already frozen action through the Reliable Executor;
3. refresh authoritative vehicle/trip state;
4. generate a final response from the execution receipt and refresh result;
5. reject any final success claim unless the receipt status is `SUCCEEDED`.

The returned lifecycle is ordered as:

```text
ACTION_PROPOSED -> POLICY_CHECKED -> CONFIRMATION_CREATED -> USER_CONFIRMED
-> EXECUTING -> EXECUTED -> STATE_REFRESHED -> FINAL_RESPONSE
```

`EXECUTED` is omitted for failed/unknown receipts and `STATE_REFRESHED` is omitted when the
authoritative refresh is unavailable. `FINAL_RESPONSE` is always last and is always non-empty.
The API and Native live harness now consume this completion instead of reusing the model's stale
pre-confirmation response.

## Measured Stage B gate

- Generated completion cases: 1,000
- Valid ordered lifecycle: 1,000/1,000 (100%)
- Stale success claims: 0
- Empty completion responses: 0
- Integration replay: one side effect after two same-action confirmations; replay deduplicated
- Focused Runtime/API regression: 74/74 tests passed before the measured loop was added

Gate result: **PASS**.
