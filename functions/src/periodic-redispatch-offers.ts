// Scheduled re-dispatch + radius expansion for stale searching tasks.
// Implements the `expandRadius` slot called out in
// memory-bank/systemPatterns.md (Cloud Functions inventory).
//
// Runs every minute (minimum scheduler granularity on GCP). For each
// `tasks/{taskId}` still in `searching`:
//   - Skip if the task is fresher than INITIAL_GRACE_MS.
//   - Skip if `lastRedispatchAt` is younger than REDISPATCH_INTERVAL_MS.
//   - Scale radius expansion based on customer's `expectedWaitTier`.
//   - Compute elapsed time & update customer `statusMessage` when crossing nudge stages.
//   - Set `nearingExpiry: true` before 24h auto-expiry.

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { rankForTask, type TaskDoc } from './scoring';
import {
  NEARING_EXPIRY_COPY,
  NUDGE_COPY_BANK,
  WAIT_TIER_CONFIG,
  type WaitTier,
} from './nudge-copy-bank';
import { writeAuditEvent } from './audit';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';
const INITIAL_GRACE_MS = 30 * 1000;
const REDISPATCH_INTERVAL_MS = 60 * 1000;
const RADIUS_BUMP_M = 1000;
const MAX_RADIUS_M = 10000;
const MAX_NEW_OFFERS_PER_TASK = 10;
const MAX_TASKS_PER_SWEEP = 100;
const PRE_EXPIRY_LEAD_MS = 2 * 60 * 60 * 1000; // 2 hours before 24h expiry

export interface SearchingTask extends TaskDoc {
  createdAt?: Timestamp;
  lastRedispatchAt?: Timestamp;
  expectedWaitTier?: WaitTier;
  waitStartedAt?: Timestamp;
  lastNudgeStage?: 0 | 1 | 2 | 3;
  lastNudgeSentAt?: Timestamp;
  statusMessage?: string | null;
  nearingExpiry?: boolean;
  expiresAt?: Timestamp;
  nextCheckAt?: Timestamp;
}

export interface NudgeUpdateResult {
  nextNudgeStage?: 1 | 2 | 3;
  statusMessage?: string;
  nearingExpiry?: boolean;
}

export function evaluateTaskExpiryPure(
  task: {
    status?: string | undefined;
    expiresAt?: { toMillis(): number } | number | null | undefined;
  },
  nowMs: number,
): { isExpired: boolean; shouldTransition: boolean } {
  if (task.status !== 'searching') {
    return { isExpired: false, shouldTransition: false };
  }
  const expiresAtMs =
    typeof task.expiresAt === 'number'
      ? task.expiresAt
      : task.expiresAt?.toMillis?.();
  if (typeof expiresAtMs === 'number' && nowMs >= expiresAtMs) {
    return { isExpired: true, shouldTransition: true };
  }
  return { isExpired: false, shouldTransition: false };
}

export function computeNudgeUpdate(
  task: {
    expectedWaitTier?: string;
    waitStartedAt?: { toMillis(): number } | null;
    createdAt?: { toMillis(): number } | null;
    lastNudgeStage?: number;
    nearingExpiry?: boolean;
    expiresAt?: { toMillis(): number } | null;
  },
  nowMs: number,
): NudgeUpdateResult | null {
  const tier: WaitTier =
    task.expectedWaitTier && task.expectedWaitTier in WAIT_TIER_CONFIG
      ? (task.expectedWaitTier as WaitTier)
      : 'normal';

  const tierConfig = WAIT_TIER_CONFIG[tier];
  const startTimeMs =
    task.waitStartedAt?.toMillis() ?? task.createdAt?.toMillis() ?? 0;

  if (startTimeMs === 0) return null;

  const elapsedMinutes = Math.floor((nowMs - startTimeMs) / (60 * 1000));
  const currentStage = task.lastNudgeStage ?? 0;

  let nextStage: 1 | 2 | 3 | undefined;
  if (currentStage < 1 && elapsedMinutes >= tierConfig.nudgeStages[0]) {
    nextStage = 1;
  } else if (currentStage < 2 && elapsedMinutes >= tierConfig.nudgeStages[1]) {
    nextStage = 2;
  } else if (currentStage < 3 && elapsedMinutes >= tierConfig.nudgeStages[2]) {
    nextStage = 3;
  }

  const expiresAtMs = task.expiresAt?.toMillis();
  const isNearExpiry =
    typeof expiresAtMs === 'number' &&
    nowMs >= expiresAtMs - PRE_EXPIRY_LEAD_MS;
  const effectiveStage = nextStage ?? currentStage;
  const shouldSetNearingExpiry =
    isNearExpiry && !task.nearingExpiry && effectiveStage === 3;

  if (!nextStage && !shouldSetNearingExpiry) {
    return null;
  }

  const result: NudgeUpdateResult = {};
  if (nextStage) {
    result.nextNudgeStage = nextStage;
    result.statusMessage = NUDGE_COPY_BANK[nextStage];
  }
  if (shouldSetNearingExpiry) {
    result.nearingExpiry = true;
    result.statusMessage = NEARING_EXPIRY_COPY;
  }

  return result;
}

