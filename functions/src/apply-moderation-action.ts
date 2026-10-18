import { getApps, initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore, Timestamp } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { recomputeTrustScore } from './recompute-trust-score';
import { appendActivityLog, safeDisplayName } from './activity-log';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

export const applyModerationAction = onCall(
  { region: REGION },
  async (request): Promise<{ success: boolean }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const adminUid = request.auth.uid;
    const db = getFirestore();

    // Verify admin role
    const adminSnap = await db.collection('users').doc(adminUid).get();
    if (!adminSnap.exists || adminSnap.data()?.isAdmin !== true) {
      throw new HttpsError(
        'permission-denied',
        'Only administrators can perform moderation actions.',
      );
    }

    const data = (request.data ?? {}) as {
      userId?: unknown;
      action?: unknown;
      reason?: unknown;
      durationDays?: unknown;
      reportId?: unknown;
    };

    const userId = data.userId;
    const action = data.action;
    const reason = data.reason;
    const durationDays = data.durationDays;
    const reportId = data.reportId;

    if (typeof userId !== 'string' || userId.length === 0) {
      throw new HttpsError('invalid-argument', 'userId is required.');
    }
    if (
      typeof action !== 'string' ||
      !['warn', 'suspend', 'ban', 'dismiss'].includes(action)
    ) {
      throw new HttpsError(
        'invalid-argument',
        'action must be warn, suspend, ban, or dismiss.',
      );
    }
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new HttpsError('invalid-argument', 'reason is required.');
    }

    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'User not found.');
    }

    // Determine state changes
    const userUpdate: Record<string, unknown> = {};

    if (action === 'warn') {
      userUpdate.accountStatus = 'warned';
      userUpdate.moderationReason = reason;
      userUpdate.warningsCount = FieldValue.increment(1);
      userUpdate.reportPenalty = FieldValue.increment(0.15);
    } else if (action === 'suspend') {
      if (typeof durationDays !== 'number' || durationDays <= 0) {
        throw new HttpsError(
          'invalid-argument',
          'durationDays must be a positive number for suspension.',
        );
      }
      userUpdate.accountStatus = 'suspended';
      userUpdate.suspendedUntil = Timestamp.fromMillis(
        Date.now() + durationDays * 24 * 60 * 60 * 1000,
      );
      userUpdate.moderationReason = reason;
      userUpdate.reportPenalty = FieldValue.increment(0.25);
    } else if (action === 'ban') {
      userUpdate.accountStatus = 'banned';
      userUpdate.banned = true;
      userUpdate.moderationReason = reason;
      // bannedAt anchors the 30-day permanent-purge window used by
      // scheduledPurgeBannedUsers. Set only when the user is freshly
      // banned (re-banning resets the clock, which is the desired UX).
      userUpdate.bannedAt = FieldValue.serverTimestamp();
    } else if (action === 'dismiss') {
      userUpdate.accountStatus = 'active';
      userUpdate.banned = FieldValue.delete();
      userUpdate.suspendedUntil = FieldValue.delete();
      userUpdate.moderationReason = FieldValue.delete();
      userUpdate.bannedAt = FieldValue.delete();
    }

    // A pending report is consumed iff we were given a reportId (any action,
    // including dismiss). Plain "reactivate" via UserLookup has no reportId
    // and must not touch the counter. Computed once here so we don't write
    // pendingReports twice in the batch below.
    const consumesPendingReport =
      typeof reportId === 'string' && reportId.length > 0;
    if (consumesPendingReport) {
      const currentPending = userSnap.data()?.pendingReports ?? 0;
      userUpdate.pendingReports = Math.max(0, currentPending - 1);
    }

    // Update in a transaction or write batch
    const batch = db.batch();
    batch.update(userRef, userUpdate);

    // If suspending or banning, check for and handle active task reassignments
    if (action === 'suspend' || action === 'ban') {
      const activeTasksSnap = await db
        .collection('tasks')
        .where('acceptedVolunteerId', '==', userId)
        .where('status', 'in', ['accepted', 'in_progress'])
        .get();

      for (const taskDoc of activeTasksSnap.docs) {
        batch.update(taskDoc.ref, {
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
          cancelledVolunteerIds: FieldValue.arrayUnion(userId),
        });

        // Mark volunteer's offer doc as cancelled so they are excluded from re-dispatch
        const volunteerOfferRef = taskDoc.ref.collection('offers').doc(userId);
        batch.set(
          volunteerOfferRef,
          {
            state: 'cancelled',
            respondedAt: FieldValue.serverTimestamp(),
          },
          { merge: true },
        );

        // Log audit event for task update
        const eventRef = taskDoc.ref.collection('events').doc();
        batch.set(eventRef, {
          type: 'reassigned',
          actorUid: adminUid,
          at: FieldValue.serverTimestamp(),
          payload: {
            reason: `Volunteer ${userId} was ${action}ed by administrator.`,
            previousVolunteerId: userId,
          },
        });
      }
    }

    // Add moderation log entry
    const logRef = userRef.collection('moderationLog').doc();
    batch.set(logRef, {
      action,
      reason,
      adminId: adminUid,
      timestamp: FieldValue.serverTimestamp(),
    });

    // Write to global adminActions collection as well
    const adminActionRef = db.collection('adminActions').doc();
    batch.set(adminActionRef, {
      adminUid,
      targetUid: userId,
      action,
      reason,
      relatedReportId: reportId ?? null,
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: action === 'suspend' ? userUpdate.suspendedUntil : null,
    });

    // Update report status if applicable. (pendingReports decrement was
    // already folded into userUpdate above via consumesPendingReport.)
    if (consumesPendingReport) {
      const reportRef = db.collection('reports').doc(reportId as string);
      const reportStatus = action === 'dismiss' ? 'dismissed' : 'actioned';
      batch.update(reportRef, {
        status: reportStatus,
        adminUid,
        actionedAt: FieldValue.serverTimestamp(),
        adminNote: reason,
      });
    }

    await batch.commit();

    // Revoke cleanup: when a previously-banned user is reactivated, wipe
    // any in-flight tasks they posted as customer so nothing is left
    // dangling under their identity. Completed / cancelled / expired
    // tasks are preserved (audit). Volunteer-side active tasks were
    // already detached and re-queued at ban time (block above), so no
    // additional handling is needed for those here.
    const wasBanned = userSnap.data()?.accountStatus === 'banned';
    if (action === 'dismiss' && wasBanned) {
      const orphanSnap = await db
        .collection('tasks')
        .where('customerId', '==', userId)
        .where('status', 'in', ['searching', 'accepted', 'in_progress'])
        .get();
      // recursiveDelete walks subcollections (offers, events). It is not
      // a single atomic write — partial failure would leave debris, but
      // for a small per-user fan-out (typically <10 docs) the simplicity
      // win outweighs the cost of building a manual cascading batch.
      await Promise.all(orphanSnap.docs.map((d) => db.recursiveDelete(d.ref)));
    }

    // Recompute trust score for volunteer targets
    const roles = userSnap.data()?.roles as string[] | undefined;
    if (roles?.includes('volunteer')) {
      await recomputeTrustScore(db, userId);
    }

    // Activity log — action-specific phrasing; never include UIDs.
    const targetName = await safeDisplayName(db, userId, 'a user');
    const adminName = await safeDisplayName(db, adminUid, 'Admin');
    const verb =
      action === 'warn'
        ? 'warned'
        : action === 'suspend'
          ? 'suspended'
          : action === 'ban'
            ? 'banned'
            : 'reactivated';
    await appendActivityLog(db, {
      eventType: 'moderation_action',
      description: `${adminName} ${verb} ${targetName}`,
      userId: adminUid,
    });

    return { success: true };
  },
);
