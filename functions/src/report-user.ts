import { getApps, initializeApp } from 'firebase-admin/app';
import {
  FieldValue,
  getFirestore,
  type Timestamp,
} from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { appendActivityLog, safeDisplayName } from './activity-log';
import { validateOptionalString, validateString } from './validation';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';
const REPORT_WINDOW_AFTER_COMPLETION_MS = 24 * 60 * 60 * 1000;

export const reportUser = onCall(
  { region: REGION },
  async (request): Promise<{ reportId: string }> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = (request.data ?? {}) as {
      reportedUserId?: unknown;
      taskId?: unknown;
      reason?: unknown;
      details?: unknown;
      messageRef?: unknown;
    };

    const reportedUserId = validateString(
      data.reportedUserId,
      'reportedUserId',
      1,
      100,
    );
    const taskId = validateString(data.taskId, 'taskId', 1, 100);
    const reason = validateString(data.reason, 'reason', 1, 100);
    const details = validateOptionalString(data.details, 'details', 500) ?? '';
    const messageRef = data.messageRef;

    // Optional message-level report (M7). When present it must point at a
    // message inside this task's chat: chats/{taskId}/messages/{msgId}.
    const expectedMessagePrefix = `chats/${String(taskId)}/messages/`;
    if (
      messageRef !== undefined &&
      (typeof messageRef !== 'string' ||
        messageRef.length === 0 ||
        messageRef.length > 300 ||
        !messageRef.startsWith(expectedMessagePrefix))
    ) {
      throw new HttpsError(
        'invalid-argument',
        'messageRef must reference a message in this task chat.',
      );
    }

    const reporterId = request.auth.uid;
    if (reporterId === reportedUserId) {
      throw new HttpsError('invalid-argument', 'You cannot report yourself.');
    }

    const db = getFirestore();
    await checkActiveStatus(db, reporterId);

    // Validate reporter has a completed or in-progress task with the reported user
    const taskSnap = await db.collection('tasks').doc(taskId).get();
    if (!taskSnap.exists) {
      throw new HttpsError('not-found', 'Task not found.');
    }
    const task = taskSnap.data() as {
      customerId?: string;
      acceptedVolunteerId?: string;
      status?: string;
      completedAt?: Timestamp;
    };

    const isCustomerReporter =
      task.customerId === reporterId &&
      task.acceptedVolunteerId === reportedUserId;
    const isVolunteerReporter =
      task.acceptedVolunteerId === reporterId &&
      task.customerId === reportedUserId;

    if (!isCustomerReporter && !isVolunteerReporter) {
      throw new HttpsError(
        'permission-denied',
        'You must have a shared task with this user to report them.',
      );
    }

    // Reporting window — must be inside the task lifecycle (accepted /
    // in_progress) OR within 24h of completion.
    const allowedStatuses = ['accepted', 'in_progress', 'completed'];
    if (!task.status || !allowedStatuses.includes(task.status)) {
      throw new HttpsError(
        'failed-precondition',
        'Reports are only allowed during the task or within 24 hours of completion.',
      );
    }
    if (task.status === 'completed') {
      const completedAtMs = task.completedAt?.toMillis();
      if (
        !completedAtMs ||
        Date.now() - completedAtMs > REPORT_WINDOW_AFTER_COMPLETION_MS
      ) {
        throw new HttpsError(
          'failed-precondition',
          'The 24-hour reporting window for this task has closed.',
        );
      }
    }

    // Volunteer side can only report once the Start OTP has been verified
    // (status flips from 'accepted' to 'in_progress'). Customer can report
    // anytime post-acceptance, so 'accepted' stays allowed for them.
    if (isVolunteerReporter && task.status === 'accepted') {
      throw new HttpsError(
        'failed-precondition',
        'You can only report the customer after the task has started (Start OTP verified).',
      );
    }

    // Create report document. Duplicate prevention + uniqueReporterCount
    // computation happen inside the transaction so concurrent invocations
    // converge on the same count.
    const reportRef = db.collection('reports').doc();
    const reportId = reportRef.id;
    const reportsCol = db.collection('reports');

    await db.runTransaction(async (tx) => {
      // READ PHASE — all reads must complete before any writes in a
      // Firestore transaction.

      // (a) Has this same reporter already reported this same target on
      // this same task? If so, neutral failed-precondition.
      const existingSnap = await tx.get(
        reportsCol
          .where('reporterUid', '==', reporterId)
          .where('reportedUid', '==', reportedUserId)
          .where('taskId', '==', taskId)
          .limit(1),
      );
      if (!existingSnap.empty) {
        throw new HttpsError(
          'already-exists',
          'You have already submitted a report for this user on this task.',
        );
      }

      // (b) Pull sibling reports against the same (reportedUid, taskId)
      // so we can recompute the unique-reporter count.
      const siblingsSnap = await tx.get(
        reportsCol
          .where('reportedUid', '==', reportedUserId)
          .where('taskId', '==', taskId),
      );
      const uniqueReporters = new Set<string>();
      siblingsSnap.forEach((d) => {
        const data = d.data() as { reporterUid?: string };
        if (data.reporterUid) uniqueReporters.add(data.reporterUid);
      });
      uniqueReporters.add(reporterId);
      const uniqueReporterCount = uniqueReporters.size;

      // WRITE PHASE.
      tx.set(reportRef, {
        reporterUid: reporterId,
        reportedUid: reportedUserId,
        taskId,
        reason,
        details,
        ...(typeof messageRef === 'string' ? { messageRef } : {}),
        status: 'pending',
        uniqueReporterCount,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Keep sibling counts in sync so the admin queue surfaces a
      // consistent number regardless of which doc is shown.
      siblingsSnap.forEach((d) => {
        tx.update(d.ref, { uniqueReporterCount });
      });

      // Increment pendingReports on the reported user doc.
      const userRef = db.collection('users').doc(reportedUserId);
      tx.update(userRef, {
        pendingReports: FieldValue.increment(1),
        openReportsCount: FieldValue.increment(1), // for compatibility with scoring.ts
      });
    });

    // Activity log — append outside the transaction. The transaction
    // already succeeded (we have a reportId), so a log failure won't
    // unwind the report. safeDisplayName falls back gracefully if the
    // reported user doc is missing.
    const reportedName = await safeDisplayName(db, reportedUserId, 'a user');
    await appendActivityLog(db, {
      eventType: 'report_submitted',
      description: `Report submitted against ${reportedName} (${reason})`,
      userId: reporterId,
      taskId,
    });

    // Mark the reported chat message (M7) so the reporter's UI can show it
    // as reported. Admin SDK bypasses message immutability rules. Best-effort.
    if (typeof messageRef === 'string') {
      try {
        await db.doc(messageRef).update({
          reportedBy: FieldValue.arrayUnion(reporterId),
        });
      } catch {
        /* message may have been removed; report itself already recorded */
      }
    }

    return { reportId };
  },
);
