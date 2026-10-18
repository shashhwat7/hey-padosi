// HTTPS callable: customer requests an End OTP when the volunteer says
// the task is done. Same security model as generateStartOtp — plaintext
// returned ONCE, hash + salt + 10-minute TTL stored on the task doc.

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

interface GenerateEndOtpResponse {
  code: string;
  expiresAtMs: number;
}

export const generateEndOtp = onCall(
  { region: REGION },
  async (request): Promise<GenerateEndOtpResponse> => {
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
        'Only the task customer can request an End OTP.',
      );
    }
    if (task.status !== 'in_progress') {
      throw new HttpsError(
        'failed-precondition',
        'End OTP is only available once the task is in progress.',
      );
    }

    const code = generateOtpCode();
    const salt = generateSalt();
    const hash = hashOtp(code, salt);
    const expiresAtMs = Date.now() + OTP_TTL_MS;
    const expiresAt = Timestamp.fromMillis(expiresAtMs);

    await taskRef.update({
      endOtpHash: hash,
      endOtpSalt: salt,
      endOtpExpiresAt: expiresAt,
      endOtpAttempts: 0,
    });

    await writeAuditEvent(taskId, 'end_otp_generated', callerUid);

    return { code, expiresAtMs };
  },
);
