// HTTPS callable: suggestNextTasks
//
// Surface up to 2 nearby open tasks to a volunteer immediately after they
// complete a task (verifyEndOtp).
//
// Reuses scoring.ts logic with the volunteer's proxy location set to the
// location of the just-completed task.
//
// Enforces block filtering, dual-role exclusions, risk/skill eligibility,
// and score thresholding. Prepares offer documents for candidate tasks so
// accepting via acceptOffer succeeds transactionally.

import { getApps, initializeApp } from 'firebase-admin/app';
import {
  FieldValue,
  getFirestore,
  type Timestamp,
} from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { checkActiveStatus } from './moderation-helper';
import { safeDisplayName } from './activity-log';
import { validateString } from './validation';
import {
  haversineM,
  isEligible,
  score,
  type ScoreBreakdown,
  type TaskDoc,
  type UserDoc,
} from './scoring';

if (getApps().length === 0) {
  initializeApp();
}

const REGION = 'asia-south1';

export interface SuggestedTask {
  taskId: string;
  title: string;
  category: string;
  customerName: string;
  distanceM: number;
  createdAt: number;
  score: number;
  scoreBreakdown: ScoreBreakdown;
}

export interface SuggestNextTasksResponse {
  tasks: SuggestedTask[];
}

export const suggestNextTasks = onCall(
  { region: REGION },
  async (request): Promise<SuggestNextTasksResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }

    const data = (request.data ?? {}) as { taskId?: unknown };
    const completedTaskId = validateString(data.taskId, 'taskId', 1, 100);

    const volunteerUid = request.auth.uid;
    const db = getFirestore();

    await checkActiveStatus(db, volunteerUid);

    // 1. Fetch completed task for location proxy & caller verification
    const completedTaskSnap = await db
      .collection('tasks')
      .doc(completedTaskId)
      .get();
    if (!completedTaskSnap.exists) {
      throw new HttpsError('not-found', 'Completed task not found.');
    }

    const completedTask = completedTaskSnap.data() as TaskDoc & {
      acceptedVolunteerId?: string;
    };

    if (completedTask.acceptedVolunteerId !== volunteerUid) {
      throw new HttpsError(
        'permission-denied',
        'You were not the assigned volunteer for this task.',
      );
    }

    // Fail closed if completed task location is missing or invalid (§6.5)
    if (
      !completedTask.location ||
      typeof completedTask.location.lat !== 'number' ||
      typeof completedTask.location.lng !== 'number' ||
      !completedTask.location.h3Cell
    ) {
      return { tasks: [] };
    }

    // 2. Fetch volunteer profile to build synthetic UserDoc with proxy location
    const userSnap = await db.collection('users').doc(volunteerUid).get();
    if (!userSnap.exists) {
      return { tasks: [] };
    }
    const uDoc = userSnap.data() as UserDoc;
    const syntheticUser: UserDoc = {
      ...uDoc,
      lastKnownLocation: completedTask.location,
    };

    // 3. Query mutual blocks involving volunteerUid (§6.4)
    const blockedUserIds = new Set<string>();
    const [blocksSnapA, blocksSnapB] = await Promise.all([
      db.collection('blocks').where('userA', '==', volunteerUid).get(),
      db.collection('blocks').where('userB', '==', volunteerUid).get(),
    ]);
    blocksSnapA.forEach((d) => {
      const bData = d.data() as { userB: string };
      blockedUserIds.add(bData.userB);
    });
    blocksSnapB.forEach((d) => {
      const bData = d.data() as { userA: string };
      blockedUserIds.add(bData.userA);
    });

    // 4. Query open candidate tasks searching for volunteers
    const openTasksSnap = await db
      .collection('tasks')
      .where('status', '==', 'searching')
      .get();

    interface CandidateScored {
      taskId: string;
      task: TaskDoc;
      score: number;
      scoreBreakdown: ScoreBreakdown;
      distanceM: number;
    }

    const candidates: CandidateScored[] = [];

    for (const docSnap of openTasksSnap.docs) {
      const candidateTaskId = docSnap.id;
      if (candidateTaskId === completedTaskId) continue;

      const candidate = docSnap.data() as TaskDoc & {
        createdAt?: Timestamp;
        expiresAt?: Timestamp;
      };

      // Expiry check: exclude tasks whose expiry window has elapsed
      const expiresAtMs = candidate.expiresAt?.toMillis?.();
      if (typeof expiresAtMs === 'number' && Date.now() >= expiresAtMs) continue;

      // Dual-role check (§6.2): volunteer cannot be customer of suggested task
      if (candidate.customerId === volunteerUid) continue;

      // Block check (§6.4): exclude tasks from blocked customers
      if (blockedUserIds.has(candidate.customerId)) continue;

      // Exclusion check: volunteer already cancelled for this task
      if (
        Array.isArray(candidate.cancelledVolunteerIds) &&
        candidate.cancelledVolunteerIds.includes(volunteerUid)
      ) {
        continue;
      }

      // Eligibility check using scoring.ts logic
      if (!isEligible(volunteerUid, syntheticUser, candidate)) continue;

      const scoreBreakdown = score(syntheticUser, candidate);
      if (scoreBreakdown.total <= 0) continue; // Minimum score floor

      const distM = haversineM(
        syntheticUser.lastKnownLocation!.lat,
        syntheticUser.lastKnownLocation!.lng,
        candidate.location.lat,
        candidate.location.lng,
      );

      candidates.push({
        taskId: candidateTaskId,
        task: candidate,
        score: scoreBreakdown.total,
        scoreBreakdown,
        distanceM: Math.round(distM),
      });
    }

    // 5. Rank descending by total score and select top 2
    candidates.sort((a, b) => b.score - a.score);
    const top2 = candidates.slice(0, 2);

    if (top2.length === 0) {
      return { tasks: [] };
    }

    // 6. Ensure offer docs exist and prepare output payload
    const resultTasks: SuggestedTask[] = [];

    for (const c of top2) {
      const offerRef = db
        .collection('tasks')
        .doc(c.taskId)
        .collection('offers')
        .doc(volunteerUid);
      const offerSnap = await offerRef.get();

      if (offerSnap.exists) {
        const offerData = offerSnap.data() as { state?: string };
        if (offerData.state === 'cancelled' || offerData.state === 'rejected') {
          continue; // Never re-offer to a volunteer who cancelled or rejected
        }
      }

      if (!offerSnap.exists) {
        await offerRef.set({
          volunteerId: volunteerUid,
          taskId: c.taskId,
          customerId: c.task.customerId,
          taskTitle: c.task.title,
          taskCategory: c.task.category,
          taskRiskLevel: c.task.riskLevel,
          displayName: uDoc.displayName ?? '',
          photoURL: uDoc.photoURL ?? null,
          state: 'offered',
          score: c.score,
          scoreBreakdown: c.scoreBreakdown,
          distanceM: c.distanceM,
          offeredAt: FieldValue.serverTimestamp(),
        });
      }

      const customerName = await safeDisplayName(
        db,
        c.task.customerId,
        'Neighbor',
      );

      const candidateRaw = c.task as TaskDoc & { createdAt?: Timestamp };
      const createdAtMs = candidateRaw.createdAt
        ? candidateRaw.createdAt.toMillis()
        : Date.now();

      resultTasks.push({
        taskId: c.taskId,
        title: c.task.title,
        category: c.task.category,
        customerName,
        distanceM: c.distanceM,
        createdAt: createdAtMs,
        score: c.score,
        scoreBreakdown: c.scoreBreakdown,
      });
    }

    return { tasks: resultTasks };
  },
);
