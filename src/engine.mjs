import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

const idPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const keyPattern = /^[A-Za-z0-9._~-]{8,128}$/;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const reject = (status, message) => { throw new ApiError(status, message); };
const validId = value => typeof value === 'string' && idPattern.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkRefs(value, allowed) {
  if (Array.isArray(value)) return value.forEach(item => checkRefs(item, allowed));
  if (!plain(value)) return;
  if (own(value, '$ref')) {
    if (Object.keys(value).length !== 1 || typeof value.$ref !== 'string') reject(400, 'Invalid reference');
    const parts = value.$ref.split('.');
    if (parts.length < 2 || parts.some(part => !validId(part))) reject(400, 'Invalid reference path');
    if (parts[0] === 'input') return;
    if (parts[0] !== 'steps' || parts.length < 3 || !allowed.has(parts[1])) reject(400, 'Reference must target an ancestor step');
    return;
  }
  for (const item of Object.values(value)) checkRefs(item, allowed);
}

export function validateWorkflow(body) {
  if (!plain(body) || !Number.isInteger(body.expectedVersion) || body.expectedVersion < 0) reject(400, 'expectedVersion must be a nonnegative integer');
  if (!Array.isArray(body.steps) || body.steps.length < 1 || body.steps.length > 32) reject(400, 'steps must contain 1 to 32 items');
  const steps = new Map();
  for (const step of body.steps) {
    if (!plain(step) || !validId(step.id) || steps.has(step.id)) reject(400, 'Step ids must be unique lowercase identifiers');
    if (!Array.isArray(step.dependsOn) || new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(id => !validId(id) || id === step.id)) reject(400, 'Invalid dependencies');
    if (!['echo', 'sum', 'flaky'].includes(step.action)) reject(400, 'Unknown action');
    if (!plain(step.args)) reject(400, 'args must be an object');
    if (step.maxAttempts !== undefined && (!Number.isInteger(step.maxAttempts) || step.maxAttempts < 1 || step.maxAttempts > 5)) reject(400, 'maxAttempts must be 1 to 5');
    if (step.retryDelayMs !== undefined && (!Number.isInteger(step.retryDelayMs) || step.retryDelayMs < 0 || step.retryDelayMs > 60000)) reject(400, 'retryDelayMs must be 0 to 60000');
    steps.set(step.id, step);
  }
  const visited = new Set();
  const active = new Set();
  const ancestors = new Map();
  function visit(id) {
    if (active.has(id)) reject(400, 'Workflow contains a cycle');
    if (visited.has(id)) return ancestors.get(id);
    active.add(id);
    const found = new Set();
    for (const dependency of steps.get(id).dependsOn) {
      if (!steps.has(dependency)) reject(400, `Unknown dependency: ${dependency}`);
      found.add(dependency);
      for (const ancestor of visit(dependency)) found.add(ancestor);
    }
    active.delete(id);
    visited.add(id);
    ancestors.set(id, found);
    return found;
  }
  for (const id of steps.keys()) visit(id);
  for (const step of steps.values()) checkRefs(step.args, ancestors.get(step.id));
  return { steps: clone(body.steps.map(step => ({ ...step, maxAttempts: step.maxAttempts ?? 1, retryDelayMs: step.retryDelayMs ?? 0 }))) };
}

function resolve(value, context) {
  if (Array.isArray(value)) return value.map(item => resolve(item, context));
  if (!plain(value)) return value;
  if (own(value, '$ref')) {
    const [root, ...path] = value.$ref.split('.');
    let current = context[root];
    for (const part of path) {
      if (!plain(current) && !Array.isArray(current)) reject(422, `Reference is unavailable: ${value.$ref}`);
      if (!own(current, part)) reject(422, `Reference is unavailable: ${value.$ref}`);
      current = current[part];
    }
    return clone(current);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, context)]));
}

function execute(step, args, attempt) {
  if (step.action === 'echo') return args;
  if (step.action === 'sum') {
    if (!Array.isArray(args.values) || args.values.length > 100 || args.values.some(value => typeof value !== 'number' || !Number.isFinite(value))) reject(422, 'sum requires finite numeric values');
    return { total: args.values.reduce((sum, value) => sum + value, 0) };
  }
  if (!Number.isInteger(args.failuresBeforeSuccess) || args.failuresBeforeSuccess < 0 || args.failuresBeforeSuccess > 4) reject(422, 'flaky requires failuresBeforeSuccess from 0 to 4');
  if (attempt <= args.failuresBeforeSuccess) reject(503, 'Simulated transient failure');
  return { value: args.value ?? null, succeededOnAttempt: attempt };
}