export function computeNextCheckAt(
  task: {
    expectedWaitTier?: string;
    waitStartedAt?: { toMillis(): number } | null;
    createdAt?: { toMillis(): number } | null;
    lastNudgeStage?: number;
  },
  nowMs: number,
): Timestamp {
  const tier: WaitTier =
    task.expectedWaitTier && task.expectedWaitTier in WAIT_TIER_CONFIG
      ? (task.expectedWaitTier as WaitTier)
      : 'normal';

  const tierConfig = WAIT_TIER_CONFIG[tier];
  const startTimeMs =
    task.waitStartedAt?.toMillis() ?? task.createdAt?.toMillis() ?? nowMs;

  const currentStage = task.lastNudgeStage ?? 0;
  let nextNudgeDueMs = nowMs + REDISPATCH_INTERVAL_MS;

  const nextStageIndex = currentStage;
  if (nextStageIndex < tierConfig.nudgeStages.length) {
    const dueMins = tierConfig.nudgeStages[nextStageIndex];
    if (typeof dueMins === 'number') {
      const dueMs = startTimeMs + dueMins * 60 * 1000;
      if (dueMs > nowMs) {
        nextNudgeDueMs = dueMs;
      }
    }
  }

  const nextIntervalMs = nowMs + REDISPATCH_INTERVAL_MS;
  const soonestMs = Math.min(nextIntervalMs, nextNudgeDueMs);

  return Timestamp.fromMillis(soonestMs);
}

