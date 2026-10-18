// Cloud Functions: ID Verification Workflow (Batch 5 Hardening)
// Server-authoritative review, secure short-lived preview URLs, and audit logging.

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { logger } from 'firebase-functions/v2';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { recomputeTrustScore } from './recompute-trust-score';
import { appendActivityLog, safeDisplayName } from './activity-log';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

export function evaluateIdVerificationDecisionPure(params: {
  isAdmin: boolean;
  decision: 'approve' | 'reject';
  fileFound: boolean;
  rejectionReason?: string | undefined;
}): {
  allowed: boolean;
  error?: string | undefined;
  resultingStatus?: 'verified' | 'rejected' | undefined;
  idVerified?: boolean | undefined;
} {
  if (!params.isAdmin) {
    return {
      allowed: false,
      error: 'Only administrators can perform ID verification reviews.',
    };
  }
  if (params.decision === 'approve') {
    if (!params.fileFound) {
      return {
        allowed: false,
        error:
          'Cannot approve ID verification: document does not exist in storage or was deleted.',
      };
    }
    return { allowed: true, resultingStatus: 'verified', idVerified: true };
  }
  if (params.decision === 'reject') {
    const reason = params.rejectionReason?.trim();
    if (!reason || reason.length < 5) {
      return {
        allowed: false,
        error:
          'A clear rejection reason (at least 5 characters) is required when rejecting verification.',
      };
    }
    return { allowed: true, resultingStatus: 'rejected', idVerified: false };
  }
  return { allowed: false, error: 'Invalid decision' };
}

export const getAdminIdVerificationUrl = onCall(
  { region: REGION },
  async (request): Promise<{ url: string; expiresAtMs: number }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const adminUid = request.auth.uid;
    const db = getFirestore();
    await checkActiveStatus(db, adminUid);

    // Verify admin role
    const adminSnap = await db.collection('users').doc(adminUid).get();
    if (!adminSnap.exists || adminSnap.data()?.isAdmin !== true) {
      throw new HttpsError(
        'permission-denied',
        'Only administrators can access ID documents for verification.',
      );
    }

    const data = (request.data ?? {}) as { userId?: unknown };
    const userId = data.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new HttpsError('invalid-argument', 'userId is required.');
    }

    const userSnap = await db.collection('users').doc(userId).get();
    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'Target user does not exist.');
    }

    const bucket = getStorage().bucket();
    const filePath = `users/${userId}/id-image`;
    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    if (!exists) {
      throw new HttpsError(
        'not-found',
        'ID document not found or was deleted by the user.',
      );
    }

    const expiresAtMs = Date.now() + 15 * 60 * 1000; // 15 minutes
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: expiresAtMs,
    });

    return { url, expiresAtMs };
  },
);

