// Auth context: subscribes to Firebase Auth + the users/{uid} doc.
// Governs: memory-bank/systemPatterns.md (server-authoritative model;
// only owner-scoped fields are exposed on the user doc).
//
// Exposes a discriminated union so callers can pattern-match instead of
// juggling nullable user + doc fields:
//   - 'loading'    : initial auth listener has not fired yet
//   - 'signed-out' : no Firebase user
//   - 'no-doc'     : signed in, but users/{uid} does not exist yet (mid-signup)
//   - 'incomplete' : signed in, doc exists, onboarding (consent or role) missing
//   - 'ready'      : signed in, consent recorded, at least one role set
//
// Strictly no console.log of phone/email/uid/tokens.

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { onAuthStateChanged, type User as FirebaseUser } from 'firebase/auth';
import { doc, onSnapshot, type Timestamp } from 'firebase/firestore';
import { auth, db } from './firebase';

export type Role = 'volunteer' | 'customer' | 'admin';

export interface UserDoc {
  displayName?: string;
  photoURL?: string; // Storage path, NOT a public URL
  bio?: string;
  phoneNumber?: string;
  email?: string;
  roles?: Role[];
  skills?: string[];
  idImagePath?: string; // Storage path; never client-readable
  availableNow?: boolean;
  availabilityUpdatedAt?: Timestamp;
  lastKnownLocation?: {
    lat: number;
    lng: number;
    h3Cell: string; // h3-js resolution 9
    updatedAt: Timestamp;
  };
  consent?: { tcVersion: string; acceptedAt: Timestamp };
  createdAt?: Timestamp;
  accountStatus?: 'active' | 'warned' | 'suspended' | 'banned';
  suspendedUntil?: Timestamp;
  moderationReason?: string;
  frozenAt?: Timestamp;
  frozenReason?: string;
  warningStrikeCount?: number;
  freezeAcknowledgedAt?: Timestamp;
  isAdmin?: boolean;

  points?: number;
  skillPoints?: Record<string, number>;
  verifiedTaskCount?: number;
  verifiedHours?: number;
  trustScore?: number;
  idVerified?: boolean;
  idVerificationStatus?: 'pending' | 'verified' | 'rejected';
  idVerificationSubmittedAt?: Timestamp;
  idVerificationReviewedAt?: Timestamp;
  idVerificationReviewedBy?: string;
  idVerificationRejectionReason?: string;
  idVerifiedAt?: Timestamp;
}

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'error'; user: FirebaseUser; error: Error }
  | { status: 'no-doc'; user: FirebaseUser }
  | { status: 'incomplete'; user: FirebaseUser; userDoc: UserDoc }
  | { status: 'ready'; user: FirebaseUser; userDoc: UserDoc };

const AuthContext = createContext<AuthState>({ status: 'loading' });

export function useAuthState(): AuthState {
  return useContext(AuthContext);
}

function classify(user: FirebaseUser, userDoc: UserDoc | null): AuthState {
  if (!userDoc) return { status: 'no-doc', user };
  const hasConsent = Boolean(userDoc.consent?.acceptedAt);
  const hasRole = (userDoc.roles?.length ?? 0) > 0;
  const hasProfile = Boolean(userDoc.displayName) && Boolean(userDoc.photoURL);
  // Volunteers (or dual-role users) must also have at least one skill set
  // before they count as fully onboarded. Customer-only users skip skills.
  const isVolunteer = userDoc.roles?.includes('volunteer') ?? false;
  const hasSkills = (userDoc.skills?.length ?? 0) > 0;
  const skillsOk = !isVolunteer || hasSkills;
  if (hasConsent && hasRole && hasProfile && skillsOk) {
    return { status: 'ready', user, userDoc };
  }
  return { status: 'incomplete', user, userDoc };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    let unsubscribeDoc: (() => void) | null = null;
    const unsubscribeAuth = onAuthStateChanged(auth(), (user) => {
      unsubscribeDoc?.();
      unsubscribeDoc = null;
      if (!user) {
        setState({ status: 'signed-out' });
        return;
      }
      const ref = doc(db(), 'users', user.uid);
      unsubscribeDoc = onSnapshot(
        ref,
        (snap) => {
          const data = snap.exists() ? (snap.data() as UserDoc) : null;
          setState(classify(user, data));
        },
        (error) => {
          setState({ status: 'error', user, error });
        },
      );
    });
    return () => {
      unsubscribeDoc?.();
      unsubscribeAuth();
    };
  }, []);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
