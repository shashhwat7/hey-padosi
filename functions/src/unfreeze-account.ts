// HTTPS callable: unfreezeAccount
// Allows a user to acknowledge a warning freeze screen ("I understand") and resume normal app access.

import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, type Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

export const unfreezeAccount = onCall(
  { region: REGION },
  async (request): Promise<{ success: boolean }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const uid = request.auth.uid;
    const db = getFirestore();

    const userRef = db.collection('users').doc(uid);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'User not found.');
    }

    const userData = userSnap.data() || {};
    const accountStatus = userData.accountStatus ?? 'active';
    const isBanned = accountStatus === 'banned' || userData.banned === true;
    if (isBanned) {
      throw new HttpsError(
        'permission-denied',
        'Banned accounts cannot unfreeze.',
      );
    }

    if (accountStatus === 'suspended') {
      const suspendedUntil = userData.suspendedUntil as Timestamp | undefined;
      if (!suspendedUntil || suspendedUntil.toMillis() > Date.now()) {
        throw new HttpsError(
          'permission-denied',
          'Suspended accounts cannot unfreeze.',
        );
      }
    }

    if (userData.frozenAt === undefined) {
      throw new HttpsError(
        'failed-precondition',
        'Your account is not currently frozen.',
      );
    }

    await userRef.update({
      freezeAcknowledgedAt: FieldValue.serverTimestamp(),
      frozenAt: FieldValue.delete(),
      frozenReason: FieldValue.delete(),
    });

    return { success: true };
  },
);