export const reviewIdVerification = onCall(
  { region: REGION },
  async (
    request,
  ): Promise<{
    success: boolean;
    userId: string;
    decision: 'approve' | 'reject';
  }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const adminUid = request.auth.uid;
    const db = getFirestore();
    await checkActiveStatus(db, adminUid);

    // Verify admin role
    const adminSnap = await db.collection('users').doc(adminUid).get();
    if (!adminSnap.exists || adminSnap.data()?.isAdmin !== true) {
      throw new HttpsError(
        'permission-denied',
        'Only administrators can review ID verifications.',
      );
    }

    const data = (request.data ?? {}) as {
      userId?: unknown;
      decision?: unknown;
      rejectionReason?: unknown;
    };

    const userId = data.userId;
    const decision = data.decision;
    const rejectionReason = data.rejectionReason;

    if (typeof userId !== 'string' || userId.length === 0) {
      throw new HttpsError('invalid-argument', 'userId is required.');
    }
    if (decision !== 'approve' && decision !== 'reject') {
      throw new HttpsError(
        'invalid-argument',
        "decision must be 'approve' or 'reject'.",
      );
    }

    const bucket = getStorage().bucket();
    const filePath = `users/${userId}/id-image`;
    const file = bucket.file(filePath);
    const [fileExists] = await file.exists();

    if (decision === 'approve' && !fileExists) {
      throw new HttpsError(
        'failed-precondition',
        'Cannot approve ID verification: document does not exist in storage or was deleted.',
      );
    }

    if (decision === 'reject') {
      if (
        typeof rejectionReason !== 'string' ||
        rejectionReason.trim().length < 5
      ) {
        throw new HttpsError(
          'invalid-argument',
          'A clear rejection reason (at least 5 characters) is required when rejecting verification.',
        );
      }
    }

    const userRef = db.collection('users').doc(userId);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new HttpsError('not-found', 'Target user does not exist.');
      }

      if (decision === 'approve') {
        tx.update(userRef, {
          idVerified: true,
          idVerificationStatus: 'verified',
          idVerificationReviewedAt: FieldValue.serverTimestamp(),
          idVerificationReviewedBy: adminUid,
          idVerificationRejectionReason: FieldValue.delete(),
          idVerifiedAt: FieldValue.serverTimestamp(),
        });
      } else {
        tx.update(userRef, {
          idVerified: false,
          idVerificationStatus: 'rejected',
          idVerificationReviewedAt: FieldValue.serverTimestamp(),
          idVerificationReviewedBy: adminUid,
          idVerificationRejectionReason: (rejectionReason as string).trim(),
          idVerifiedAt: FieldValue.delete(),
        });
      }
    });

    // Recompute trust score to reflect verified status update
    try {
      await recomputeTrustScore(db, userId);
    } catch (err) {
      logger.warn(
        'Failed to recompute trust score after ID verification (non-fatal)',
        {
          userId,
          err,
        },
      );
    }

    // Log admin action audit event
    try {
      await db.collection('adminActions').add({
        adminId: adminUid,
        targetUserId: userId,
        actionType:
          decision === 'approve'
            ? 'id_verification_approved'
            : 'id_verification_rejected',
        reason:
          decision === 'reject'
            ? (rejectionReason as string).trim()
            : 'ID document verified by administrator',
        timestamp: FieldValue.serverTimestamp(),
        metadata: {
          idImagePath: filePath,
          documentExists: fileExists,
        },
      });
    } catch (err) {
      logger.warn('Failed to write adminAction audit event (non-fatal)', {
        err,
      });
    }

    // Site-wide activity log
    try {
      const adminName = await safeDisplayName(db, adminUid, 'An admin');
      const targetName = await safeDisplayName(db, userId, 'A volunteer');
      await appendActivityLog(db, {
        eventType: 'moderation_action',
        description:
          decision === 'approve'
            ? `${adminName} approved ID verification for ${targetName}`
            : `${adminName} rejected ID verification for ${targetName}: ${(rejectionReason as string).trim()}`,
        userId: adminUid,
      });
    } catch (err) {
      logger.warn('Failed to write activity log (non-fatal)', { err });
    }

    return { success: true, userId, decision };
  },
);

export const submitIdVerification = onCall(
  { region: REGION },
  async (request): Promise<{ success: boolean }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const uid = request.auth.uid;
    const db = getFirestore();
    await checkActiveStatus(db, uid);

    const bucket = getStorage().bucket();
    const filePath = `users/${uid}/id-image`;
    const [exists] = await bucket.file(filePath).exists();
    if (!exists) {
      throw new HttpsError(
        'failed-precondition',
        'No ID document found in storage. Please upload an image first.',
      );
    }

    const userRef = db.collection('users').doc(uid);
    await userRef.update({
      idImagePath: filePath,
      idVerificationStatus: 'pending',
      idVerificationSubmittedAt: FieldValue.serverTimestamp(),
      idVerificationRejectionReason: FieldValue.delete(),
    });

    return { success: true };
  },
);