export const periodicRedispatchOffers = onSchedule(
  { region: REGION, schedule: 'every 1 minutes' },
  async () => {
    const db = getFirestore();
    const now = Date.now();
    const nowTimestamp = Timestamp.fromMillis(now);

    // Primary indexed query: tasks due for check
    const tasksSnap = await db
      .collection('tasks')
      .where('status', '==', 'searching')
      .where('nextCheckAt', '<=', nowTimestamp)
      .limit(MAX_TASKS_PER_SWEEP)
      .get();

    // Fallback query for legacy tasks that don't have nextCheckAt set yet
    const taskDocs = [...tasksSnap.docs];
    if (taskDocs.length < MAX_TASKS_PER_SWEEP) {
      const legacySnap = await db
        .collection('tasks')
        .where('status', '==', 'searching')
        .limit(MAX_TASKS_PER_SWEEP - taskDocs.length)
        .get();

      const existingIds = new Set(taskDocs.map((d) => d.id));
      for (const d of legacySnap.docs) {
        const data = d.data() as SearchingTask;
        if (!existingIds.has(d.id) && !data.nextCheckAt) {
          taskDocs.push(d);
        }
      }
    }

    if (taskDocs.length === 0) return;

    let processed = 0;
    let totalWrites = 0;

    for (const taskDoc of taskDocs) {
      const task = taskDoc.data() as SearchingTask;

      // 1. Task expiry check: transition to 'expired' if now >= expiresAt
      const expiryCheck = evaluateTaskExpiryPure(task, now);
      if (expiryCheck.shouldTransition) {
        let transitioned = false;
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(taskDoc.ref);
          if (!snap.exists) return;
          const current = snap.data() as SearchingTask;
          if (current.status !== 'searching') return;
          tx.update(taskDoc.ref, {
            status: 'expired',
            expiredAt: FieldValue.serverTimestamp(),
            statusMessage: 'Task expired without an assigned volunteer.',
            nextCheckAt: FieldValue.delete(),
          });
          transitioned = true;
        });

        if (transitioned) {
          try {
            const openOffersSnap = await taskDoc.ref
              .collection('offers')
              .where('state', '==', 'offered')
              .get();
            if (!openOffersSnap.empty) {
              const batch = db.batch();
              for (const oDoc of openOffersSnap.docs) {
                batch.update(oDoc.ref, {
                  state: 'expired',
                  respondedAt: FieldValue.serverTimestamp(),
                });
              }
              await batch.commit();
            }
          } catch (err) {
            logger.warn(`Failed to expire sibling offers for task ${taskDoc.id}`, { error: err });
          }

          try {
            await writeAuditEvent(taskDoc.id, 'expired', 'system', {
              reason: '24h window elapsed without volunteer match',
            });
          } catch (err) {
            logger.warn(`Failed to write expiry audit event for task ${taskDoc.id}`, { error: err });
          }
        }
        processed++;
        continue;
      }

      const createdAtMs = task.createdAt?.toMillis();
      if (
        typeof createdAtMs === 'number' &&
        now - createdAtMs < INITIAL_GRACE_MS
      ) {
        continue;
      }
      const lastMs = task.lastRedispatchAt?.toMillis() ?? createdAtMs ?? 0;
      if (now - lastMs < REDISPATCH_INTERVAL_MS && task.nextCheckAt) continue;

      // Tier-scaled radius bump
      const tier: WaitTier =
        task.expectedWaitTier && task.expectedWaitTier in WAIT_TIER_CONFIG
          ? (task.expectedWaitTier as WaitTier)
          : 'normal';
      const stepM = Math.round(
        RADIUS_BUMP_M * WAIT_TIER_CONFIG[tier].radiusStepMultiplier,
      );

      const nextRadius = Math.min(task.searchRadiusM + stepM, MAX_RADIUS_M);
      const radiusBumped = nextRadius > task.searchRadiusM;

      // Compute nudge updates
      const nudgeUpdate = computeNudgeUpdate(task, now);

      const offersSnap = await taskDoc.ref.collection('offers').get();
      const alreadyOffered = new Set(offersSnap.docs.map((d) => d.id));
      if (Array.isArray(task.cancelledVolunteerIds)) {
        for (const uid of task.cancelledVolunteerIds) {
          if (typeof uid === 'string' && uid.length > 0) {
            alreadyOffered.add(uid);
          }
        }
      }

      const ranked = await rankForTask(
        { ...task, searchRadiusM: nextRadius },
        alreadyOffered,
      );
      const newCandidates = ranked
        .filter((r) => !alreadyOffered.has(r.uid))
        .slice(0, MAX_NEW_OFFERS_PER_TASK);

      const nextCheckAt = computeNextCheckAt(task, now);

      if (newCandidates.length === 0 && !radiusBumped && !nudgeUpdate) {
        await taskDoc.ref.update({
          lastRedispatchAt: FieldValue.serverTimestamp(),
          nextCheckAt,
        });
        processed++;
        continue;
      }

      const batch = db.batch();
      const taskUpdate: Record<string, unknown> = {
        lastRedispatchAt: FieldValue.serverTimestamp(),
        nextCheckAt,
      };
      if (radiusBumped) {
        taskUpdate.searchRadiusM = nextRadius;
      }

      if (nudgeUpdate) {
        if (nudgeUpdate.nextNudgeStage) {
          taskUpdate.lastNudgeStage = nudgeUpdate.nextNudgeStage;
          taskUpdate.lastNudgeSentAt = FieldValue.serverTimestamp();
        }
        if (nudgeUpdate.statusMessage) {
          taskUpdate.statusMessage = nudgeUpdate.statusMessage;
        }
        if (nudgeUpdate.nearingExpiry) {
          taskUpdate.nearingExpiry = true;
        }
      }

      batch.update(taskDoc.ref, taskUpdate);

      for (const v of newCandidates) {
        const offerRef = taskDoc.ref.collection('offers').doc(v.uid);
        batch.set(offerRef, {
          volunteerId: v.uid,
          taskId: taskDoc.id,
          customerId: task.customerId,
          taskTitle: task.title,
          taskCategory: task.category,
          taskRiskLevel: task.riskLevel,
          displayName: v.displayName,
          photoURL: v.photoURL,
          state: 'offered',
          score: v.score,
          scoreBreakdown: v.scoreBreakdown,
          distanceM: v.distanceM,
          offeredAt: FieldValue.serverTimestamp(),
        });
      }

      if (radiusBumped) {
        const eventRef = taskDoc.ref.collection('events').doc();
        batch.set(eventRef, {
          type: 'radius_expanded',
          actorUid: 'system',
          at: FieldValue.serverTimestamp(),
          payload: {
            previousRadiusM: task.searchRadiusM,
            newRadiusM: nextRadius,
            newCandidates: newCandidates.length,
          },
        });
      }

      await batch.commit();
      processed++;
      totalWrites += newCandidates.length;
    }

    if (processed > 0) {
      logger.info('periodicRedispatchOffers swept', {
        processed,
        totalWrites,
      });
    }
  },
);
