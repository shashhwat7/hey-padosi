import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { appendActivityLog } from './activity-log';
import { validateString } from './validation';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

export const blockUser = onCall(
  { region: REGION },
  async (request): Promise<{ blockId: string }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = (request.data ?? {}) as {
      blockedUserId?: unknown;
    };

    const blockedUserId = validateString(
      data.blockedUserId,
      'blockedUserId',
      1,
      100,
    );

    const callerUid = request.auth.uid;
    if (callerUid === blockedUserId) {
      throw new HttpsError('invalid-argument', 'You cannot block yourself.');
    }

    const db = getFirestore();
    const callerData = await checkActiveStatus(db, callerUid);

    // Verify target user actually exists
    const targetSnap = await db.collection('users').doc(blockedUserId).get();
    if (!targetSnap.exists) {
      throw new HttpsError('not-found', 'Target user does not exist.');
    }
    const targetData = (targetSnap.data() ?? {}) as {
      displayName?: string;
      photoURL?: string;
    };

    // Deterministic mutual block document ID: userA_userB where userA < userB
    const userA = callerUid < blockedUserId ? callerUid : blockedUserId;
    const userB = callerUid < blockedUserId ? blockedUserId : callerUid;
    const blockId = `${userA}_${userB}`;

    const blockRef = db.collection('blocks').doc(blockId);
    const blockSnap = await blockRef.get();

    if (!blockSnap.exists) {
      const userAData = callerUid === userA ? callerData : targetData;
      const userBData = callerUid === userB ? callerData : targetData;

      await blockRef.set({
        userA,
        userB,
        blockedBy: callerUid,
        userANameSnapshot: userAData.displayName ?? '',
        userAPhotoSnapshot: userAData.photoURL ?? null,
        userBNameSnapshot: userBData.displayName ?? '',
        userBPhotoSnapshot: userBData.photoURL ?? null,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Activity log only on actual new block
      const initiatorName =
        (callerUid === userA
          ? userAData.displayName
          : userBData.displayName
        )?.trim() || 'A user';
      const blockedName =
        (callerUid === userA
          ? userBData.displayName
          : userAData.displayName
        )?.trim() || 'a user';
      await appendActivityLog(db, {
        eventType: 'user_blocked',
        description: `${initiatorName} blocked ${blockedName}`,
        userId: callerUid,
      });
    }

    return { blockId };
  },
);