export function createEngine({ now = () => Date.now() } = {}) {
  const tenants = new Map();
  const credentials = new Map();
  const runs = new Map();
  const idempotency = new Map();
  const audit = new Map();
  const stamp = () => new Date(now()).toISOString();
  const log = (tenant, type, details) => {
    const events = audit.get(tenant) ?? [];
    events.push({ at: stamp(), type, ...details });
    audit.set(tenant, events);
  };
  const requireTenant = tenant => { if (!validId(tenant)) reject(400, 'Invalid tenant id'); };
  const ownedRun = (tenant, id) => {
    const run = runs.get(id);
    if (!run || run.tenant !== tenant) reject(404, 'Run not found');
    return run;
  };
  function setCredential(tenant, key) {
    requireTenant(tenant);
    if (typeof key !== 'string' || !keyPattern.test(key)) reject(400, 'key must be 8 to 128 URL-safe characters');
    const digest = hash(key);
    for (const [other, existing] of credentials) if (other !== tenant && existing === digest) reject(409, 'Key already assigned');
    credentials.set(tenant, digest);
    if (!tenants.has(tenant)) tenants.set(tenant, new Map());
    log(tenant, 'credential.rotated', {});
    return { tenant };
  }
  function authenticate(key) {
    if (typeof key !== 'string') reject(401, 'Tenant token required');
    const supplied = Buffer.from(hash(key), 'hex');
    for (const [tenant, digest] of credentials) {
      if (timingSafeEqual(supplied, Buffer.from(digest, 'hex'))) return tenant;
    }
    reject(401, 'Invalid tenant token');
  }
  function publish(tenant, id, body) {
    requireTenant(tenant);
    if (!validId(id)) reject(400, 'Invalid workflow id');
    const definition = validateWorkflow(body);
    const workflows = tenants.get(tenant) ?? new Map();
    const history = workflows.get(id) ?? [];
    if (body.expectedVersion !== history.length) reject(409, 'Workflow version conflict');
    const version = history.length + 1;
    history.push({ id, version, ...definition });
    workflows.set(id, history);
    tenants.set(tenant, workflows);
    log(tenant, 'workflow.published', { workflowId: id, version });
    return { id, version, steps: clone(definition.steps) };
  }
  function getWorkflow(tenant, id) {
    const history = tenants.get(tenant)?.get(id);
    if (!history) reject(404, 'Workflow not found');
    return clone(history.at(-1));
  }
  function start(tenant, workflowId, input, key) {
    if (!validId(workflowId)) reject(400, 'Invalid workflow id');
    if (!plain(input)) reject(400, 'input must be an object');
    if (typeof key !== 'string' || !keyPattern.test(key)) reject(400, 'Idempotency-Key must be 8 to 128 URL-safe characters');
    const workflow = getWorkflow(tenant, workflowId);
    const scope = `${tenant}\0${workflowId}\0${key}`;
    const fingerprint = hash(JSON.stringify(input));
    const prior = idempotency.get(scope);
    if (prior) {
      if (prior.fingerprint !== fingerprint) reject(409, 'Idempotency key reused with different input');
      return { run: clone(runs.get(prior.runId)), replayed: true };
    }
    const run = {
      id: randomUUID(), tenant, workflowId, version: workflow.version,
      input: clone(input), status: 'running', createdAt: stamp(), completedAt: null,
      steps: Object.fromEntries(workflow.steps.map(step => [step.id, { status: 'pending', attempts: 0, nextAttemptAt: null, output: null, error: null }])),
      events: []
    };
    runs.set(run.id, run);
    idempotency.set(scope, { fingerprint, runId: run.id });
    log(tenant, 'run.started', { runId: run.id, workflowId, version: run.version });
    return { run: clone(run), replayed: false };
  }
  function advance(tenant, id) {
    const run = ownedRun(tenant, id);
    if (run.status !== 'running') return clone(run);
    const workflow = tenants.get(tenant).get(run.workflowId)[run.version - 1];
    const event = (stepId, type, details = {}) => {
      const item = { at: stamp(), stepId, type, ...details };
      run.events.push(item);
      log(tenant, `step.${type}`, { runId: run.id, stepId, ...details });
    };
    // Propagate failure before scheduling another step.
    for (const step of workflow.steps) {
      const state = run.steps[step.id];
      if (state.status === 'pending' && step.dependsOn.some(dep => ['failed', 'blocked'].includes(run.steps[dep].status))) {
        state.status = 'blocked';
        event(step.id, 'blocked');
      }
    }
    const ready = workflow.steps.find(step => {
      const state = run.steps[step.id];
      return ['pending', 'waiting'].includes(state.status)
        && (state.nextAttemptAt === null || state.nextAttemptAt <= now())
        && step.dependsOn.every(dep => run.steps[dep].status === 'succeeded');
    });
    if (ready) {
      const state = run.steps[ready.id];
      state.attempts += 1;
      state.status = 'running';
      state.nextAttemptAt = null;
      event(ready.id, 'started', { attempt: state.attempts });
      try {
        const outputs = Object.fromEntries(Object.entries(run.steps).filter(([, item]) => item.status === 'succeeded').map(([name, item]) => [name, item.output]));
        const args = resolve(ready.args, { input: run.input, steps: outputs });
        state.output = clone(execute(ready, args, state.attempts));
        state.status = 'succeeded';
        state.error = null;
        event(ready.id, 'succeeded', { attempt: state.attempts });
      } catch (error) {
        state.error = error instanceof ApiError ? error.message : 'Action failed';
        state.status = state.attempts < ready.maxAttempts ? 'waiting' : 'failed';
        if (state.status === 'waiting') state.nextAttemptAt = now() + ready.retryDelayMs;
        event(ready.id, state.status, { attempt: state.attempts, error: state.error });
      }
    }
    // Continue failure propagation even when the last attempt just failed.
    for (const step of workflow.steps) {
      const state = run.steps[step.id];
      if (state.status === 'pending' && step.dependsOn.some(dep => ['failed', 'blocked'].includes(run.steps[dep].status))) {
        state.status = 'blocked';
        event(step.id, 'blocked');
      }
    }
    const statuses = Object.values(run.steps).map(step => step.status);
    if (statuses.every(status => status === 'succeeded')) run.status = 'succeeded';
    else if (statuses.every(status => ['succeeded', 'failed', 'blocked'].includes(status))) run.status = 'failed';
    if (run.status !== 'running') {
      run.completedAt = stamp();
      log(tenant, 'run.completed', { runId: run.id, status: run.status });
    }
    return clone(run);
  }
  return {
    setCredential, authenticate, publish, getWorkflow, start, advance,
    getRun: (tenant, id) => clone(ownedRun(tenant, id)),
    getAudit: tenant => clone(audit.get(tenant) ?? [])
  };
}
