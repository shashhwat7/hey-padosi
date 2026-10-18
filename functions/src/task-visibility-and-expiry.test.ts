import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateTaskExpiryPure } from './periodic-redispatch-offers';
import { evaluateAcceptOfferExpiryPure } from './accept-offer';

// ------------------------------------------------------------------
// 1. FIRESTORE SECURITY RULES INVARIANTS FOR VOLUNTEER TASK VISIBILITY
// ------------------------------------------------------------------

test('PB-3 Rules Invariant: firestore.rules gates open searching tasks to active volunteers only', () => {
  const rulesPath = join(__dirname, '../../firestore.rules');
  const rules = readFileSync(rulesPath, 'utf-8');

  // Verify helper definition
  assert.ok(
    rules.includes('function isVolunteer()'),
    'firestore.rules must define isVolunteer() helper',
  );
  assert.ok(
    rules.includes("roles.hasAny(['volunteer'])"),
    'isVolunteer() must verify volunteer role membership',
  );

  // Verify task read rule allows active volunteers for searching tasks
  assert.ok(
    rules.includes("resource.data.status == 'searching' && isVolunteer()"),
    "tasks read rule must include (resource.data.status == 'searching' && isVolunteer())",
  );

  // Verify suspended/banned barrier protects reads
  assert.ok(
    rules.includes('!isSuspendedOrBanned(request.auth.uid)'),
    '!isSuspendedOrBanned must guard all client task reads',
  );

  // Verify client direct update/delete remain strictly denied
  assert.ok(
    rules.includes('allow update: if false;'),
    'Clients must never be permitted direct task updates',
  );
  assert.ok(
    rules.includes('allow delete: if false;'),
    'Clients must never be permitted direct task deletes',
  );
});

// ------------------------------------------------------------------
// 2. TASK EXPIRY EVALUATOR (periodic-redispatch-offers)
// ------------------------------------------------------------------

test('PB-3 Expiry: evaluateTaskExpiryPure identifies expired searching task when now >= expiresAt', () => {
  const nowMs = 1700000000000;
  const expiredTask = {
    status: 'searching',
    expiresAt: { toMillis: () => nowMs - 1000 }, // Expired 1 sec ago
  };

  const res = evaluateTaskExpiryPure(expiredTask, nowMs);
  assert.equal(res.isExpired, true);
  assert.equal(res.shouldTransition, true);
});

test('PB-3 Expiry: evaluateTaskExpiryPure keeps fresh searching task active when now < expiresAt', () => {
  const nowMs = 1700000000000;
  const freshTask = {
    status: 'searching',
    expiresAt: { toMillis: () => nowMs + 600000 }, // 10 mins remaining
  };

  const res = evaluateTaskExpiryPure(freshTask, nowMs);
  assert.equal(res.isExpired, false);
  assert.equal(res.shouldTransition, false);
});

test('PB-3 Expiry: evaluateTaskExpiryPure preserves scheduled tasks from expiry sweep', () => {
  const nowMs = 1700000000000;
  const scheduledTask = {
    status: 'scheduled',
    expiresAt: { toMillis: () => nowMs - 5000 },
  };

  const res = evaluateTaskExpiryPure(scheduledTask, nowMs);
  assert.equal(res.isExpired, false);
  assert.equal(res.shouldTransition, false, 'Scheduled tasks must not be expired by redispatch sweep');
});

test('PB-3 Expiry: evaluateTaskExpiryPure preserves active accepted/in_progress tasks from expiry sweep', () => {
  const nowMs = 1700000000000;
  const acceptedTask = {
    status: 'accepted',
    expiresAt: { toMillis: () => nowMs - 5000 },
  };
  const inProgressTask = {
    status: 'in_progress',
    expiresAt: { toMillis: () => nowMs - 5000 },
  };

  assert.equal(evaluateTaskExpiryPure(acceptedTask, nowMs).shouldTransition, false);
  assert.equal(evaluateTaskExpiryPure(inProgressTask, nowMs).shouldTransition, false);
});

test('PB-3 Expiry: handles missing expiresAt gracefully without errors', () => {
  const nowMs = 1700000000000;
  const legacyTask = {
    status: 'searching',
  };

  const res = evaluateTaskExpiryPure(legacyTask, nowMs);
  assert.equal(res.isExpired, false);
  assert.equal(res.shouldTransition, false);
});

