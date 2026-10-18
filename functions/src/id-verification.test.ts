import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateIdVerificationDecisionPure } from './review-id-verification';
import { isEligible, type TaskDoc, type UserDoc } from './scoring';

// ------------------------------------------------------------------
// 1. ADMIN AUTHORIZATION & DECISION SAFETY (evaluateIdVerificationDecisionPure)
// ------------------------------------------------------------------

test('evaluateIdVerificationDecisionPure: rejects non-admin users', () => {
  const res = evaluateIdVerificationDecisionPure({
    isAdmin: false,
    decision: 'approve',
    fileFound: true,
  });

  assert.equal(res.allowed, false);
  assert.ok(
    res.error?.includes('Only administrators'),
    `Expected admin error, got: ${res.error}`,
  );
  assert.equal(res.resultingStatus, undefined);
  assert.equal(res.idVerified, undefined);
});

test('evaluateIdVerificationDecisionPure: prevents approving when document does not exist in storage', () => {
  const res = evaluateIdVerificationDecisionPure({
    isAdmin: true,
    decision: 'approve',
    fileFound: false,
  });

  assert.equal(res.allowed, false);
  assert.ok(
    res.error?.includes('Cannot approve ID verification: document does not exist'),
    `Expected missing document error, got: ${res.error}`,
  );
  assert.equal(res.resultingStatus, undefined);
  assert.equal(res.idVerified, undefined);
});

test('evaluateIdVerificationDecisionPure: allows approve when admin and file exists', () => {
  const res = evaluateIdVerificationDecisionPure({
    isAdmin: true,
    decision: 'approve',
    fileFound: true,
  });

  assert.equal(res.allowed, true);
  assert.equal(res.resultingStatus, 'verified');
  assert.equal(res.idVerified, true);
  assert.equal(res.error, undefined);
});

test('evaluateIdVerificationDecisionPure: requires a valid rejection reason (at least 5 characters)', () => {
  const missingReason = evaluateIdVerificationDecisionPure({
    isAdmin: true,
    decision: 'reject',
    fileFound: true,
    rejectionReason: '',
  });
  assert.equal(missingReason.allowed, false);
  assert.ok(
    missingReason.error?.includes('at least 5 characters'),
    `Expected reason validation error, got: ${missingReason.error}`,
  );

  const shortReason = evaluateIdVerificationDecisionPure({
    isAdmin: true,
    decision: 'reject',
    fileFound: true,
    rejectionReason: 'blur',
  });
  assert.equal(shortReason.allowed, false);
  assert.ok(
    shortReason.error?.includes('at least 5 characters'),
    `Expected reason validation error, got: ${shortReason.error}`,
  );

  const validReason = evaluateIdVerificationDecisionPure({
    isAdmin: true,
    decision: 'reject',
    fileFound: true,
    rejectionReason: 'Document image is blurred and unreadable',
  });
  assert.equal(validReason.allowed, true);
  assert.equal(validReason.resultingStatus, 'rejected');
  assert.equal(validReason.idVerified, false);
});

test('evaluateIdVerificationDecisionPure: supports repeat and consecutive decisions safely', () => {
  // Scenario 1: Previously rejected user is re-reviewed with valid document and approved
  const reApproved = evaluateIdVerificationDecisionPure({
    isAdmin: true,
    decision: 'approve',
    fileFound: true,
  });
  assert.equal(reApproved.allowed, true);
  assert.equal(reApproved.resultingStatus, 'verified');
  assert.equal(reApproved.idVerified, true);

  // Scenario 2: Admin revokes/rejects an already verified user if fraud is discovered
  const revoked = evaluateIdVerificationDecisionPure({
    isAdmin: true,
    decision: 'reject',
    fileFound: true,
    rejectionReason: 'Expired document provided; revocation necessary',
  });
  assert.equal(revoked.allowed, true);
  assert.equal(revoked.resultingStatus, 'rejected');
  assert.equal(revoked.idVerified, false);
});

// ------------------------------------------------------------------
// 2. TASK ELIGIBILITY & RISK ENFORCEMENT (scoring.ts isEligible)
// ------------------------------------------------------------------

const baseMediumRiskTask: TaskDoc = {
  customerId: 'cust-100',
  category: 'home-repairs',
  title: 'Fix electrical outlet',
  requiredSkills: ['home-repairs'],
  location: { lat: 13.0202, lng: 77.6815, h3Cell: '89618926487ffff' },
  riskLevel: 'medium',
  searchRadiusM: 2000,
  status: 'searching',
};

const baseLowRiskTask: TaskDoc = {
  customerId: 'cust-100',
  category: 'gardening',
  title: 'Water plants',
  requiredSkills: ['gardening'],
  location: { lat: 13.0202, lng: 77.6815, h3Cell: '89618926487ffff' },
  riskLevel: 'low',
  searchRadiusM: 2000,
  status: 'searching',
};

const baseVolunteerUser: UserDoc = {
  accountStatus: 'active',
  roles: ['volunteer'],
  skills: ['home-repairs', 'gardening'],
  availableNow: true,
  lastKnownLocation: { lat: 13.0202, lng: 77.6815, h3Cell: '89618926487ffff' },
  trustScore: 70,
  verifiedTaskCount: 2,
};

