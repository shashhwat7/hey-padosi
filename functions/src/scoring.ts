// Shared matching/scoring code reused by:
//   - rankNearbyVolunteers (HTTPS callable, customer-on-demand ranking)
//   - dispatchOffers (Firestore onCreate, server-driven fan-out)
//
// Matching score (from memory-bank/systemPatterns.md):
//   score = 0.30 * distance
//         + 0.25 * skill
//         + 0.20 * trust
//         + 0.15 * availability
//         + 0.10 * pastCompletion
//         - reportPenalty

import { getFirestore, type Timestamp } from 'firebase-admin/firestore';
import { gridDistance } from 'h3-js';

export const H3_DISTANCE_RING_CEILING = 15;
export const MAX_AVAILABLE_USERS_TO_FETCH = 500;

export interface TaskDoc {
  customerId: string;
  category: string;
  title: string;
  requiredSkills: string[];
  location: { lat: number; lng: number; h3Cell: string };
  riskLevel: 'low' | 'medium';
  searchRadiusM: number;
  status: string;
  cancelledVolunteerIds?: string[];
}

export interface UserDoc {
  displayName?: string;
  photoURL?: string;
  roles?: string[];
  skills?: string[];
  availableNow?: boolean;
  lastKnownLocation?: { lat: number; lng: number; h3Cell: string };
  idVerified?: boolean;
  idImagePath?: string;
  trustScore?: number;
  verifiedTaskCount?: number;
  openReportsCount?: number;
  warningsCount?: number;
  banned?: boolean;
  suspendedUntil?: Timestamp;
  accountStatus?: string;
  idVerificationStatus?: string;
}

export interface ScoreBreakdown {
  distance: number;
  skill: number;
  trust: number;
  availability: number;
  pastCompletion: number;
  reportPenalty: number;
  total: number;
}

export interface RankedVolunteer {
  uid: string;
  displayName: string;
  photoURL: string | null;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  distanceM: number;
}

export function isEligible(uid: string, u: UserDoc, task: TaskDoc): boolean {
  if (uid === task.customerId) return false;
  const isBanned = u.accountStatus === 'banned' || u.banned === true;
  const isSuspended =
    u.accountStatus === 'suspended' &&
    u.suspendedUntil &&
    u.suspendedUntil.toMillis() > Date.now();
  if (isBanned || isSuspended) return false;
  if (!u.roles?.includes('volunteer')) return false;
  if (!u.lastKnownLocation) return false;
  if (!u.skills || u.skills.length === 0) return false;
  const overlap = u.skills.some((s) => task.requiredSkills.includes(s));
  if (!overlap) return false;
  if (task.riskLevel === 'medium' && !u.idVerified) return false;
  const distM = haversineM(
    u.lastKnownLocation.lat,
    u.lastKnownLocation.lng,
    task.location.lat,
    task.location.lng,
  );
  if (distM > task.searchRadiusM) return false;
  return true;
}

export function score(u: UserDoc, task: TaskDoc): ScoreBreakdown {
  const ringDist = u.lastKnownLocation
    ? gridDistance(task.location.h3Cell, u.lastKnownLocation.h3Cell)
    : -1;
  const distance =
    ringDist >= 0 ? Math.max(0, 1 - ringDist / H3_DISTANCE_RING_CEILING) : 0;

  const matched =
    u.skills?.filter((s) => task.requiredSkills.includes(s)).length ?? 0;
  const required = task.requiredSkills.length || 1;
  const skill = matched / required;

  const trust = (u.trustScore ?? 30) / 100;
  const availability = 1;

  const verified = u.verifiedTaskCount ?? 0;
  const pastCompletion = Math.min(1, 0.2 + verified * 0.05);

  const reports = u.openReportsCount ?? 0;
  const warnings = u.warningsCount ?? 0;
  const reportPenalty = Math.min(0.5, reports * 0.1 + warnings * 0.15);

  const total =
    0.3 * distance +
    0.25 * skill +
    0.2 * trust +
    0.15 * availability +
    0.1 * pastCompletion -
    reportPenalty;

  return {
    distance,
    skill,
    trust,
    availability,
    pastCompletion,
    reportPenalty,
    total,
  };
}

export function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function filterCandidatesWithExclusionsPure(
  candidates: Array<{ uid: string; score: number }>,
  excludedUids?: Set<string> | string[],
): Array<{ uid: string; score: number }> {
  if (!excludedUids) return candidates;
  const set = excludedUids instanceof Set ? excludedUids : new Set(excludedUids);
  return candidates.filter((c) => !set.has(c.uid));
}

// Pulls available volunteers, post-filters and scores them, returns
// ranked descending. Shared by both callable + trigger.
export async function rankForTask(
  task: TaskDoc,
  excludedUids?: Set<string> | string[],
): Promise<RankedVolunteer[]> {
  const db = getFirestore();

  const exclusionSet =
    excludedUids instanceof Set
      ? new Set(excludedUids)
      : new Set(excludedUids ?? []);

  if (Array.isArray(task.cancelledVolunteerIds)) {
    for (const uid of task.cancelledVolunteerIds) {
      if (typeof uid === 'string' && uid.length > 0) {
        exclusionSet.add(uid);
      }
    }
  }

  // Query all blocks involving the customer to filter out mutual blocks
  const blockedUserIds = new Set<string>();
  const [blocksSnapA, blocksSnapB] = await Promise.all([
    db.collection('blocks').where('userA', '==', task.customerId).get(),
    db.collection('blocks').where('userB', '==', task.customerId).get(),
  ]);
  blocksSnapA.forEach((doc) => {
    const data = doc.data() as { userB: string };
    blockedUserIds.add(data.userB);
  });
  blocksSnapB.forEach((doc) => {
    const data = doc.data() as { userA: string };
    blockedUserIds.add(data.userA);
  });

  const availSnap = await db
    .collection('users')
    .where('availableNow', '==', true)
    .limit(MAX_AVAILABLE_USERS_TO_FETCH)
    .get();

  const candidates = availSnap.docs
    .map((d) => ({ uid: d.id, doc: d.data() as UserDoc }))
    .filter(
      ({ uid, doc }) =>
        isEligible(uid, doc, task) &&
        !blockedUserIds.has(uid) &&
        !exclusionSet.has(uid),
    );

  return candidates
    .map(({ uid, doc: u }) => {
      const breakdown = score(u, task);
      const distM = u.lastKnownLocation
        ? haversineM(
            u.lastKnownLocation.lat,
            u.lastKnownLocation.lng,
            task.location.lat,
            task.location.lng,
          )
        : Number.NaN;
      return {
        uid,
        displayName: u.displayName ?? '',
        photoURL: u.photoURL ?? null,
        score: breakdown.total,
        scoreBreakdown: breakdown,
        distanceM: Math.round(distM),
      } satisfies RankedVolunteer;
    })
    .sort((a, b) => b.score - a.score);
}

// Seam: Corridor matching ranker accepting a set of corridor H3 cells
export async function rankForCorridor(
  task: TaskDoc,
  _corridorH3Cells: Set<string>,
): Promise<RankedVolunteer[]> {
  const allRanked = await rankForTask(task);
  return allRanked.filter((_v) => {
    return true; // Corridor matching filtering happens during task fanout
  });
}
