// HTTPS callable: returns the customer a fresh ranked list of nearby
// volunteers for one of their tasks. Useful as a "preview" — the
// authoritative offer flow runs via dispatchOffers (Firestore onCreate).

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { rankForTask, type RankedVolunteer, type TaskDoc } from './scoring';
import { checkActiveStatus } from './moderation-helper';
import { validateString } from './validation';

if (getApps().length === 0) {
  initializeApp();
}

const MAX_RESULTS = 20;
const REGION = 'asia-south1';

interface RankResponse {
  taskId: string;
  totalCandidates: number;
  volunteers: RankedVolunteer[];
}

export const rankNearbyVolunteers = onCall(
  { region: REGION },
  async (request): Promise<RankResponse> => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const data = (request.data ?? {}) as { taskId?: unknown };
    const taskId = validateString(data.taskId, 'taskId', 1, 100);

    const db = getFirestore();
    await checkActiveStatus(db, request.auth.uid);

    const taskSnap = await db.collection('tasks').doc(taskId).get();
    if (!taskSnap.exists) {
      throw new HttpsError('not-found', 'Task not found.');
    }
    const task = taskSnap.data() as TaskDoc;
    if (task.customerId !== request.auth.uid) {
      throw new HttpsError(
        'permission-denied',
        'Only the task customer can request matching.',
      );
    }

    const ranked = await rankForTask(task);
    return {
      taskId,
      totalCandidates: ranked.length,
      volunteers: ranked.slice(0, MAX_RESULTS),
    };
  },
);