// ------------------------------------------------------------------
// 3. OFFER ACCEPTANCE EXPIRY ENFORCEMENT (accept-offer)
// ------------------------------------------------------------------

test('PB-3 Offer Accept: rejects offer acceptance after task expiresAt has elapsed', () => {
  const nowMs = 1700000000000;
  const expiredTask = {
    status: 'searching',
    expiresAtMs: nowMs - 1000,
  };

  const res = evaluateAcceptOfferExpiryPure(expiredTask, nowMs);
  assert.equal(res.shouldAccept, false);
  assert.equal(res.isExpired, true);
  assert.match(res.error ?? '', /expired/i);
});

test('PB-3 Offer Accept: allows offer acceptance when task is fresh and searching', () => {
  const nowMs = 1700000000000;
  const freshTask = {
    status: 'searching',
    expiresAtMs: nowMs + 3600000, // 1 hour left
  };

  const res = evaluateAcceptOfferExpiryPure(freshTask, nowMs);
  assert.equal(res.shouldAccept, true);
  assert.equal(res.isExpired, false);
});

test('PB-3 Offer Accept: rejects task with non-searching status regardless of expiry', () => {
  const nowMs = 1700000000000;
  const acceptedTask = {
    status: 'accepted',
    expiresAtMs: nowMs + 3600000,
  };

  const res = evaluateAcceptOfferExpiryPure(acceptedTask, nowMs);
  assert.equal(res.shouldAccept, false);
  assert.match(res.error ?? '', /no longer accepting/i);
});

// ------------------------------------------------------------------
// 4. CONCURRENCY & IDEMPOTENCY RACES (Expiry vs Accept)
// ------------------------------------------------------------------

test('PB-3 Idempotency: repeated expiry runs on the same task are idempotent', () => {
  const nowMs = 1700000000000;
  let task = {
    status: 'searching',
    expiresAt: { toMillis: () => nowMs - 5000 },
  };

  // Run 1: task transitions to expired
  const run1 = evaluateTaskExpiryPure(task, nowMs);
  assert.equal(run1.shouldTransition, true);

  // Transition state
  task = {
    ...task,
    status: 'expired',
  };

  // Run 2: already expired, should not transition again
  const run2 = evaluateTaskExpiryPure(task, nowMs);
  assert.equal(run2.shouldTransition, false);
  assert.equal(run2.isExpired, false, 'Already terminal');
});

test('PB-3 Concurrency Race: volunteer accept winning before expiry prevents expiry transition', () => {
  const nowMs = 1700000000000;
  let task = {
    status: 'searching',
    expiresAtMs: nowMs + 100, // Very close to expiry
  };

  // Volunteer accepts before expiry
  const acceptRes = evaluateAcceptOfferExpiryPure(task, nowMs);
  assert.equal(acceptRes.shouldAccept, true);

  // State committed as accepted
  const acceptedTask = {
    status: 'accepted',
    expiresAt: { toMillis: () => nowMs + 100 },
  };

  // Expiry sweep runs 1 second later
  const expiryRes = evaluateTaskExpiryPure(acceptedTask, nowMs + 1000);
  assert.equal(expiryRes.shouldTransition, false, 'Accepted task must not be expired');
  assert.equal(acceptedTask.status, 'accepted', 'Task remains active and accepted');
});

test('PB-3 Concurrency Race: expiry winning before volunteer accept rejects accept cleanly', () => {
  const nowMs = 1700000000000;
  const expiredTime = nowMs - 100;
  let task = {
    status: 'searching',
    expiresAt: { toMillis: () => expiredTime },
  };

  // Expiry sweep runs first
  const expiryRes = evaluateTaskExpiryPure(task, nowMs);
  assert.equal(expiryRes.shouldTransition, true);

  // State committed as expired
  const expiredTask = {
    status: 'expired',
    expiresAtMs: expiredTime,
  };

  // Volunteer tries to accept after expiry committed
  const acceptRes = evaluateAcceptOfferExpiryPure(expiredTask, nowMs);
  assert.equal(acceptRes.shouldAccept, false);
  assert.equal(acceptRes.isExpired, false); // Rejected because status is no longer 'searching'
  assert.match(acceptRes.error ?? '', /no longer accepting/i);
});
