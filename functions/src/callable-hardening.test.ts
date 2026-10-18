import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpsError } from 'firebase-functions/v2/https';
import {
  validateEnum,
  validateInteger,
  validateNumber,
  validateOptionalString,
  validateString,
} from './validation';
import {
  requireAdminRole,
  requireVolunteerRole,
} from './moderation-helper';
import { evaluateIdVerificationDecisionPure } from './review-id-verification';
import { validateScheduledTime } from './update-scheduled-task';

// ------------------------------------------------------------------
// 1. INPUT VALIDATION HELPERS (BOUNDARY CHECKS)
// ------------------------------------------------------------------

test('validateString: accepts valid trimmed strings within bounds', () => {
  const result = validateString('  validTaskId123  ', 'taskId', 1, 100);
  assert.equal(result, 'validTaskId123');
});

test('validateString: rejects non-string types with invalid-argument', () => {
  assert.throws(
    () => validateString(12345, 'taskId', 1, 100),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateString(null, 'taskId', 1, 100),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateString(undefined, 'taskId', 1, 100),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateString({ id: 'abc' }, 'taskId', 1, 100),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
});

test('validateString: rejects empty or undersized strings', () => {
  assert.throws(
    () => validateString('', 'taskId', 1, 100),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateString('   ', 'taskId', 1, 100),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateString('ab', 'reason', 5, 100),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
});

test('validateString: rejects oversized strings', () => {
  const oversized = 'a'.repeat(101);
  assert.throws(
    () => validateString(oversized, 'taskId', 1, 100),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
});

test('validateOptionalString: handles missing vs valid vs oversized optional strings', () => {
  assert.equal(validateOptionalString(undefined, 'comment', 280), undefined);
  assert.equal(validateOptionalString(null, 'comment', 280), undefined);
  assert.equal(validateOptionalString('', 'comment', 280), undefined);
  assert.equal(validateOptionalString('   ', 'comment', 280), undefined);

  assert.equal(
    validateOptionalString(' Great job! ', 'comment', 280),
    'Great job!',
  );

  const oversized = 'x'.repeat(281);
  assert.throws(
    () => validateOptionalString(oversized, 'comment', 280),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
});

test('validateEnum: accepts permitted enum values and rejects unknown strings', () => {
  const allowed = ['warn', 'suspend', 'ban', 'dismiss'] as const;
  assert.equal(validateEnum('warn', 'action', allowed), 'warn');
  assert.equal(validateEnum('ban', 'action', allowed), 'ban');

  assert.throws(
    () => validateEnum('delete_account', 'action', allowed),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateEnum('', 'action', allowed),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateEnum(123, 'action', allowed),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
});

test('validateInteger: validates integers in range and rejects non-integers or out-of-range', () => {
  assert.equal(validateInteger(1, 'rating', 1, 5), 1);
  assert.equal(validateInteger(5, 'rating', 1, 5), 5);
  assert.equal(validateInteger(3, 'rating', 1, 5), 3);

  // Out of range
  assert.throws(
    () => validateInteger(0, 'rating', 1, 5),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateInteger(6, 'rating', 1, 5),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );

  // Floating point
  assert.throws(
    () => validateInteger(4.5, 'rating', 1, 5),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );

  // Non-number
  assert.throws(
    () => validateInteger('5', 'rating', 1, 5),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
});

test('validateNumber: validates numbers in range and rejects non-numeric/out-of-range', () => {
  assert.equal(validateNumber(14, 'durationDays', 1, 365), 14);
  assert.equal(validateNumber('30', 'durationDays', 1, 365), 30);

  assert.throws(
    () => validateNumber(0, 'durationDays', 1, 365),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateNumber(366, 'durationDays', 1, 365),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateNumber(NaN, 'durationDays', 1, 365),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
  assert.throws(
    () => validateNumber(Infinity, 'durationDays', 1, 365),
    (err: unknown) => err instanceof HttpsError && err.code === 'invalid-argument',
  );
});

// ------------------------------------------------------------------
// 2. AUTHORIZATION & ROLE ENFORCEMENT
// ------------------------------------------------------------------

test('requireVolunteerRole: allows users with volunteer role and rejects others', () => {
  // Volunteer only
  assert.doesNotThrow(() => requireVolunteerRole({ roles: ['volunteer'] }));

  // Dual-role user
  assert.doesNotThrow(() =>
    requireVolunteerRole({ roles: ['customer', 'volunteer'] }),
  );

  // Customer only
  assert.throws(
    () => requireVolunteerRole({ roles: ['customer'] }),
    (err: unknown) => err instanceof HttpsError && err.code === 'permission-denied',
  );

  // Missing or invalid roles field
  assert.throws(
    () => requireVolunteerRole({}),
    (err: unknown) => err instanceof HttpsError && err.code === 'permission-denied',
  );
  assert.throws(
    () => requireVolunteerRole({ roles: [] }),
    (err: unknown) => err instanceof HttpsError && err.code === 'permission-denied',
  );
  assert.throws(
    () => requireVolunteerRole({ roles: 'volunteer' }),
    (err: unknown) => err instanceof HttpsError && err.code === 'permission-denied',
  );
});

test('requireAdminRole: allows admin users and rejects non-admins', () => {
  assert.doesNotThrow(() => requireAdminRole({ isAdmin: true }));

  assert.throws(
    () => requireAdminRole({ isAdmin: false }),
    (err: unknown) => err instanceof HttpsError && err.code === 'permission-denied',
  );
  assert.throws(
    () => requireAdminRole({}),
    (err: unknown) => err instanceof HttpsError && err.code === 'permission-denied',
  );
  assert.throws(
    () => requireAdminRole({ isAdmin: 'true' }),
    (err: unknown) => err instanceof HttpsError && err.code === 'permission-denied',
  );
});

// ------------------------------------------------------------------
// 3. ADMIN SELF-ACTION & CONFLICT CHECKS
// ------------------------------------------------------------------

test('evaluateIdVerificationDecisionPure: prevents admin from verifying their own document', () => {
  const selfReview = evaluateIdVerificationDecisionPure({
    isAdmin: true,
    decision: 'approve',
    fileFound: true,
    adminUid: 'admin-123',
    targetUid: 'admin-123',
  });

  assert.equal(selfReview.allowed, false);
  assert.ok(
    selfReview.error?.includes('cannot verify their own ID'),
    `Expected self-verification error, got: ${selfReview.error}`,
  );
});

test('evaluateIdVerificationDecisionPure: allows admin reviewing another user', () => {
  const otherReview = evaluateIdVerificationDecisionPure({
    isAdmin: true,
    decision: 'approve',
    fileFound: true,
    adminUid: 'admin-123',
    targetUid: 'volunteer-456',
  });

  assert.equal(otherReview.allowed, true);
  assert.equal(otherReview.resultingStatus, 'verified');
  assert.equal(otherReview.idVerified, true);
});

// ------------------------------------------------------------------
// 4. SCHEDULED TASK TIME BOUNDARIES
// ------------------------------------------------------------------

test('validateScheduledTime: enforces minimum 30-minute lead time and 7-day maximum horizon', () => {
  const now = 1700000000000;

  // Too soon (<30m)
  const tooSoon = validateScheduledTime(now + 29 * 60 * 1000, now);
  assert.equal(tooSoon.valid, false);
  assert.ok(tooSoon.error?.includes('at least 30 minutes'));

  // Exactly minimum lead time (30m)
  const exactMin = validateScheduledTime(now + 30 * 60 * 1000, now);
  assert.equal(exactMin.valid, true);

  // Healthy future time (1 day)
  const oneDay = validateScheduledTime(now + 24 * 60 * 60 * 1000, now);
  assert.equal(oneDay.valid, true);

  // Exactly maximum horizon (7d)
  const exactMax = validateScheduledTime(now + 7 * 24 * 60 * 60 * 1000, now);
  assert.equal(exactMax.valid, true);

  // Beyond maximum horizon (>7d)
  const beyondMax = validateScheduledTime(
    now + (7 * 24 * 60 * 60 * 1000 + 1000),
    now,
  );
  assert.equal(beyondMax.valid, false);
  assert.ok(beyondMax.error?.includes('more than 7 days'));
});
