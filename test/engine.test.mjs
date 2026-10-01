import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngine } from '../src/engine.mjs';

const step = (id, dependsOn = [], action = 'echo', args = {}) => ({ id, dependsOn, action, args });
const publish = (engine, tenant, id, steps, expectedVersion = 0) => engine.publish(tenant, id, { expectedVersion, steps });

test('rejects cycles, unknown dependencies, and references outside ancestor chain', () => {
  const engine = createEngine();
  assert.throws(() => publish(engine, 'acme', 'bad', [step('a', ['b']), step('b', ['a'])]), /cycle/);
  assert.throws(() => publish(engine, 'acme', 'bad', [step('a', ['missing'])]), /Unknown dependency/);
  assert.throws(() => publish(engine, 'acme', 'bad', [step('a'), step('b', [], 'echo', { x: { '$ref': 'steps.a.x' } })]), /ancestor/);
  assert.throws(() => publish(engine, 'acme', 'bad', [step('a'), step('a')]), /unique/);
});

test('pins versions, replays idempotent start, retries, and resolves ancestor output', () => {
  let time = 0;
  const engine = createEngine({ now: () => time });
  engine.setCredential('acme', 'acme-secret-123');
  publish(engine, 'acme', 'orders', [
    step('first', [], 'echo', { value: { '$ref': 'input.value' } }),
    { ...step('retry', ['first'], 'flaky', { failuresBeforeSuccess: 1, value: { '$ref': 'steps.first.value' } }), maxAttempts: 2, retryDelayMs: 10 }
  ]);
  const first = engine.start('acme', 'orders', { value: 7 }, 'request-0001');
  assert.equal(first.replayed, false);
  assert.equal(engine.start('acme', 'orders', { value: 7 }, 'request-0001').run.id, first.run.id);
  assert.throws(() => engine.start('acme', 'orders', { value: 8 }, 'request-0001'), /different input/);
  publish(engine, 'acme', 'orders', [step('replacement')], 1);
  let run = engine.advance('acme', first.run.id);
  assert.equal(run.steps.first.status, 'succeeded');
  run = engine.advance('acme', first.run.id);
  assert.equal(run.steps.retry.status, 'waiting');
  assert.equal(engine.advance('acme', first.run.id).steps.retry.attempts, 1);
  time = 10;
  run = engine.advance('acme', first.run.id);
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.steps.retry.output, { value: 7, succeededOnAttempt: 2 });
  assert.equal(run.version, 1);
});

test('isolates tenants and blocks descendants after exhausted attempts', () => {
  const engine = createEngine();
  engine.setCredential('alpha', 'alpha-secret-123');
  engine.setCredential('beta', 'beta-secret-1234');
  assert.equal(engine.authenticate('beta-secret-1234'), 'beta');
  assert.throws(() => engine.authenticate('wrong-secret'), /Invalid tenant/);
  publish(engine, 'alpha', 'flow', [
    { ...step('fail', [], 'flaky', { failuresBeforeSuccess: 2 }), maxAttempts: 1 },
    step('dependent', ['fail'])
  ]);
  const { run } = engine.start('alpha', 'flow', {}, 'request-0002');
  assert.throws(() => engine.getRun('beta', run.id), /not found/);
  assert.throws(() => engine.getWorkflow('beta', 'flow'), /not found/);
  const done = engine.advance('alpha', run.id);
  assert.equal(done.status, 'failed');
  assert.equal(done.steps.dependent.status, 'blocked');
  assert.equal(engine.getAudit('beta').length, 1);
});
