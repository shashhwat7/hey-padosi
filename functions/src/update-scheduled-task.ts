// HTTPS callable: updateScheduledTask
// Allows a customer to update the scheduledFor target time of a task while it is still in status 'scheduled'.
// Enforces minLeadTimeMinutes (30m) and maxHorizonDays (7d) validation against the current server time.

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { SCHEDULING_CONFIG } from './activate-scheduled-tasks';
import { validateNumber, validateString } from './validation';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

export function validateScheduledTime(
  scheduledForMs: number,
  nowMs: number,
): { valid: boolean; error?: string } {
  const minTimeMs = nowMs + SCHEDULING_CONFIG.minLeadTimeMinutes * 60 * 1000;
  const maxTimeMs =
    nowMs + SCHEDULING_CONFIG.maxHorizonDays * 24 * 60 * 60 * 1000;

  if (scheduledForMs < minTimeMs) {
    return {
      valid: false,
      error: `Scheduled time must be at least ${SCHEDULING_CONFIG.minLeadTimeMinutes} minutes in the future.`,
    };
  }

  if (scheduledForMs > maxTimeMs) {
    return {
      valid: false,
      error: `Scheduled time cannot be more than ${SCHEDULING_CONFIG.maxHorizonDays} days in advance.`,
    };
  }

  return { valid: true };
}

export const updateScheduledTask = onCall(
  { region: REGION },
  async (request): Promise<{ success: boolean }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }

    const data = (request.data ?? {}) as {
      taskId?: unknown;
      newScheduledForMs?: unknown;
    };

    const taskId = validateString(data.taskId, 'taskId', 1, 100);
    const newScheduledForMs = validateNumber(
      data.newScheduledForMs,
      'newScheduledForMs',
      0,
      Number.MAX_SAFE_INTEGER,
    );

    const nowMs = Date.now();
    const validation = validateScheduledTime(newScheduledForMs, nowMs);
    if (!validation.valid) {
      throw new HttpsError('invalid-argument', validation.error!);
    }

    const customerUid = request.auth.uid;
    const db = getFirestore();

    await checkActiveStatus(db, customerUid);

    const taskRef = db.collection('tasks').doc(taskId);

    await db.runTransaction(async (transaction) => {
      const taskSnap = await transaction.get(taskRef);
      if (!taskSnap.exists) {
        throw new HttpsError('not-found', 'Task not found.');
      }

      const task = taskSnap.data() as {
        status?: string;
        customerId?: string;
      };

      if (task.customerId !== customerUid) {
        throw new HttpsError(
          'permission-denied',
          'You are not the creator of this task.',
        );
      }

      if (task.status !== 'scheduled') {
        throw new HttpsError(
          'failed-precondition',
          `Cannot edit scheduled time for task in status '${task.status ?? 'unknown'}'.`,
        );
      }

      transaction.update(taskRef, {
        scheduledFor: Timestamp.fromMillis(newScheduledForMs),
      });

      const eventRef = taskRef.collection('events').doc();
      transaction.set(eventRef, {
        type: 'scheduled_task_time_updated',
        actorUid: customerUid,
        at: FieldValue.serverTimestamp(),
        payload: {
          newScheduledFor: Timestamp.fromMillis(newScheduledForMs),
        },
      });
    });

    return { success: true };
  },
);
