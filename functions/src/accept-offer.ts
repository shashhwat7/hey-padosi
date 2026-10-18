// HTTPS callable: a volunteer accepts a task offer.
//
// Transactional race-safety:
//   1. Read task — fail if status != 'searching' (someone already grabbed it).
//   2. Read offer — fail if state != 'offered' (this volunteer already responded).
//   3. Write task.status='accepted' + acceptedVolunteerId + acceptedAt.
//   4. Write this offer.state='accepted' + respondedAt.
// The transaction guarantees only one volunteer's accept can flip the task
// from 'searching'. Concurrent attempts see the new status on retry and bail.
//
// Outside the transaction we mark sibling offers as 'superseded' for the
// volunteer inbox UX. This isn't security-critical (task.status already
// prevents further accepts) so it lives outside the txn.

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus, requireVolunteerRole } from './moderation-helper';
import { appendActivityLog, safeDisplayName } from './activity-log';
import { appendSystemMessage, ensureChatForTask } from './chat';
import { validateString } from './validation';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

interface AcceptResponse {
  taskId: string;
  acceptedAt: number;
}

export function evaluateAcceptOfferExpiryPure(
  task: { status?: string | undefined; expiresAtMs?: number | null | undefined },
  nowMs: number,
): { shouldAccept: boolean; isExpired: boolean; error?: string | undefined } {
  if (task.status !== 'searching') {
    return {
      shouldAccept: false,
      isExpired: false,
      error: 'This task is no longer accepting volunteers.',
    };
  }
  if (typeof task.expiresAtMs === 'number' && nowMs >= task.expiresAtMs) {
    return {
      shouldAccept: false,
      isExpired: true,
      error: 'This task has expired and is no longer accepting volunteers.',
    };
  }
  return { shouldAccept: true, isExpired: false };
}

export const acceptOffer = onCall(
  { region: REGION },
  async (request): Promise<AcceptResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = (request.data ?? {}) as {
      taskId?: unknown;
    };
    const taskId = validateString(data.taskId, 'taskId', 1, 100);
    const volunteerId = request.auth.uid;

    const db = getFirestore();
    const userData = await checkActiveStatus(db, volunteerId);
    requireVolunteerRole(userData);

    const taskRef = db.collection('tasks').doc(taskId);
    const offerRef = taskRef.collection('offers').doc(volunteerId);

    const acceptedAtMs = await db.runTransaction(async (tx) => {
      const taskSnap = await tx.get(taskRef);
      if (!taskSnap.exists) {
        throw new HttpsError('not-found', 'Task no longer exists.');
      }
      const task = taskSnap.data() as {
        status?: string;
        expiresAt?: Timestamp;
      };
      if (task.status !== 'searching') {
        throw new HttpsError(
          'failed-precondition',
          'This task is no longer accepting volunteers.',
        );
      }

      const expiresAtMs = task.expiresAt?.toMillis?.();
      if (typeof expiresAtMs === 'number' && Date.now() >= expiresAtMs) {
        tx.update(taskRef, {
          status: 'expired',
          expiredAt: FieldValue.serverTimestamp(),
          statusMessage: 'Task expired without an assigned volunteer.',
          nextCheckAt: FieldValue.delete(),
        });
        throw new HttpsError(
          'failed-precondition',
          'This task has expired and is no longer accepting volunteers.',
        );
      }

      const offerSnap = await tx.get(offerRef);
      if (!offerSnap.exists) {
        throw new HttpsError(
          'permission-denied',
          'You don’t have an offer for this task.',
        );
      }
      const offer = offerSnap.data() as { state?: string };
      if (offer.state !== 'offered') {
        throw new HttpsError(
          'failed-precondition',
          'You’ve already responded to this offer.',
        );
      }

      const now = FieldValue.serverTimestamp();
      tx.update(taskRef, {
        status: 'accepted',
        acceptedVolunteerId: volunteerId,
        acceptedAt: now,
      });
      tx.update(offerRef, {
        state: 'accepted',
        respondedAt: now,
      });
      return Date.now();
    });

    // Outside the transaction: mark sibling offers as superseded. Best-effort;
    // a failure here doesn't unwind the accept (the task is already accepted).
    try {
      const siblings = await taskRef
        .collection('offers')
        .where('state', '==', 'offered')
        .get();
      const batch = db.batch();
      for (const doc of siblings.docs) {
        if (doc.id === volunteerId) continue;
        batch.update(doc.ref, {
          state: 'superseded',
          respondedAt: FieldValue.serverTimestamp(),
        });
      }
      if (!siblings.empty) await batch.commit();
    } catch (err) {
      logger.warn('Failed to supersede sibling offers (non-fatal)', {
        taskId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // Activity log — after the transactional accept lands. Pull the
    // task title for a human-readable description; fall back if the
    // fetch fails so logging never blocks the accept response.
    let taskTitle = 'a task';
    try {
      const taskSnap = await taskRef.get();
      const t = taskSnap.exists
        ? (taskSnap.data() as { title?: string })
        : null;
      taskTitle = t?.title?.trim() || 'a task';
    } catch {
      /* keep fallback */
    }
    const volunteerName = await safeDisplayName(db, volunteerId, 'a volunteer');
    await appendActivityLog(db, {
      eventType: 'task_accepted',
      description: `${volunteerName} accepted task '${taskTitle}'`,
      userId: volunteerId,
      taskId,
    });

    // Open the in-app chat (M7). Best-effort — a chat failure must not
    // unwind the accept, which has already committed. ensureChatForTask
    // also re-keys the chat to the new volunteer if the task was reassigned.
    try {
      const taskSnap = await taskRef.get();
      const customerId = (
        taskSnap.data() as { customerId?: string } | undefined
      )?.customerId;
      if (customerId) {
        await ensureChatForTask(db, taskId, customerId, volunteerId);
        await appendSystemMessage(
          db,
          taskId,
          'You’re connected. Use this chat to coordinate the task — meeting point, timing, and anything you need to bring.',
        );
      }
    } catch (err) {
      logger.warn('Failed to set up chat (non-fatal)', {
        taskId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return { taskId, acceptedAt: acceptedAtMs };
  },
);
