// HTTPS callable: customer requests a Start OTP for their accepted task.
//
// The plaintext code is returned ONCE in this response (the customer shows
// it to the volunteer in person, who types it into their phone). The task
// doc only stores SHA-256(code + salt) + the salt + a 10-minute expiry.
// Plaintext is never persisted, never returned to the volunteer's client,
// never logged.

import { getApps, initializeApp } from 'firebase-admin/app';
import { Timestamp, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { writeAuditEvent } from './audit';
import { OTP_TTL_MS, generateOtpCode, generateSalt, hashOtp } from './otp';
import { validateString } from './validation';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

interface GenerateStartOtpResponse {
  code: string;
  expiresAtMs: number;
}

export const generateStartOtp = onCall(
  { region: REGION },
  async (request): Promise<GenerateStartOtpResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = (request.data ?? {}) as { taskId?: unknown };
    const taskId = validateString(data.taskId, 'taskId', 1, 100);
    const callerUid = request.auth.uid;

    const db = getFirestore();
    await checkActiveStatus(db, callerUid);
    const taskRef = db.collection('tasks').doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) {
      throw new HttpsError('not-found', 'Task not found.');
    }
    const task = taskSnap.data() as { customerId?: string; status?: string };
    if (task.customerId !== callerUid) {
      throw new HttpsError(
        'permission-denied',
        'Only the task customer can request a Start OTP.',
      );
    }
    if (task.status !== 'accepted') {
      throw new HttpsError(
        'failed-precondition',
        'Start OTP is only available for accepted tasks.',
      );
    }

    const code = generateOtpCode();
    const salt = generateSalt();
    const hash = hashOtp(code, salt);
    const expiresAtMs = Date.now() + OTP_TTL_MS;
    const expiresAt = Timestamp.fromMillis(expiresAtMs);

    await taskRef.update({
      startOtpHash: hash,
      startOtpSalt: salt,
      startOtpExpiresAt: expiresAt,
      startOtpAttempts: 0,
    });

    await writeAuditEvent(taskId, 'start_otp_generated', callerUid);

    return { code, expiresAtMs };
  },
);
