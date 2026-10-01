import { randomUUID } from 'node:crypto';

const base = process.env.ORCHESTRATOR_URL ?? 'http://localhost:3008';
const admin = process.env.ORCHESTRATOR_ADMIN_KEY ?? 'local-admin';
const tenantKey = 'demo-tenant-key-2026';
const workflowId = `order_${randomUUID().slice(0, 8)}`;

async function call(method, path, token, payload, extra = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
    body: payload === undefined ? undefined : JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
}

await call('PUT', '/admin/tenants/demo/credential', admin, { key: tenantKey });
const workflow = await call('PUT', `/v1/workflows/${workflowId}`, tenantKey, {
  expectedVersion: 0,
  steps: [
    { id: 'validate', dependsOn: [], action: 'echo', args: { order: { '$ref': 'input.order' } } },
    { id: 'charge', dependsOn: ['validate'], action: 'flaky', args: { failuresBeforeSuccess: 1, value: { '$ref': 'steps.validate.order' } }, maxAttempts: 2, retryDelayMs: 0 },
    { id: 'receipt', dependsOn: ['charge'], action: 'sum', args: { values: [{ '$ref': 'input.subtotal' }, { '$ref': 'input.tax' }] } }
  ]
});
const key = `order-${randomUUID()}`;
const first = await call('POST', `/v1/workflows/${workflowId}/runs`, tenantKey, { input: { order: 'A-104', subtotal: 42, tax: 8 } }, { 'idempotency-key': key });
const replay = await call('POST', `/v1/workflows/${workflowId}/runs`, tenantKey, { input: { order: 'A-104', subtotal: 42, tax: 8 } }, { 'idempotency-key': key });
if (!replay.replayed || replay.run.id !== first.run.id) throw Error('Idempotency replay failed');
let run = first.run;
for (let i = 0; i < 10 && run.status === 'running'; i++) run = await call('POST', `/v1/runs/${run.id}/advance`, tenantKey);
if (run.status !== 'succeeded') throw Error(`Run ended in ${run.status}`);
const audit = await call('GET', '/v1/audit', tenantKey);
console.log(JSON.stringify({ workflow: workflowId, version: workflow.version, runId: run.id, status: run.status, chargeAttempts: run.steps.charge.attempts, total: run.steps.receipt.output.total, auditEvents: audit.events.length }, null, 2));