test('isEligible: ID upload alone does NOT verify a user or grant medium-risk eligibility', () => {
  // User uploaded document, status is pending, but idVerified is false/undefined
  const pendingUser: UserDoc = {
    ...baseVolunteerUser,
    idImagePath: 'users/vol-1/id-image',
    idVerificationStatus: 'pending',
    idVerified: false,
  };

  const eligibleForMedium = isEligible('vol-1', pendingUser, baseMediumRiskTask);
  assert.equal(
    eligibleForMedium,
    false,
    'Pending verification user must NOT be eligible for medium-risk tasks',
  );

  const eligibleForLow = isEligible('vol-1', pendingUser, baseLowRiskTask);
  assert.equal(
    eligibleForLow,
    true,
    'Pending verification user MUST remain eligible for low-risk tasks',
  );
});

test('isEligible: approved (idVerified === true) user satisfies medium-risk and low-risk checks', () => {
  const verifiedUser: UserDoc = {
    ...baseVolunteerUser,
    idImagePath: 'users/vol-2/id-image',
    idVerificationStatus: 'verified',
    idVerified: true,
  };

  const eligibleForMedium = isEligible('vol-2', verifiedUser, baseMediumRiskTask);
  assert.equal(
    eligibleForMedium,
    true,
    'Verified user must be eligible for medium-risk tasks',
  );

  const eligibleForLow = isEligible('vol-2', verifiedUser, baseLowRiskTask);
  assert.equal(
    eligibleForLow,
    true,
    'Verified user must be eligible for low-risk tasks',
  );
});

test('isEligible: rejected user does NOT satisfy medium-risk check but can access low-risk tasks', () => {
  const rejectedUser: UserDoc = {
    ...baseVolunteerUser,
    idImagePath: 'users/vol-3/id-image',
    idVerificationStatus: 'rejected',
    idVerified: false,
  };

  const eligibleForMedium = isEligible('vol-3', rejectedUser, baseMediumRiskTask);
  assert.equal(
    eligibleForMedium,
    false,
    'Rejected user must NOT be eligible for medium-risk tasks',
  );

  const eligibleForLow = isEligible('vol-3', rejectedUser, baseLowRiskTask);
  assert.equal(
    eligibleForLow,
    true,
    'Rejected user must still have access to low-risk tasks',
  );
});

test('isEligible: unverified user with no ID upload has low-risk access, no medium-risk access', () => {
  const unverifiedUser: UserDoc = {
    ...baseVolunteerUser,
    idVerified: false,
  };

  assert.equal(
    isEligible('vol-4', unverifiedUser, baseMediumRiskTask),
    false,
    'Unverified user cannot take medium-risk tasks',
  );
  assert.equal(
    isEligible('vol-4', unverifiedUser, baseLowRiskTask),
    true,
    'Unverified user can take low-risk tasks',
  );
});

// ------------------------------------------------------------------
// 3. FIRESTORE & STORAGE SECURITY RULES INVARIANTS
// ------------------------------------------------------------------

test('Security Rules: firestore.rules prevents client tampering with ID verification fields', () => {
  const rulesPath = join(__dirname, '../../firestore.rules');
  const rules = readFileSync(rulesPath, 'utf-8');

  // Verify server-only keys include idVerified and idVerificationStatus
  assert.ok(
    rules.includes("'idVerified'"),
    "userServerOnlyKeys must contain 'idVerified'",
  );
  assert.ok(
    rules.includes("'idVerificationStatus'"),
    "userServerOnlyKeys must contain 'idVerificationStatus'",
  );
  assert.ok(
    rules.includes("'idVerificationReviewedAt'"),
    "userServerOnlyKeys must contain 'idVerificationReviewedAt'",
  );
  assert.ok(
    rules.includes("'idVerificationReviewedBy'"),
    "userServerOnlyKeys must contain 'idVerificationReviewedBy'",
  );

  // Verify client userUpdateAllowedKeys does NOT permit updating verification fields
  // Extract userUpdateAllowedKeys list
  const match = rules.match(/function userUpdateAllowedKeys\(\)\s*\{[^}]*\}/);
  assert.ok(match, 'userUpdateAllowedKeys function must exist');
  const updateKeysBody = match[0];
  assert.ok(
    !updateKeysBody.includes("'idVerified'"),
    "userUpdateAllowedKeys must NOT include 'idVerified'",
  );
  assert.ok(
    !updateKeysBody.includes("'idVerificationStatus'"),
    "userUpdateAllowedKeys must NOT include 'idVerificationStatus'",
  );
  assert.ok(
    !updateKeysBody.includes("'idVerificationReviewedAt'"),
    "userUpdateAllowedKeys must NOT include 'idVerificationReviewedAt'",
  );
  assert.ok(
    !updateKeysBody.includes("'idVerificationReviewedBy'"),
    "userUpdateAllowedKeys must NOT include 'idVerificationReviewedBy'",
  );
});

test('Security Rules: storage.rules strictly forbids direct client reads of ID images', () => {
  const storageRulesPath = join(__dirname, '../../storage.rules');
  const storageRules = readFileSync(storageRulesPath, 'utf-8');

  // Must match users/{userId}/id-image
  assert.ok(
    storageRules.includes('match /users/{userId}/id-image'),
    'storage.rules must define match rule for /users/{userId}/id-image',
  );
  // Direct client read must be false
  assert.ok(
    storageRules.includes('allow read: if false;'),
    'storage.rules must forbid direct client reads with allow read: if false;',
  );
  // Upload must be restricted to owner
  assert.ok(
    storageRules.includes('isOwner(userId)'),
    'ID image upload must require isOwner(userId)',
  );
});
