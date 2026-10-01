# FDE Project 08: Workflow Orchestrator

A dependency-free local API for publishing tenant-owned directed acyclic workflows and advancing durable-shaped runs one step at a time. A run pins its workflow version, resolves values from its input and ancestor outputs, retries transient work, and records an inspectable event trail.

## Run

Requires Node.js 20 or later. In PowerShell:

```powershell
$env:ORCHESTRATOR_ADMIN_KEY = 'local-admin'
npm start
```

The service listens on `http://localhost:3008` by default (`PORT` overrides it). In another terminal:

```powershell
npm run demo
npm test
```

The demo uses the default local admin key. It configures a tenant, publishes an order workflow, starts a run twice with one idempotency key, advances it through a simulated transient failure, and prints the final total and audit count.

## API

`PUT /admin/tenants/:tenant/credential` requires `Authorization: Bearer <ORCHESTRATOR_ADMIN_KEY>` and body `{ "key": "a-long-tenant-key" }`. All `/v1` routes require that tenant key; the key determines tenant identity. `GET /health` is public.

| Method | Route | Purpose |
| --- | --- | --- |
| `PUT` | `/v1/workflows/:id` | Publish a new immutable version with `expectedVersion` |
| `GET` | `/v1/workflows/:id` | Read the latest definition |
| `POST` | `/v1/workflows/:id/runs` | Start a run with `{ "input": {...} }` and `Idempotency-Key` |
| `GET` | `/v1/runs/:id` | Read run state and step events |
| `POST` | `/v1/runs/:id/advance` | Execute at most one ready step |
| `GET` | `/v1/audit` | Read tenant audit events |

Example workflow body:

```json
{
  "expectedVersion": 0,
  "steps": [
    { "id": "accept", "dependsOn": [], "action": "echo", "args": { "order": { "$ref": "input.order" } } },
    { "id": "total", "dependsOn": ["accept"], "action": "sum", "args": { "values": [12, 3] } }
  ]
}
```

Steps use `echo`, `sum`, or `flaky`. `flaky` accepts `failuresBeforeSuccess` and `value` to demonstrate retries. Each step can set `maxAttempts` (1–5) and `retryDelayMs` (0–60000). A reference may read `input.<field>` or `steps.<ancestorId>.<outputField>`. Failed dependencies block descendants; unrelated branches may still complete. `advance` may return the same run while a retry delay is pending.

This is an in-memory reference implementation. Definitions, runs, keys, and audit events disappear on restart. The local default admin key is for the demo only. See [ARCHITECTURE.md](ARCHITECTURE.md) for safety boundaries and the production upgrade path.
