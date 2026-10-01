# Architecture

```text
admin credential -> tenant key registration
tenant key -> versioned DAG definition -> idempotent run creation
                                      -> one-step advance -> step state + events
                                                       |       |
                                                       +-> retry schedule
                                                       +-> tenant audit
```

## Scope and invariants

The API authenticates a tenant key before any workflow or run lookup. Tenant identity comes from that key rather than a request path. Keys are kept as SHA-256 digests in memory and can be rotated by the admin API. Workflow publication uses an expected version to reject concurrent stale updates; a run stores that version so later publications cannot change its execution plan. DAG validation rejects duplicate ids, missing dependencies, cycles, and output references that do not target transitive ancestors.

The scheduler advances at most one ready step per call. A step becomes ready only after all dependencies succeed. A failed attempt waits until its retry time if attempts remain; exhaustion marks the step failed and descendants blocked. Independent branches can still run, and the run finishes when every step reaches a terminal state. `Idempotency-Key` is scoped to tenant and workflow; a reused key returns the original run only for the same input fingerprint. Run events and the tenant audit provide step attempts, outcomes, and timestamps. Action inputs and outputs are visible in run state, so callers should not submit secrets.

## Tradeoffs and production path

The three actions are safe, deterministic local demonstrations. There is no arbitrary shell or HTTP execution, which keeps the example auditable. The engine is single-process and in-memory; it has no crash recovery or distributed leasing. Production would persist immutable definitions, runs, step transitions, idempotency records, and audit events transactionally. Workers would claim ready steps with leases and compare-and-swap transitions, use a durable delayed queue for retries, and enforce global and per-tenant concurrency limits. External effects need action-specific idempotency keys or an outbox to handle crashes between effect and acknowledgement. Add cancellation, timeouts, backoff with jitter, dead-letter handling, retention, and replay tools before using real integrations.

Use scoped operator identities and managed secret storage instead of the shared admin key. Rate-limit every principal, encrypt sensitive run payloads, redact secrets from events, and use a tenant-partitioned datastore with authorization checks in the query layer. Export structured logs, traces with run and step ids, queue lag, retry counts, failure rates, and per-tenant saturation metrics. The demo's in-memory audit is not a compliance log; production should send immutable records to a durable audit sink.
