import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

/**
 * Checks if a user's account is active.
 * Throws not-found if the profile does not exist.
 * Throws permission-denied HttpsError if the user is banned (accountStatus or banned flag)
 * or suspended (and the suspension has not expired).
 * Returns the fetched userData document data for reuse.
 */
export async function checkActiveStatus(
  db: FirebaseFirestore.Firestore,
  userId: string,
): Promise<FirebaseFirestore.DocumentData> {
  const userRef = db.collection('users').doc(userId);
  const userSnap = await userRef.get();

  if (!userSnap.exists) {
    throw new HttpsError('not-found', 'User profile not found.');
  }

  const userData = userSnap.data() || {};
  const accountStatus = userData.accountStatus ?? 'active';
  const isBanned = accountStatus === 'banned' || userData.banned === true;

  if (isBanned) {
    throw new HttpsError(
      'permission-denied',
      'Your account has been permanently banned.',
    );
  }

  if (accountStatus === 'suspended') {
    const suspendedUntil = userData.suspendedUntil as Timestamp | undefined;
    if (!suspendedUntil || suspendedUntil.toMillis() > Date.now()) {
      const dateStr = suspendedUntil
        ? suspendedUntil.toDate().toLocaleDateString()
        : 'further notice';
      throw new HttpsError(
        'permission-denied',
        `Your account is suspended until ${dateStr}.`,
      );
    }
  }

  return userData;
}

/**
 * Requires that the user possesses the 'volunteer' role.
 */
export function requireVolunteerRole(
  userData: FirebaseFirestore.DocumentData,
): void {
  const roles = userData.roles as string[] | undefined;
  if (!Array.isArray(roles) || !roles.includes('volunteer')) {
    throw new HttpsError(
      'permission-denied',
      'This operation requires a volunteer account.',
    );
  }
}

/**
 * Requires that the user possesses administrative privileges.
 */
export function requireAdminRole(
  userData: FirebaseFirestore.DocumentData,
): void {
  if (userData.isAdmin !== true) {
    throw new HttpsError(
      'permission-denied',
      'Only administrators can perform this action.',
    );
  }
}
