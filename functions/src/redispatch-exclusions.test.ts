// Regression tests for Batch 4: Volunteer Redispatch Exclusion Bug Fixes
// Executed via Node.js native test runner: node --test

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeDispatchExclusionsPure } from './dispatch-offers';
import { filterCandidatesWithExclusionsPure, score, type TaskDoc, type UserDoc } from './scoring';

// ------------------------------------------------------------------
// 1. DISPATCH EXCLUSION CALCULATOR (computeDispatchExclusionsPure)
// ------------------------------------------------------------------

test('computeDispatchExclusionsPure excludes volunteer who cancelled an offer for the task', () => {
  const task = {
    cancelledVolunteerIds: ['vol-cancelled-1'],
  };
  const existingOffers = [
    { id: 'vol-cancelled-1', state: 'cancelled' },
  ];

  const exclusions = computeDispatchExclusionsPure(task, existingOffers);
  assert.equal(exclusions.has('vol-cancelled-1'), true, 'Cancelled volunteer must be excluded');
  assert.equal(exclusions.has('vol-other'), false, 'Unrelated volunteer must not be excluded');
});

test('computeDispatchExclusionsPure excludes volunteer who rejected an offer for the task', () => {
  const task = {};
  const existingOffers = [
    { id: 'vol-rejected-1', state: 'rejected' },
  ];

  const exclusions = computeDispatchExclusionsPure(task, existingOffers);
  assert.equal(exclusions.has('vol-rejected-1'), true, 'Rejected volunteer must be excluded');
  assert.equal(exclusions.has('vol-other'), false, 'Unrelated volunteer must not be excluded');
});

test('computeDispatchExclusionsPure permits other eligible volunteers to receive offers', () => {
  const task = {
    cancelledVolunteerIds: ['vol-cancelled-1'],
  };
  const existingOffers = [
    { id: 'vol-cancelled-1', state: 'cancelled' },
    { id: 'vol-rejected-1', state: 'rejected' },
    { id: 'vol-superseded-1', state: 'superseded' },
  ];

  const exclusions = computeDispatchExclusionsPure(task, existingOffers);
  assert.equal(exclusions.has('vol-cancelled-1'), true);
  assert.equal(exclusions.has('vol-rejected-1'), true);
  // Superseded volunteer or newly eligible volunteer is not excluded
  assert.equal(exclusions.has('vol-superseded-1'), false, 'Superseded volunteer can be re-considered on reassignment');
  assert.equal(exclusions.has('vol-new-1'), false, 'New eligible volunteer can receive offer');
});

test('computeDispatchExclusionsPure prevents duplicate active offers for volunteers already offered', () => {
  const task = {};
  const existingOffers = [
    { id: 'vol-active-1', state: 'offered' },
  ];

  const exclusions = computeDispatchExclusionsPure(task, existingOffers);
  assert.equal(exclusions.has('vol-active-1'), true, 'Volunteer with active offer must be excluded from re-dispatch');
});

test('computeDispatchExclusionsPure is scoped strictly per-task: volunteer excluded from task A is not excluded from task B', () => {
  // Task A: volunteer cancelled
  const taskA = { cancelledVolunteerIds: ['vol-multi-1'] };
  const offersA = [{ id: 'vol-multi-1', state: 'cancelled' }];
  const exclusionsA = computeDispatchExclusionsPure(taskA, offersA);

  // Task B: volunteer never interacted with Task B
  const taskB = { cancelledVolunteerIds: [] };
  const offersB: Array<{ id: string; state?: string }> = [];
  const exclusionsB = computeDispatchExclusionsPure(taskB, offersB);

  assert.equal(exclusionsA.has('vol-multi-1'), true, 'Volunteer must be excluded from task A');
  assert.equal(exclusionsB.has('vol-multi-1'), false, 'Volunteer must NOT be excluded from task B');
});

// ------------------------------------------------------------------
// 2. CANDIDATE FILTERING & RANKING INVARIANTS (filterCandidatesWithExclusionsPure)
// ------------------------------------------------------------------

test('filterCandidatesWithExclusionsPure excludes cancelled and rejected volunteers while preserving candidate ranking order', () => {
  const candidates = [
    { uid: 'vol-top-1', score: 95 },
    { uid: 'vol-cancelled-1', score: 90 },
    { uid: 'vol-mid-2', score: 85 },
    { uid: 'vol-rejected-1', score: 80 },
    { uid: 'vol-new-3', score: 75 },
  ];

  const excludedUids = new Set(['vol-cancelled-1', 'vol-rejected-1']);
  const filtered = filterCandidatesWithExclusionsPure(candidates, excludedUids);

  assert.deepEqual(
    filtered.map((c) => c.uid),
    ['vol-top-1', 'vol-mid-2', 'vol-new-3'],
    'Excluded volunteers must be filtered out while relative score ordering is preserved',
  );
  assert.equal(filtered[0]?.score, 95);
  assert.equal(filtered[1]?.score, 85);
  assert.equal(filtered[2]?.score, 75);
});

test('filterCandidatesWithExclusionsPure works with Array or Set and handles undefined exclusions cleanly', () => {
  const candidates = [
    { uid: 'vol-1', score: 80 },
    { uid: 'vol-2', score: 70 },
  ];

  assert.equal(filterCandidatesWithExclusionsPure(candidates, undefined).length, 2);
  assert.equal(filterCandidatesWithExclusionsPure(candidates, ['vol-1']).length, 1);
  assert.equal(filterCandidatesWithExclusionsPure(candidates, new Set(['vol-2'])).length, 1);
});

