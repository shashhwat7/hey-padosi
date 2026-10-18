// HTTPS callable: deleteTask
// Customer deletes a task they posted while in searching or accepted state.
// Rejects once in_progress. Notifies volunteer if assigned, soft-deletes task, and records violation.

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { appendSystemMessage } from './chat';
import { recordViolationAndCheckAbuse } from './abuse-detector';
import { validateEnum, validateString } from './validation';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

export type CustomerDeleteReason =
  | 'accidental_post'
  | 'no_longer_needed'
  | 'found_help_elsewhere'
  | 'other';

const VALID_REASONS: CustomerDeleteReason[] = [
  'accidental_post',
  'no_longer_needed',
  'found_help_elsewhere',
  'other',
];

export const deleteTask = onCall(
  { region: REGION },
  async (request): Promise<{ success: boolean }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = (request.data ?? {}) as {
      taskId?: unknown;
      reason?: unknown;
    };

    const taskId = validateString(data.taskId, 'taskId', 1, 100);
    const reason = validateEnum(data.reason, 'reason', VALID_REASONS);

    const customerUid = request.auth.uid;
    const db = getFirestore();

    await checkActiveStatus(db, customerUid);

    const taskRef = db.collection('tasks').doc(taskId);
    let wasAccepted = false;

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

      if (
        task.status !== 'searching' &&
        task.status !== 'accepted' &&
        task.status !== 'scheduled'
      ) {
        throw new HttpsError(
          'failed-precondition',
          task.status === 'in_progress'
            ? 'Cannot delete a task that is already in progress. Please use Report User if you need assistance.'
            : `Cannot delete task in status '${task.status ?? 'unknown'}'.`,
        );
      }

      wasAccepted = task.status === 'accepted';

      // Soft delete: status -> 'cancelled' (matches app conventions for removed tasks)
      transaction.update(taskRef, {
        status: 'cancelled',
        cancelledAt: FieldValue.serverTimestamp(),
        cancellationReason: reason,
      });

      // Audit event
      const eventRef = taskRef.collection('events').doc();
      transaction.set(eventRef, {
        type: 'cancelled',
        actorUid: customerUid,
        at: FieldValue.serverTimestamp(),
        payload: {
          reason: `Customer deleted task: ${reason}`,
        },
      });
    });

    if (wasAccepted) {
      await appendSystemMessage(
        db,
        taskId,
        'This task was removed by the customer.',
      );
    }

    // Record violation & check abuse threshold
    await recordViolationAndCheckAbuse(
      db,
      customerUid,
      'customer_task_delete',
      taskId,
      reason,
    );

    return { success: true };
  },
);
