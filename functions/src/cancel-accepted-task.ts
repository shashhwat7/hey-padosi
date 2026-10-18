// HTTPS callable: cancelAcceptedTask
// Volunteer cancels a task they have accepted (but not yet started).
// Reverts task to searching status, notifies customer, excludes volunteer from re-dispatch, and records violation.

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { appendSystemMessage } from './chat';
import { recordViolationAndCheckAbuse } from './abuse-detector';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

export type VolunteerCancelReason =
  | 'accidental_accept'
  | 'other_commitments'
  | 'cant_reach_location'
  | 'other';

const VALID_REASONS: VolunteerCancelReason[] = [
  'accidental_accept',
  'other_commitments',
  'cant_reach_location',
  'other',
];

export const cancelAcceptedTask = onCall(
  { region: REGION },
  async (request): Promise<{ success: boolean }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = (request.data ?? {}) as {
      taskId?: unknown;
      reason?: unknown;
    };

    const taskId = data.taskId;
    const reason = data.reason as VolunteerCancelReason;

    if (typeof taskId !== 'string' || taskId.length === 0) {
      throw new HttpsError('invalid-argument', 'taskId is required.');
    }
    if (typeof reason !== 'string' || !VALID_REASONS.includes(reason)) {
      throw new HttpsError('invalid-argument', 'valid reason is required.');
    }

    const volunteerUid = request.auth.uid;
    const db = getFirestore();

    await checkActiveStatus(db, volunteerUid);

    const taskRef = db.collection('tasks').doc(taskId);
    const offerRef = taskRef.collection('offers').doc(volunteerUid);

    await db.runTransaction(async (transaction) => {
      const taskSnap = await transaction.get(taskRef);
      if (!taskSnap.exists) {
        throw new HttpsError('not-found', 'Task not found.');
      }

      const task = taskSnap.data() as {
        status?: string;
        acceptedVolunteerId?: string;
        customerId?: string;
      };

      if (task.acceptedVolunteerId !== volunteerUid) {
        throw new HttpsError(
          'permission-denied',
          'You are not the assigned volunteer for this task.',
        );
      }

      if (task.status !== 'accepted') {
        throw new HttpsError(
          'failed-precondition',
          task.status === 'in_progress'
            ? 'Cannot cancel a task that is already in progress.'
            : `Cannot cancel task in status '${task.status ?? 'unknown'}'.`,
        );
      }

      // Revert task to searching status & clear volunteer fields
      transaction.update(taskRef, {
        status: 'searching',
        acceptedVolunteerId: FieldValue.delete(),
        acceptedAt: FieldValue.delete(),
        startedAt: FieldValue.delete(),
        startOtpHash: FieldValue.delete(),
        startOtpSalt: FieldValue.delete(),
        startOtpExpiresAt: FieldValue.delete(),
        startOtpAttempts: FieldValue.delete(),
        endOtpHash: FieldValue.delete(),
        endOtpSalt: FieldValue.delete(),
        endOtpExpiresAt: FieldValue.delete(),
        endOtpAttempts: FieldValue.delete(),
        cancelledVolunteerIds: FieldValue.arrayUnion(volunteerUid),
      });

      // Mark volunteer's offer doc as cancelled so dispatchOffers excludes them from re-dispatch
      transaction.set(
        offerRef,
        {
          state: 'cancelled',
          respondedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      // Log task event
      const eventRef = taskRef.collection('events').doc();
      transaction.set(eventRef, {
        type: 'reassigned',
        actorUid: volunteerUid,
        at: FieldValue.serverTimestamp(),
        payload: {
          reason: `Volunteer cancelled: ${reason}`,
          previousVolunteerId: volunteerUid,
        },
      });
    });

    // Post system message to task chat
    await appendSystemMessage(
      db,
      taskId,
      "Your volunteer had to cancel. We're finding another neighbor for you.",
    );

    // Record violation & check abuse threshold
    await recordViolationAndCheckAbuse(
      db,
      volunteerUid,
      'volunteer_cancel_after_accept',
      taskId,
      reason,
    );

    return { success: true };
  },
);
