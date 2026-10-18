// Firestore trigger on users/{uid} updates.
// When a volunteer flips `availableNow` from false → true, scan currently
// searching tasks and write offer docs for any task they are eligible for
// (per `isEligible` in scoring.ts) and don't already have an offer on.
//
// Closes the "volunteer came online after the initial dispatch already ran"
// gap — the original `dispatchOffers` only fires on task create or task
// transition back to searching; it never re-runs when a volunteer joins
// the available pool late.
//
// Companion to `periodicRedispatchOffers` (scheduled re-dispatch + radius
// expansion). Together they cover both "volunteer-side state changed" and
// "time passed without acceptance" paths.

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import {
  haversineM,
  isEligible,
  score as scoreFn,
  type TaskDoc,
  type UserDoc,
} from './scoring';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';
// Hard cap so a single availability flip can't fan out to a runaway number
// of writes — protects emulator + (eventual) prod from pathological load.
const MAX_TASKS_PER_FLIP = 50;

export const onVolunteerAvailable = onDocumentUpdated(
  { document: 'users/{uid}', region: REGION },
  async (event) => {
    const before = event.data?.before.data() as UserDoc | undefined;
    const after = event.data?.after.data() as UserDoc | undefined;
    if (!before || !after) return;

    // Only react to the transition false/undefined → true.
    if (after.availableNow !== true) return;
    if (before.availableNow === true) return;

    const uid = event.params.uid;

    // Cheap up-front bails — match the same gating as `isEligible` so we
    // don't pay for the task scan when we already know nothing will write.
    const isBanned = after.accountStatus === 'banned' || after.banned === true;
    const isSuspended =
      after.accountStatus === 'suspended' &&
      after.suspendedUntil &&
      after.suspendedUntil.toMillis() > Date.now();
    if (isBanned || isSuspended) return;
    if (!after.roles?.includes('volunteer')) return;
    if (!after.lastKnownLocation) return;
    if (!after.skills || after.skills.length === 0) return;

    const db = getFirestore();

    // Mutual-block filter — mirror the symmetric query rankForTask uses.
    const [blocksA, blocksB] = await Promise.all([
      db.collection('blocks').where('userA', '==', uid).get(),
      db.collection('blocks').where('userB', '==', uid).get(),
    ]);
    const blockedUids = new Set<string>();
    blocksA.forEach((d) => {
      const data = d.data() as { userB: string };
      blockedUids.add(data.userB);
    });
    blocksB.forEach((d) => {
      const data = d.data() as { userA: string };
      blockedUids.add(data.userA);
    });

    const searchingSnap = await db
      .collection('tasks')
      .where('status', '==', 'searching')
      .limit(MAX_TASKS_PER_FLIP)
      .get();
    if (searchingSnap.empty) return;

    let writes = 0;
    const batch = db.batch();

    for (const taskDoc of searchingSnap.docs) {
      const taskData = taskDoc.data() as TaskDoc;
      const taskId = taskDoc.id;

      if (blockedUids.has(taskData.customerId)) continue;
      const expiresAtMs = (taskData as { expiresAt?: Timestamp }).expiresAt?.toMillis?.();
      if (typeof expiresAtMs === 'number' && Date.now() >= expiresAtMs) continue;
      if (!isEligible(uid, after, taskData)) continue;
      if (
        Array.isArray(taskData.cancelledVolunteerIds) &&
        taskData.cancelledVolunteerIds.includes(uid)
      ) {
        continue;
      }

      const offerRef = taskDoc.ref.collection('offers').doc(uid);
      const existing = await offerRef.get();
      if (existing.exists) continue;

      const breakdown = scoreFn(after, taskData);
      const distM = haversineM(
        after.lastKnownLocation.lat,
        after.lastKnownLocation.lng,
        taskData.location.lat,
        taskData.location.lng,
      );

      batch.set(offerRef, {
        volunteerId: uid,
        taskId,
        // Denormalised so the volunteer inbox renders without reading the
        // parent task. Mirrors `dispatchOffers`.
        customerId: taskData.customerId,
        taskTitle: taskData.title,
        taskCategory: taskData.category,
        taskRiskLevel: taskData.riskLevel,
        displayName: after.displayName ?? '',
        photoURL: after.photoURL ?? null,
        state: 'offered',
        score: breakdown.total,
        scoreBreakdown: breakdown,
        distanceM: Math.round(distM),
        offeredAt: FieldValue.serverTimestamp(),
      });
      writes++;
    }

    if (writes === 0) return;
    await batch.commit();
    logger.info('onVolunteerAvailable: wrote offers', { uid, writes });
  },
);
