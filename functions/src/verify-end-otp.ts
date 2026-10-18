// HTTPS callable: accepted volunteer submits the End OTP. On success
// the task flips to 'completed', timestamps are recorded, and the
// volunteer's reputation counters are bumped:
//   users/{volunteerId}.verifiedTaskCount += 1
//   users/{volunteerId}.verifiedHours     += estimatedMinutes / 60
//   users/{volunteerId}.points            += POINTS_PER_TASK
//   users/{volunteerId}.skillPoints[k]    += 1   for each matching skill k

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { constantTimeEquals, hashOtp, MAX_OTP_ATTEMPTS } from './otp';
import { appendActivityLog, safeDisplayName } from './activity-log';
import { appendSystemMessage } from './chat';
import { logger } from 'firebase-functions/v2';
import { validateString } from './validation';

if (getApps().length === 0) {
  initializeApp();
}
const REGION = 'asia-south1';

export const verifyEndOtp = onCall(
  { region: REGION },
  async (request): Promise<{ taskId: string; status: 'completed' }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = (request.data ?? {}) as {
      taskId?: unknown;
      code?: unknown;
    };
    const taskId = validateString(data.taskId, 'taskId', 1, 100);
    const code = validateString(data.code, 'code', 4, 4);
    if (!/^\d{4}$/.test(code)) {
      throw new HttpsError('invalid-argument', 'Enter the 4-digit code.');
    }
    const callerUid = request.auth.uid;

    const db = getFirestore();
    await checkActiveStatus(db, callerUid);
    const taskRef = db.collection('tasks').doc(taskId);

    await db.runTransaction(async (tx) => {
      const taskSnap = await tx.get(taskRef);
      if (!taskSnap.exists) {
        throw new HttpsError('not-found', 'Task no longer exists.');
      }
      const task = taskSnap.data() as {
        acceptedVolunteerId?: string;
        status?: string;
        estimatedMinutes?: number;
        requiredSkills?: string[];
        endOtpHash?: string;
        endOtpSalt?: string;
        endOtpExpiresAt?: { toMillis: () => number };
        endOtpAttempts?: number;
      };
      if (task.acceptedVolunteerId !== callerUid) {
        throw new HttpsError(
          'permission-denied',
          'Only the accepted volunteer can submit this code.',
        );
      }
      if (task.status !== 'in_progress') {
        throw new HttpsError(
          'failed-precondition',
          'This task is not waiting on an end code.',
        );
      }
      const currentAttempts = task.endOtpAttempts ?? 0;
      if (currentAttempts >= MAX_OTP_ATTEMPTS) {
        throw new HttpsError(
          'resource-exhausted',
          'Too many failed attempts. Ask the customer to generate a new code.',
        );
      }
      if (!task.endOtpHash || !task.endOtpSalt || !task.endOtpExpiresAt) {
        throw new HttpsError(
          'failed-precondition',
          'Ask the customer to generate a fresh end code.',
        );
      }
      if (task.endOtpExpiresAt.toMillis() < Date.now()) {
        throw new HttpsError(
          'failed-precondition',
          'This code has expired. Ask the customer to generate a new one.',
        );
      }
      const inputHash = hashOtp(code, task.endOtpSalt);
      if (!constantTimeEquals(inputHash, task.endOtpHash)) {
        const nextAttempts = currentAttempts + 1;
        if (nextAttempts >= MAX_OTP_ATTEMPTS) {
          tx.update(taskRef, {
            endOtpAttempts: nextAttempts,
            endOtpHash: FieldValue.delete(),
            endOtpSalt: FieldValue.delete(),
            endOtpExpiresAt: FieldValue.delete(),
          });
          throw new HttpsError(
            'resource-exhausted',
            'Too many failed attempts. Ask the customer to generate a new code.',
          );
        } else {
          tx.update(taskRef, {
            endOtpAttempts: nextAttempts,
          });
          const remaining = MAX_OTP_ATTEMPTS - nextAttempts;
          throw new HttpsError(
            'invalid-argument',
            `That code is wrong. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
          );
        }
      }

      tx.update(taskRef, {
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
        endOtpHash: FieldValue.delete(),
        endOtpSalt: FieldValue.delete(),
        endOtpExpiresAt: FieldValue.delete(),
        endOtpAttempts: FieldValue.delete(),
      });
    });

    let taskTitle = 'a task';
    try {
      const t = await taskRef.get();
      taskTitle =
        (t.data() as { title?: string } | undefined)?.title?.trim() || 'a task';
    } catch {
      /* keep fallback */
    }
    const volunteerName = await safeDisplayName(db, callerUid, 'volunteer');
    await appendActivityLog(db, {
      eventType: 'task_completed',
      description: `Task '${taskTitle}' completed by ${volunteerName}`,
      userId: callerUid,
      taskId,
    });

    // Chat system message (M7) — best-effort, never blocks the response.
    try {
      await appendSystemMessage(
        db,
        taskId,
        'Task completed — thanks for helping out!',
      );
    } catch (err) {
      logger.warn('Failed to append completion system message (non-fatal)', {
        taskId,
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return { taskId, status: 'completed' };
  },
);