test('Scoring and reachability invariants: new volunteers with zero completions remain reachable', () => {
  const task: TaskDoc = {
    customerId: 'cust-1',
    category: 'groceries',
    title: 'Buy milk',
    requiredSkills: ['groceries'],
    location: { lat: 12.9716, lng: 77.5946, h3Cell: '886189255bfffff' },
    riskLevel: 'low',
    searchRadiusM: 3000,
    status: 'searching',
  };

  const newVolunteer: UserDoc = {
    displayName: 'New Neighbor',
    roles: ['volunteer'],
    skills: ['groceries'],
    availableNow: true,
    lastKnownLocation: { lat: 12.972, lng: 77.595, h3Cell: '886189255bfffff' },
    trustScore: 50,
    verifiedTaskCount: 0,
    openReportsCount: 0,
    warningsCount: 0,
  };

  const breakdown = score(newVolunteer, task);
  assert.ok(breakdown.total > 0, 'New volunteer must receive a positive score');
  assert.equal(breakdown.pastCompletion, 0.2, 'Zero completions yields 0.2 baseline pastCompletion ensuring new volunteer reachability');
  assert.ok(breakdown.skill > 0, 'Skill match contributes positive points');
  assert.ok(breakdown.distance > 0, 'Nearby location contributes positive points');
});

// ------------------------------------------------------------------
// 3. CODEBASE SOURCE INVARIANTS & AUDIT COMPLIANCE
// ------------------------------------------------------------------

test('Dispatch source invariant: dispatchOffers does NOT delete offers subcollection on reassignment', () => {
  const dispatchPath = join(__dirname, '../../functions/src/dispatch-offers.ts');
  const source = readFileSync(dispatchPath, 'utf-8');

  // Verify deletion batch was removed
  assert.equal(
    source.includes('deleteBatch.delete'),
    false,
    'dispatchOffers must not delete existing offer documents',
  );
  assert.equal(
    source.includes('deleteBatch.commit()'),
    false,
    'dispatchOffers must not commit batch deletes on existing offers',
  );

  // Verify exclusions are computed and passed to ranker
  assert.ok(
    source.includes('computeDispatchExclusionsPure'),
    'dispatchOffers must call computeDispatchExclusionsPure',
  );
  assert.ok(
    source.includes('rankForTask(afterData, excludedUids)'),
    'dispatchOffers must pass excludedUids to rankForTask',
  );
});

test('Cancel accepted task invariant: cancelAcceptedTask records cancelled offer and cancelledVolunteerIds', () => {
  const cancelPath = join(__dirname, '../../functions/src/cancel-accepted-task.ts');
  const source = readFileSync(cancelPath, 'utf-8');

  assert.ok(
    source.includes("state: 'cancelled'"),
    "cancelAcceptedTask must set offer state to 'cancelled'",
  );
  assert.ok(
    source.includes('cancelledVolunteerIds: FieldValue.arrayUnion(volunteerUid)'),
    'cancelAcceptedTask must append volunteerUid to task.cancelledVolunteerIds',
  );
});

test('Periodic redispatch invariant: periodicRedispatchOffers excludes existing offer doc IDs and cancelledVolunteerIds', () => {
  const redispatchPath = join(__dirname, '../../functions/src/periodic-redispatch-offers.ts');
  const source = readFileSync(redispatchPath, 'utf-8');

  assert.ok(
    source.includes('task.cancelledVolunteerIds'),
    'periodicRedispatchOffers must inspect task.cancelledVolunteerIds',
  );
  assert.match(
    source,
    /rankForTask\s*\(\s*\{[\s\S]*?searchRadiusM:\s*nextRadius[\s\S]*?\},\s*alreadyOffered\s*,?\s*\)/,
    'periodicRedispatchOffers must pass alreadyOffered to rankForTask',
  );
});

test('Suggest next tasks invariant: suggestNextTasks excludes cancelled and rejected tasks', () => {
  const suggestPath = join(__dirname, '../../functions/src/suggest-next-tasks.ts');
  const source = readFileSync(suggestPath, 'utf-8');

  assert.ok(
    source.includes('candidate.cancelledVolunteerIds'),
    'suggestNextTasks must check candidate.cancelledVolunteerIds',
  );
  assert.ok(
    source.includes("offerData.state === 'cancelled' || offerData.state === 'rejected'"),
    'suggestNextTasks must never re-offer or overwrite a cancelled or rejected offer',
  );
});

test('Availability trigger invariant: onVolunteerAvailable excludes cancelled volunteers', () => {
  const availPath = join(__dirname, '../../functions/src/on-volunteer-available.ts');
  const source = readFileSync(availPath, 'utf-8');

  assert.ok(
    source.includes('taskData.cancelledVolunteerIds'),
    'onVolunteerAvailable must check taskData.cancelledVolunteerIds',
  );
  assert.ok(
    source.includes('if (existing.exists) continue;'),
    'onVolunteerAvailable must skip tasks where an offer already exists',
  );
});

test('Scoring invariant: rankForTask includes task.cancelledVolunteerIds in exclusionSet automatically', () => {
  const scoringPath = join(__dirname, '../../functions/src/scoring.ts');
  const source = readFileSync(scoringPath, 'utf-8');

  assert.ok(
    source.includes('task.cancelledVolunteerIds'),
    'rankForTask must incorporate task.cancelledVolunteerIds into exclusionSet',
  );
  assert.ok(
    source.includes('!exclusionSet.has(uid)'),
    'rankForTask candidate filter must exclude UIDs in exclusionSet',
  );
});
