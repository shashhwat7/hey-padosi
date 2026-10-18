// HTTPS callable: unblockUser
//
// Allows a user to unblock a user they previously blocked.
// Verifies caller identity and blockedBy field on the block doc before deletion.

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { appendActivityLog, safeDisplayName } from './activity-log';
import { validateString } from './validation';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

export const unblockUser = onCall(
  { region: REGION },
  async (request): Promise<{ success: boolean; blockId: string }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }

    const data = (request.data ?? {}) as { blockedUserId?: unknown };
    const blockedUserId = validateString(
      data.blockedUserId,
      'blockedUserId',
      1,
      100,
    );

    const callerUid = request.auth.uid;
    if (callerUid === blockedUserId) {
      throw new HttpsError('invalid-argument', 'You cannot unblock yourself.');
    }

    const db = getFirestore();

    await checkActiveStatus(db, callerUid);

    // Deterministic block document ID: userA_userB where userA < userB
    const userA = callerUid < blockedUserId ? callerUid : blockedUserId;
    const userB = callerUid < blockedUserId ? blockedUserId : callerUid;
    const blockId = `${userA}_${userB}`;

    const blockRef = db.collection('blocks').doc(blockId);
    const blockSnap = await blockRef.get();

    if (!blockSnap.exists) {
      throw new HttpsError('not-found', 'Block relationship not found.');
    }

    const blockData = blockSnap.data() as { blockedBy?: string };
    if (blockData.blockedBy !== callerUid) {
      throw new HttpsError(
        'permission-denied',
        'You can only unblock users you blocked.',
      );
    }

    await blockRef.delete();

    const callerName = await safeDisplayName(db, callerUid, 'A user');
    const blockedName = await safeDisplayName(db, blockedUserId, 'a user');

    await appendActivityLog(db, {
      eventType: 'user_unblocked',
      description: `${callerName} unblocked ${blockedName}`,
      userId: callerUid,
    });

    return { success: true, blockId };
  },
);
