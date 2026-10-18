// VolunteerDashboard — Reimaged volunteer dashboard adhering strictly to
// the customer design system (#fafaf8 background, green gradient hero,
// #ececea rounded cards, floating bottom nav pill).
//
// Responsibilities:
//   - Top bar with Hey Padosi logo + account menu
//   - Green gradient Hero Card with Karma Points, Trust Score, and Completions
//   - Skill points pills
//   - "Available right now" toggle switch with geolocation & status text
//   - "Offers for you" section with Accept/Reject actions & empty state
//   - "Nearby requests near you" section for open tasks with empty state
//   - "Tasks you've accepted" section
//   - Profile screen with details & sign out button
//   - Floating bottom nav pill (Dashboard / Profile)

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { signOut } from 'firebase/auth';
import {
  collection,
  collectionGroup,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  type Timestamp,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { getDownloadURL, ref as storageRef, uploadBytes } from 'firebase/storage';
import { latLngToCell } from 'h3-js';
import { Link, useNavigate } from 'react-router-dom';
import { auth, db, functions, storage } from '../lib/firebase';
import type { UserDoc } from '../lib/auth-context';
import { getCategory, getSkillLabel } from '../lib/catalog';
import { GeolocationError, getCurrentLocation } from '../lib/geolocation';
import { BlockedUsersList } from './BlockedUsersList';
import { DeparturePromptModal } from './DeparturePromptModal';
import { KarmaBadge, TrustScorePill, HowTrustWorksModal } from './KarmaBadge';
import { TaskLocationPicker } from './TaskLocationPicker';
import { Logo } from './Logo';
import { RoleSwitcher } from './RoleSwitcher';
import { CrossRoleBanner } from './CrossRoleBanner';
import type { ActiveRole } from '../lib/use-active-role';
import {
  calculateRouteSlack,
  createDepartureEvent,
  shouldTriggerDeparturePrompt,
} from '../lib/trail-service/departure-detector';
import { matchTasksInCorridor } from '../lib/trail-service/corridor-matcher';
import {
  getCanonicalRoutes,
  getLocalTrailConsent,
  recordDepartureEvent,
  setTrailConsent,
  wipeAllTrailData,
} from '../lib/trail-service/trail-store';
import type {
  CanonicalRoute,
  TaskSuggestion,
} from '../lib/trail-service/types';

const H3_RESOLUTION = 9;

type TaskStatus =
  | 'searching'
  | 'accepted'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'expired';

interface OfferRow {
  id: string;
  taskId: string;
  taskTitle: string;
  taskCategory: string;
  taskRiskLevel: 'low' | 'medium';
  distanceM: number;
  score: number;
  offeredAt: Timestamp | null;
  estimatedMinutes?: number | undefined;
}

interface NearbyTaskRow {
  id: string;
  title: string;
  category: string;
  riskLevel: 'low' | 'medium';
  createdAt: Timestamp | null;
  estimatedMinutes?: number | undefined;
}

interface AcceptedTaskRow {
  id: string;
  title: string;
  category?: string | undefined;
  status: TaskStatus;
  acceptedAt: Timestamp | null;
  riskLevel: 'low' | 'medium';
  estimatedMinutes?: number | undefined;
}

type ScreenKey = 'dashboard' | 'profile';

interface Props {
  uid: string;
  userDoc: UserDoc;
  activeRole?: ActiveRole;
  onSwitchRole?: (role: ActiveRole) => void;
  isDualRole?: boolean;
}

export function VolunteerDashboard({
  uid,
  userDoc,
  activeRole = 'volunteer',
  onSwitchRole = () => {},
  isDualRole = false,
}: Props) {
  const navigate = useNavigate();
  const [screen, setScreen] = useState<ScreenKey>('dashboard');
  const [offers, setOffers] = useState<OfferRow[]>([]);
  const [nearbyTasks, setNearbyTasks] = useState<NearbyTaskRow[]>([]);
  const [acceptedTasks, setAcceptedTasks] = useState<AcceptedTaskRow[]>([]);
  const [busyTaskIds, setBusyTaskIds] = useState<Set<string>>(new Set());
  const [toggleBusy, setToggleBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeRoutePrompt, setActiveRoutePrompt] =
    useState<CanonicalRoute | null>(null);
  const [promptSuggestions, setPromptSuggestions] = useState<TaskSuggestion[]>(
    [],
  );
  const [promptSlackMinutes, setPromptSlackMinutes] = useState(15);

  const available = userDoc.availableNow ?? false;

  // TrailService Departure Detector check
  useEffect(() => {
    if (!available || !getLocalTrailConsent(uid)) return;

    void getCanonicalRoutes(uid).then((routes) => {
      for (const route of routes) {
        if (shouldTriggerDeparturePrompt(route)) {
          const { slackMinutes } = calculateRouteSlack(route);
          if (slackMinutes >= 5) {
            const openCandidates = nearbyTasks.map((t) => ({
              id: t.id,
              title: t.title,
              category: t.category,
              requiredSkills: [],
              riskLevel: t.riskLevel,
              location: {
                lat: userDoc.lastKnownLocation?.lat ?? 19.076,
                lng: userDoc.lastKnownLocation?.lng ?? 72.8777,
                h3Cell: userDoc.lastKnownLocation?.h3Cell ?? '',
              },
            }));
            const suggestions = matchTasksInCorridor(
              route,
              openCandidates,
              slackMinutes,
              userDoc.skills ?? [],
            );
            setActiveRoutePrompt(route);
            setPromptSuggestions(suggestions);
            setPromptSlackMinutes(slackMinutes);
            break;
          }
        }
      }
    });
  }, [uid, userDoc, available, nearbyTasks]);

  // 1. Subscribe to offers for this volunteer
  useEffect(() => {
    const q = query(
      collectionGroup(db(), 'offers'),
      where('volunteerId', '==', uid),
      where('state', '==', 'offered'),
      orderBy('offeredAt', 'desc'),
      limit(20),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setOffers(
          snap.docs.map((d) => {
            const data = d.data() as {
              taskId: string;
              taskTitle: string;
              taskCategory: string;
              taskRiskLevel: 'low' | 'medium';
              distanceM: number;
              score: number;
              offeredAt: Timestamp | null;
              estimatedMinutes?: number;
            };
            return {
              id: d.id,
              taskId: data.taskId,
              taskTitle: data.taskTitle,
              taskCategory: data.taskCategory,
              taskRiskLevel: data.taskRiskLevel,
              distanceM: data.distanceM,
              score: data.score,
              offeredAt: data.offeredAt,
              estimatedMinutes: data.estimatedMinutes,
            };
          }),
        );
        setLoading(false);
      },
      () => {
        setOffers([]);
        setLoading(false);
      },
    );
    return unsub;
  }, [uid]);

  // 2. Subscribe to open tasks in the neighborhood ('searching' status)
  useEffect(() => {
    const q = query(
      collection(db(), 'tasks'),
      where('status', '==', 'searching'),
      orderBy('createdAt', 'desc'),
      limit(10),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setNearbyTasks(
          snap.docs.map((d) => {
            const data = d.data() as {
              title: string;
              category: string;
              riskLevel: 'low' | 'medium';
              createdAt: Timestamp | null;
              estimatedMinutes?: number;
            };
            return {
              id: d.id,
              title: data.title,
              category: data.category,
              riskLevel: data.riskLevel,
              createdAt: data.createdAt,
              estimatedMinutes: data.estimatedMinutes,
            };
          }),
        );
      },
      () => setNearbyTasks([]),
    );
    return unsub;
  }, []);

  // 3. Subscribe to accepted tasks for this volunteer
  useEffect(() => {
    const q = query(
      collection(db(), 'tasks'),
      where('acceptedVolunteerId', '==', uid),
      orderBy('acceptedAt', 'desc'),
      limit(10),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setAcceptedTasks(
          snap.docs.map((d) => {
            const data = d.data() as {
              title: string;
              category?: string;
              status: TaskStatus;
              acceptedAt: Timestamp | null;
              riskLevel: 'low' | 'medium';
              estimatedMinutes?: number;
            };
            return {
              id: d.id,
              title: data.title,
              category: data.category,
              status: data.status,
              acceptedAt: data.acceptedAt,
              riskLevel: data.riskLevel,
              estimatedMinutes: data.estimatedMinutes,
            };
          }),
        );
      },
      () => setAcceptedTasks([]),
    );
    return unsub;
  }, [uid]);

  async function handleSignOut() {
    await signOut(auth());
    void navigate('/', { replace: true });
  }

  async function toggleAvailability() {
    setError(null);
    const ref = doc(db(), 'users', uid);
    if (available) {
      setToggleBusy(true);
      try {
        await updateDoc(ref, {
          availableNow: false,
          availabilityUpdatedAt: serverTimestamp(),
        });
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Could not update status.',
        );
      } finally {
        setToggleBusy(false);
      }
      return;
    }

    setToggleBusy(true);
    try {
      const loc = await getCurrentLocation();
      const h3Cell = latLngToCell(loc.lat, loc.lng, H3_RESOLUTION);
      await updateDoc(ref, {
        availableNow: true,
        availabilityUpdatedAt: serverTimestamp(),
        lastKnownLocation: {
          lat: loc.lat,
          lng: loc.lng,
          h3Cell,
          updatedAt: serverTimestamp(),
        },
      });
    } catch (err) {
      if (err instanceof GeolocationError) {
        setError(err.userMessage);
      } else {
        setError(
          err instanceof Error ? err.message : 'Could not update status.',
        );
      }
    } finally {
      setToggleBusy(false);
    }
  }

  function markBusy(taskId: string, on: boolean) {
    setBusyTaskIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(taskId);
      else next.delete(taskId);
      return next;
    });
  }

  async function handleAcceptOffer(taskId: string) {
    setError(null);
    markBusy(taskId, true);
    try {
      const fn = httpsCallable<{ taskId: string }, { taskId: string }>(
        functions(),
        'acceptOffer',
      );
      await fn({ taskId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not accept offer.');
    } finally {
      markBusy(taskId, false);
    }
  }

  async function handleRejectOffer(taskId: string) {
    setError(null);
    markBusy(taskId, true);
    try {
      const fn = httpsCallable<{ taskId: string }, { taskId: string }>(
        functions(),
        'rejectOffer',
      );
      await fn({ taskId });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reject offer.');
    } finally {
      markBusy(taskId, false);
    }
  }

  return (
    <main className="min-h-screen bg-[#fafaf8] text-[#131312]">
      <TopBar
        displayName={userDoc.displayName ?? 'Volunteer'}
        email={userDoc.email}
        photoPath={userDoc.photoURL ?? null}
        onSignOut={() => void handleSignOut()}
        activeRole={activeRole}
        onSwitchRole={onSwitchRole}
        isDualRole={isDualRole}
      />
      <CrossRoleBanner
        uid={uid}
        userDoc={userDoc}
        activeRole={activeRole}
        isDualRole={isDualRole}
        onSwitchRole={onSwitchRole}
      />
      {userDoc.accountStatus && userDoc.accountStatus !== 'active' && (
        <div className="mx-auto max-w-7xl px-8 pt-4">
          {userDoc.accountStatus === 'warned' ? (
            <div className="vc-fade-up flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50/90 p-4 text-xs text-amber-900 shadow-xs">
              <svg
                className="h-5 w-5 text-amber-600 shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <div>
                <strong className="font-bold text-amber-950">
                  Community Guidelines Notice (Strike{' '}
                  {userDoc.warningStrikeCount ?? 1}/3)
                </strong>
                <p className="mt-0.5 leading-relaxed text-amber-900">
                  {userDoc.moderationReason
                    ? `Reason: "${userDoc.moderationReason}". `
                    : 'Your account has received a warning for a safety standards violation. '}
                  Please ensure all neighbourhood interactions adhere to our
                  safety standards.
                </p>
              </div>
            </div>
          ) : userDoc.accountStatus === 'suspended' ? (
            <div className="vc-fade-up flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-xs text-red-900 shadow-xs">
              <svg
                className="h-5 w-5 text-red-600 shrink-0 mt-0.5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M5.7 5.7l12.6 12.6" />
              </svg>
              <div>
                <strong className="font-bold text-red-950">
                  Account Temporarily Suspended
                </strong>
                <p className="mt-0.5 leading-relaxed text-red-800">
                  {userDoc.moderationReason
                    ? `Reason: "${userDoc.moderationReason}". `
                    : 'Your account is temporarily restricted from posting or accepting tasks. '}
                  Our safety team reviews accounts to protect community trust.
                </p>
              </div>
            </div>
          ) : null}
        </div>
      )}
      <div className="mx-auto max-w-7xl px-8 pt-6 pb-[124px]">
        {activeRoutePrompt && (
          <DeparturePromptModal
            isOpen={Boolean(activeRoutePrompt)}
            route={activeRoutePrompt}
            suggestions={promptSuggestions}
            slackMinutes={promptSlackMinutes}
            onConfirm={(selectedTaskId) => {
              void (async () => {
                if (activeRoutePrompt) {
                  await recordDepartureEvent(
                    uid,
                    createDepartureEvent(activeRoutePrompt.id, true),
                  );
                }
                setActiveRoutePrompt(null);
                if (selectedTaskId) {
                  void navigate(`/tasks/${selectedTaskId}`);
                }
              })();
            }}
            onDecline={() => {
              void (async () => {
                if (activeRoutePrompt) {
                  await recordDepartureEvent(
                    uid,
                    createDepartureEvent(activeRoutePrompt.id, false),
                  );
                }
                setActiveRoutePrompt(null);
              })();
            }}
          />
        )}
        <div key={screen} className="vc-screen-enter">
          {screen === 'dashboard' && (
            <DashboardScreen
              uid={uid}
              userDoc={userDoc}
              available={available}
              toggleBusy={toggleBusy}
              onToggleAvailability={() => void toggleAvailability()}
              offers={offers}
              busyTaskIds={busyTaskIds}
              onAcceptOffer={(id) => void handleAcceptOffer(id)}
              onRejectOffer={(id) => void handleRejectOffer(id)}
              nearbyTasks={nearbyTasks}
              acceptedTasks={acceptedTasks}
              loading={loading}
              error={error}
            />
          )}
          {screen === 'profile' && (
            <VolunteerProfileScreen
              uid={uid}
              userDoc={userDoc}
              acceptedTasksCount={acceptedTasks.length}
              onSignOut={() => void handleSignOut()}
            />
          )}
        </div>
      </div>
      <BottomNav
        screen={screen}
        offersCount={offers.length}
        onChange={(next) => {
          setScreen(next);
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
      />
    </main>
  );
}

// ----- Top Bar ---------------------------------------------------------

function TopBar({
  displayName,
  email,
  photoPath,
  onSignOut,
  activeRole,
  onSwitchRole,
  isDualRole,
}: {
  displayName: string;
  email: string | undefined;
  photoPath: string | null;
  onSignOut: () => void;
  activeRole: ActiveRole;
  onSwitchRole: (role: ActiveRole) => void;
  isDualRole: boolean;
}) {
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const initial = initialOf(displayName);
  const photoUrl = usePhotoUrl(photoPath);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t) || triggerRef.current?.contains(t)) {
        return;
      }
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-[#ececea] bg-white px-6 sm:px-7">
      <div className="flex items-center gap-3 font-bold tracking-tight">
        <Link to="/app" aria-label="Hey Padosi Home">
          <Logo size="md" />
        </Link>
      </div>
      <div className="flex items-center gap-3">
        <RoleSwitcher
          activeRole={activeRole}
          onSwitchRole={onSwitchRole}
          isDualRole={isDualRole}
        />
        <div className="relative flex items-center text-[13px] text-[#4f4b46]">
          <button
            ref={triggerRef}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label="Account menu"
            onClick={() => setOpen((o) => !o)}
            className="grid h-9 w-9 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-[#ffd28a] to-[#f08a4b] text-xs font-bold text-[#5a2900] ring-2 ring-transparent transition hover:ring-[#1f6f5c]/30 focus:outline-none focus-visible:ring-[#1f6f5c]/40"
          >
            {photoUrl ? (
              <img
                src={photoUrl}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <span aria-hidden="true">{initial}</span>
            )}
          </button>
          {open && (
            <div
              ref={popoverRef}
              role="dialog"
              aria-label="Account"
              className="vc-fade-up absolute right-0 top-[44px] z-50 w-64 overflow-hidden rounded-2xl border border-[#ececea] bg-white shadow-[0_20px_40px_-16px_rgba(20,18,15,0.18)]"
            >
              <div className="flex items-center gap-3 border-b border-[#f3f1ec] px-4 py-4">
                <span className="grid h-12 w-12 flex-shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-[#ffd28a] to-[#f08a4b] text-base font-bold text-[#5a2900]">
                  {photoUrl ? (
                    <img
                      src={photoUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    initial
                  )}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-semibold text-[#131312]">
                    {displayName}
                  </div>
                  {email && (
                    <div className="mt-0.5 truncate text-[12px] text-[#8a847d]">
                      {email}
                    </div>
                  )}
                </div>
              </div>
              <Link
                to="/your-routes"
                onClick={() => setOpen(false)}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-[13px] font-medium text-[#1f6f5c] transition hover:bg-[#e3efe9]/50 border-b border-[#f3f1ec]"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z" />
                  <circle cx="12" cy="10" r="3" />
                </svg>
                Commute Routes
              </Link>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-[13px] font-medium text-[#a32a22] transition hover:bg-[#fdf0ef]"
              >
                <svg
                  viewBox="0 0 24 24"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <path d="m16 17 5-5-5-5" />
                  <path d="M21 12H9" />
                </svg>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

// ----- Main Dashboard Screen --------------------------------------------

function DashboardScreen({
  uid,
  userDoc,
  available,
  toggleBusy,
  onToggleAvailability,
  offers,
  busyTaskIds,
  onAcceptOffer,
  onRejectOffer,
  nearbyTasks,
  acceptedTasks,
  loading = false,
  error,
}: {
  uid: string;
  userDoc: UserDoc;
  available: boolean;
  toggleBusy: boolean;
  onToggleAvailability: () => void;
  offers: OfferRow[];
  busyTaskIds: Set<string>;
  onAcceptOffer: (id: string) => void;
  onRejectOffer: (id: string) => void;
  nearbyTasks: NearbyTaskRow[];
  acceptedTasks: AcceptedTaskRow[];
  loading?: boolean;
  error: string | null;
}) {
  const name = userDoc.displayName ?? 'Volunteer';
  const trustScore = userDoc.trustScore ?? 30;
  const verifiedCount = userDoc.verifiedTaskCount ?? 0;
  const verifiedHours = userDoc.verifiedHours ?? 0;

  const [placeName, setPlaceName] = useState<string | null>(null);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [isTrustModalOpen, setIsTrustModalOpen] = useState(false);

  // Active missions (accepted or in_progress) vs completed history
  const activeMissions = acceptedTasks.filter(
    (t) => t.status === 'accepted' || t.status === 'in_progress',
  );
  const completedHistory = acceptedTasks.filter(
    (t) => t.status === 'completed',
  );

  useEffect(() => {
    if (!userDoc.lastKnownLocation?.lat || !userDoc.lastKnownLocation?.lng)
      return;
    let cancelled = false;
    const { lat, lng } = userDoc.lastKnownLocation;
    fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`,
    )
      .then(
        (res) =>
          res.json() as Promise<{
            address?: {
              suburb?: string;
              neighbourhood?: string;
              residential?: string;
              city_district?: string;
              town?: string;
              city?: string;
            };
            name?: string;
            display_name?: string;
          }>,
      )
      .then((data) => {
        if (cancelled) return;
        const addr = data.address;
        const place =
          addr?.suburb ||
          addr?.neighbourhood ||
          addr?.residential ||
          addr?.city_district ||
          addr?.town ||
          addr?.city ||
          data.name ||
          (data.display_name ? data.display_name.split(',')[0] : null);
        if (place) setPlaceName(place);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userDoc.lastKnownLocation]);

  return (
    <section className="space-y-8">
      {/* Top Greeting */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-[30px] sm:text-[34px] font-bold tracking-tight text-[#131312]">
            Welcome, {name}.
          </h1>
          <p className="mt-1 text-sm text-[#4f4b46]">
            {available
              ? 'You are active and visible to nearby neighbours.'
              : 'Ready to help neighbours nearby today?'}
          </p>
        </div>
        {available ? (
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-emerald-800">
            <LiveDot />
            Available Live
          </div>
        ) : (
          <div className="flex items-center gap-1.5 rounded-full border border-[#ececea] bg-[#fafaf8] px-3 py-1 text-[11px] font-medium text-[#8a847d]">
            <span className="h-2 w-2 rounded-full bg-[#8a847d]" />
            Offline
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-2xl border border-red-200 bg-[#fdf0ef] p-4 text-sm text-[#a32a22]"
        >
          {error}
        </div>
      )}

      {/* 1. URGENT / ACTIVE MISSIONS (Top Priority) */}
      {activeMissions.length > 0 && (
        <div className="vc-fade-up">
          <div className="mb-3.5 flex items-baseline justify-between">
            <h2 className="m-0 text-[13px] font-bold uppercase tracking-[0.08em] text-[#1f6f5c]">
              Active Missions ({activeMissions.length})
            </h2>
            <span className="font-mono text-xs text-[#8a847d]">
              Action needed
            </span>
          </div>

          <div className="space-y-3">
            {activeMissions.map((t) => {
              const isInProgress = t.status === 'in_progress';
              return (
                <div
                  key={t.id}
                  className="overflow-hidden rounded-3xl border-2 border-[#1f6f5c]/20 bg-white p-6 shadow-sm transition hover:border-[#1f6f5c]/40"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <span
                        className={
                          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold ' +
                          (isInProgress
                            ? 'bg-amber-100 text-amber-900'
                            : 'bg-emerald-100 text-emerald-900')
                        }
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                        {isInProgress ? 'Task In Progress' : 'Task Accepted'}
                      </span>
                      <h3 className="mt-2 text-lg font-bold text-[#131312]">
                        {t.title || 'Untitled task'}
                      </h3>
                      <p className="mt-1 text-xs text-[#4f4b46]">
                        {isInProgress
                          ? 'Task is underway. When finished, ask the customer for their 4-digit Completion Code.'
                          : 'Coordinate arrival in chat. When you arrive, ask the customer for their 4-digit Start Code.'}
                      </p>
                    </div>

                    <Link
                      to={`/tasks/${t.id}`}
                      className="inline-flex items-center gap-1.5 rounded-full bg-[#1f6f5c] px-5 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#185845] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6f5c]"
                    >
                      {isInProgress
                        ? 'Enter Completion Code →'
                        : 'Open Chat & Details →'}
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 2. OFFERS FOR YOU */}
      <div>
        <div className="mb-3.5 flex items-baseline justify-between">
          <h2 className="m-0 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#8a847d]">
            Offers for you
          </h2>
          <span className="font-mono text-xs text-[#8a847d]">
            {loading ? 'Checking…' : `${offers.length} pending`}
          </span>
        </div>

        {loading ? (
          <div className="space-y-3">
            {[1, 2].map((i) => (
              <div
                key={i}
                className="animate-pulse rounded-2xl border border-[#ececea] bg-white p-5 space-y-3"
              >
                <div className="h-4 w-1/3 rounded bg-[#ececea]" />
                <div className="h-3 w-1/2 rounded bg-[#ececea]" />
              </div>
            ))}
          </div>
        ) : offers.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-[#ececea] bg-white p-8 text-center shadow-xs">
            <div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#f3f1ec] text-[#8a847d]">
              <svg
                viewBox="0 0 24 24"
                className="h-6 w-6"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h3 className="mt-3 text-sm font-bold text-[#131312]">
              No requests right now
            </h3>
            <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-[#8a847d]">
              Keep your availability turned on and we&apos;ll notify you when a
              nearby neighbour needs help matching your skills.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {offers.map((row) => {
              const category = getCategory(row.taskCategory);
              const busy = busyTaskIds.has(row.taskId);
              return (
                <div
                  key={`${row.taskId}-${row.id}`}
                  className="vc-fade-up rounded-3xl border border-[#ececea] bg-white p-6 shadow-xs transition hover:border-[#1f6f5c]/30"
                >
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-[#e3efe9] px-2.5 py-0.5 text-[11px] font-semibold text-[#1f6f5c]">
                          {category?.label ?? row.taskCategory}
                        </span>
                        <span
                          className={
                            'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ' +
                            (row.taskRiskLevel === 'medium'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-[#fafaf8] text-[#4f4b46] border border-[#ececea]')
                          }
                        >
                          {row.taskRiskLevel === 'medium' ? (
                            <>
                              <svg
                                className="h-3 w-3 shrink-0"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                                aria-hidden="true"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                                />
                              </svg>
                              <span>Verified ID Required</span>
                            </>
                          ) : (
                            <>
                              <svg
                                className="h-3 w-3 shrink-0"
                                fill="none"
                                viewBox="0 0 24 24"
                                stroke="currentColor"
                                strokeWidth={2}
                                aria-hidden="true"
                              >
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                              <span>Standard Task</span>
                            </>
                          )}
                        </span>
                      </div>

                      <h3 className="mt-2.5 text-base font-bold text-[#131312]">
                        {row.taskTitle || 'Untitled task'}
                      </h3>

                      {/* Humanized Decision Chips (No raw math scores!) */}
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-[#4f4b46]">
                        <span className="inline-flex items-center gap-1.5 font-medium">
                          <svg
                            className="h-3 w-3 text-[#1f6f5c]"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                            />
                          </svg>
                          <span>{formatDistance(row.distanceM)} away</span>
                        </span>
                        <span className="text-[#ececea]">|</span>
                        <span className="inline-flex items-center gap-1.5 font-medium">
                          <svg
                            className="h-3 w-3 text-[#4f4b46]"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                          >
                            <circle cx="12" cy="12" r="9" strokeLinecap="round" strokeLinejoin="round" />
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
                          </svg>
                          <span>~{row.estimatedMinutes ?? 30} mins</span>
                        </span>
                        <span className="text-[#ececea]">|</span>
                        <span className="inline-flex items-center gap-1.5 font-medium text-[#1f6f5c]">
                          <svg
                            className="h-3 w-3"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            strokeWidth={2}
                            aria-hidden="true"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span>Matches your skills</span>
                        </span>
                      </div>
                    </div>

                    <div className="flex flex-shrink-0 items-center gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => onRejectOffer(row.taskId)}
                        disabled={busy}
                        className="rounded-full border border-[#ececea] bg-white px-4 py-2.5 text-xs font-semibold text-[#4f4b46] transition hover:bg-[#fdf0ef] hover:text-[#a32a22] hover:border-red-200 focus:outline-none disabled:opacity-50"
                      >
                        Decline
                      </button>
                      <button
                        type="button"
                        onClick={() => onAcceptOffer(row.taskId)}
                        disabled={busy}
                        className="rounded-full bg-[#1f6f5c] px-6 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-[#185845] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6f5c] disabled:opacity-50"
                      >
                        {busy ? 'Accepting…' : 'Accept & Help'}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 3. AVAILABILITY CONTROL CARD */}
      <div className="rounded-3xl border border-[#ececea] bg-white p-6 shadow-xs">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h2 className="text-base font-bold text-[#131312]">
              {available
                ? 'Available · Receiving nearby requests'
                : 'Offline · You won’t receive new requests'}
            </h2>
            <p className="mt-1 text-xs text-[#4f4b46]">
              {available
                ? 'When turned on, neighbours within ~2.5 km matching your skills can send you task offers.'
                : 'Turn on availability when you’re ready to help neighbours.'}
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={available}
            aria-label="Availability switch"
            onClick={onToggleAvailability}
            disabled={toggleBusy}
            className={
              'relative inline-flex h-8 w-14 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6f5c] focus-visible:ring-offset-2 disabled:opacity-50 ' +
              (available ? 'bg-[#1f6f5c]' : 'bg-[#ececea]')
            }
          >
            <span
              aria-hidden="true"
              className={
                'pointer-events-none inline-block h-7 w-7 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ' +
                (available ? 'translate-x-6' : 'translate-x-0')
              }
            />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#ececea] pt-3.5 text-xs text-[#4f4b46]">
          <div className="flex items-center gap-1.5 font-medium">
            <svg
              viewBox="0 0 24 24"
              className="h-4 w-4 flex-shrink-0 text-[#1f6f5c]"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <circle cx="12" cy="10" r="3" />
            </svg>
            <span>
              {placeName
                ? `You are at ${placeName}`
                : userDoc.lastKnownLocation
                  ? `You are at ${userDoc.lastKnownLocation.lat.toFixed(3)}, ${userDoc.lastKnownLocation.lng.toFixed(3)}`
                  : available
                    ? '● Visible to nearby task posters'
                    : '○ Offline'}
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[#8a847d]">
              <svg
                className="h-3 w-3 shrink-0 text-[#8a847d]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
                />
              </svg>
              <span>Exact location is never shared</span>
            </span>
            <button
              type="button"
              onClick={() => setShowLocationModal(true)}
              className="font-semibold text-[#1f6f5c] underline underline-offset-2 transition hover:text-[#185845] focus:outline-none"
            >
              Did we get it wrong?
            </button>
          </div>
        </div>

        {showLocationModal && (
          <LocationCorrectionModal
            uid={uid}
            isOpen={showLocationModal}
            onClose={() => setShowLocationModal(false)}
          />
        )}
      </div>

      {/* 4. COMMUNITY IMPACT & TRUST SUMMARY */}
      <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-[#1f6f5c] to-[#15493b] p-7 text-white shadow-sm">
        <span
          className="pointer-events-none absolute -right-16 -top-16 h-[220px] w-[220px] rounded-full bg-white/5"
          aria-hidden="true"
        />
        <span
          className="pointer-events-none absolute -bottom-20 right-10 h-40 w-40 rounded-full bg-white/[0.04]"
          aria-hidden="true"
        />

        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <HeroAvatar
              displayName={userDoc.displayName}
              photoPath={userDoc.photoURL ?? null}
            />
            <div>
              <div className="text-xl font-bold tracking-tight">{name}</div>
              <div className="mt-0.5 text-xs text-white/80">
                Verified Neighbour · Hey Padosi
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <TrustScorePill
                  score={trustScore}
                  onOpenExplainer={() => setIsTrustModalOpen(true)}
                />
              </div>
            </div>
          </div>
          <div className="flex flex-col items-end">
            <span className="text-[11px] uppercase tracking-[0.08em] opacity-80">
              Karma Points
            </span>
            <KarmaBadge points={userDoc.points ?? 0} />
          </div>
        </div>

        <div className="relative mt-6 grid grid-cols-3 gap-4 border-t border-white/15 pt-4 text-center sm:text-left">
          <div>
            <div className="font-mono text-2xl font-bold tracking-tight">
              {verifiedCount}
            </div>
            <div className="mt-0.5 text-[11px] uppercase tracking-[0.08em] opacity-80">
              Tasks Completed
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl font-bold tracking-tight">
              {verifiedHours.toFixed(1)} h
            </div>
            <div className="mt-0.5 text-[11px] uppercase tracking-[0.08em] opacity-80">
              Volunteered
            </div>
          </div>
          <div>
            <div className="font-mono text-2xl font-bold tracking-tight">
              {userDoc.skills?.length ?? 0}
            </div>
            <div className="mt-0.5 text-[11px] uppercase tracking-[0.08em] opacity-80">
              Active Skills
            </div>
          </div>
        </div>

        {/* Skill Points Chips */}
        {Object.keys(userDoc.skillPoints ?? {}).length > 0 && (
          <div className="relative mt-4 border-t border-white/15 pt-3">
            <div className="mb-2 text-[11px] uppercase tracking-[0.08em] opacity-80">
              Skill Points
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(userDoc.skillPoints ?? {}).map(([key, val]) => (
                <span
                  key={key}
                  className="inline-flex items-center rounded-full bg-white/15 px-3 py-0.5 text-xs font-medium text-white backdrop-blur-sm"
                >
                  {getSkillLabel(key)}: {val}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 5. NEARBY OPEN REQUESTS */}
      <div>
        <div className="mb-3.5 flex items-baseline justify-between">
          <h2 className="m-0 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#8a847d]">
            Nearby requests in your area
          </h2>
          <span className="font-mono text-xs text-[#8a847d]">
            {nearbyTasks.length} open
          </span>
        </div>

        {nearbyTasks.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-[#ececea] bg-white p-6 text-center text-xs text-[#8a847d]">
            No open requests in your area right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {nearbyTasks.map((t) => (
              <Link
                key={t.id}
                to={`/tasks/${t.id}`}
                className="vc-fade-up block rounded-3xl border border-[#ececea] bg-white p-5 transition hover:-translate-y-0.5 hover:border-[#1f6f5c]/40 hover:shadow-sm"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[15px] font-bold text-[#131312]">
                    {t.title || 'Untitled task'}
                  </span>
                  <span
                    className={
                      'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ' +
                      (t.riskLevel === 'medium'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-[#e3efe9] text-[#1f6f5c]')
                    }
                  >
                    {t.riskLevel === 'medium' ? (
                      <>
                        <svg
                          className="h-3 w-3 shrink-0"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                          aria-hidden="true"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                          />
                        </svg>
                        <span>ID Needed</span>
                      </>
                    ) : (
                      <>
                        <svg
                          className="h-3 w-3 shrink-0"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                          aria-hidden="true"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        <span>Community</span>
                      </>
                    )}
                  </span>
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-[#8a847d]">
                  <span>
                    Category: {getCategory(t.category)?.label ?? t.category}
                  </span>
                  <span className="font-medium text-[#1f6f5c]">
                    View details →
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* 6. COMPLETED TASKS HISTORY (If any) */}
      {completedHistory.length > 0 && (
        <div>
          <div className="mb-3.5 flex items-baseline justify-between">
            <h2 className="m-0 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#8a847d]">
              Completed Tasks History
            </h2>
            <span className="font-mono text-xs text-[#8a847d]">
              {completedHistory.length} completed
            </span>
          </div>

          <div className="space-y-2.5">
            {completedHistory.map((t) => (
              <Link
                key={t.id}
                to={`/tasks/${t.id}`}
                className="vc-fade-up flex items-center justify-between gap-4 rounded-2xl border border-[#ececea] bg-white px-5 py-4 transition hover:border-[#d8d4cc]"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px] font-semibold text-[#131312]">
                    {t.title || 'Untitled task'}
                  </p>
                  <p className="mt-0.5 text-xs text-[#8a847d]">
                    Completed {formatWhen(t.acceptedAt)}
                  </p>
                </div>
                <StatusBadge status={t.status} />
              </Link>
            ))}
          </div>
        </div>
      )}

      <HowTrustWorksModal
        isOpen={isTrustModalOpen}
        onClose={() => setIsTrustModalOpen(false)}
      />
    </section>
  );
}

// ----- Volunteer Profile Screen -----------------------------------------

function VolunteerProfileScreen({
  uid,
  userDoc,
  acceptedTasksCount,
  onSignOut,
}: {
  uid: string;
  userDoc: UserDoc;
  acceptedTasksCount: number;
  onSignOut: () => void;
}) {
  const [trailConsent, setTrailConsentState] = useState(() =>
    getLocalTrailConsent(uid),
  );
  const [activeModal, setActiveModal] = useState<
    'privacy' | 'terms' | 'security' | null
  >(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [isTrustModalOpen, setIsTrustModalOpen] = useState(false);

  // Phone OTP Modal state
  const [phoneModalOpen, setPhoneModalOpen] = useState(false);
  const [phoneStep, setPhoneStep] = useState<'input' | 'otp'>('input');
  const [phoneInput, setPhoneInput] = useState(userDoc.phoneNumber ?? '');
  const [otpInput, setOtpInput] = useState('');
  const [generatedOtp, setGeneratedOtp] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [phoneSubmitting, setPhoneSubmitting] = useState(false);

  // Email Modal state
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const [emailInput, setEmailInput] = useState(userDoc.email ?? '');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSubmitting, setEmailSubmitting] = useState(false);

  // ID Upload Modal state
  const [idModalOpen, setIdModalOpen] = useState(false);
  const [idFile, setIdFile] = useState<File | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  const [idSubmitting, setIdSubmitting] = useState(false);
  const [idSuccess, setIdSuccess] = useState<string | null>(null);

  async function handleUploadId() {
    if (!idFile) {
      setIdError('Please select a valid ID document image.');
      return;
    }
    if (idFile.size > 2 * 1024 * 1024) {
      setIdError('File must be 2 MB or smaller.');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(idFile.type)) {
      setIdError('Please select a valid JPEG, PNG, or WebP image.');
      return;
    }

    setIdSubmitting(true);
    setIdError(null);
    try {
      const idPath = `users/${uid}/id-image`;
      await uploadBytes(storageRef(storage(), idPath), idFile, {
        contentType: idFile.type,
      });
      await updateDoc(doc(db(), 'users', uid), {
        idImagePath: idPath,
      });
      const submitFn = httpsCallable(functions(), 'submitIdVerification');
      await submitFn();
      setIdSuccess('ID document submitted successfully for admin review.');
      setIdFile(null);
      setTimeout(() => {
        setIdSuccess(null);
        setIdModalOpen(false);
      }, 2000);
    } catch (err) {
      setIdError(err instanceof Error ? err.message : 'Failed to upload ID document.');
    } finally {
      setIdSubmitting(false);
    }
  }

  function handleSendPhoneOtp() {
    setPhoneError(null);
    const cleaned = phoneInput.trim();
    if (!cleaned || cleaned.length < 10) {
      setPhoneError('Please enter a valid 10-digit mobile number.');
      return;
    }
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    setGeneratedOtp(code);
    setPhoneStep('otp');
  }

  async function handleVerifyPhoneOtp() {
    setPhoneError(null);
    if (otpInput.trim() !== generatedOtp) {
      setPhoneError('Invalid verification code. Please check and try again.');
      return;
    }
    setPhoneSubmitting(true);
    try {
      await updateDoc(doc(db(), 'users', uid), {
        phoneNumber: phoneInput.trim(),
      });
      setPhoneModalOpen(false);
      setPhoneStep('input');
      setOtpInput('');
      setStatusMsg('Phone number successfully updated & verified.');
    } catch (err) {
      setPhoneError(
        err instanceof Error ? err.message : 'Could not update phone number.',
      );
    } finally {
      setPhoneSubmitting(false);
    }
  }

  async function handleUpdateEmail() {
    setEmailError(null);
    const cleaned = emailInput.trim();
    if (!cleaned || !cleaned.includes('@')) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    setEmailSubmitting(true);
    try {
      await updateDoc(doc(db(), 'users', uid), {
        email: cleaned,
      });
      setEmailModalOpen(false);
      setStatusMsg('Email address successfully updated.');
    } catch (err) {
      setEmailError(
        err instanceof Error ? err.message : 'Could not update email address.',
      );
    } finally {
      setEmailSubmitting(false);
    }
  }

  async function handleConsentToggle(enabled: boolean) {
    setStatusMsg(null);
    try {
      await setTrailConsent(uid, enabled);
      setTrailConsentState(enabled);
      if (enabled) {
        setStatusMsg('Commute trail matching enabled.');
      } else {
        setStatusMsg('Trail consent revoked and stored trails wiped.');
      }
    } catch (err) {
      setStatusMsg(
        err instanceof Error ? err.message : 'Could not update consent.',
      );
    }
  }

  async function handleWipeTrailHistory() {
    if (
      !confirm(
        'Are you sure you want to delete all inferred commute routes and trail history?',
      )
    ) {
      return;
    }
    try {
      await wipeAllTrailData(uid);
      setTrailConsentState(false);
      setStatusMsg('Trail history successfully deleted.');
    } catch {
      setStatusMsg('Failed to delete trail history.');
    }
  }

  return (
    <section className="space-y-6">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="m-0 text-[32px] font-bold tracking-tight">
            Your profile
          </h1>
          <p className="mt-1.5 text-sm text-[#4f4b46]">
            Your volunteer details, privacy options, and account settings.
          </p>
        </div>
      </div>

      {statusMsg && (
        <div
          role="status"
          className="rounded-2xl border border-[#1f6f5c]/20 bg-[#e3efe9]/50 p-4 text-sm font-medium text-[#1f6f5c]"
        >
          {statusMsg}
        </div>
      )}

      <div className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Hero summary */}
        <div className="relative overflow-hidden rounded-[22px] bg-gradient-to-br from-[#1f6f5c] to-[#15493b] px-7 py-7 text-white lg:col-span-1">
          <span
            className="pointer-events-none absolute -right-16 -top-16 h-[220px] w-[220px] rounded-full bg-white/5"
            aria-hidden="true"
          />
          <div className="relative flex items-center gap-[18px]">
            <HeroAvatar
              displayName={userDoc.displayName}
              photoPath={userDoc.photoURL ?? null}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-2xl font-bold tracking-tight">
                {userDoc.displayName ?? 'Volunteer'}
              </div>
              <div className="mt-1 truncate text-[13px] opacity-80">
                Volunteer · Hey Padosi
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {userDoc.idVerified ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/25 border border-emerald-300/40 px-2.5 py-0.5 text-xs font-semibold text-emerald-100">
                    <svg
                      className="h-3 w-3 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
                      />
                    </svg>
                    <span>ID Verified</span>
                  </span>
                ) : userDoc.idVerificationStatus === 'pending' || (userDoc.idImagePath && userDoc.idVerificationStatus !== 'rejected') ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/25 border border-amber-300/40 px-2.5 py-0.5 text-xs font-semibold text-amber-100">
                    <svg
                      className="h-3 w-3 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span>ID Pending Review</span>
                  </span>
                ) : userDoc.idVerificationStatus === 'rejected' ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/25 border border-rose-300/40 px-2.5 py-0.5 text-xs font-semibold text-rose-100">
                    <svg
                      className="h-3 w-3 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                    <span>ID Rejected</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-medium text-white/90">
                    <svg
                      className="h-3 w-3 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                      aria-hidden="true"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                    <span>Verified Neighbour</span>
                  </span>
                )}
                <TrustScorePill
                  score={userDoc.trustScore ?? 80}
                  onOpenExplainer={() => setIsTrustModalOpen(true)}
                />
              </div>
            </div>
          </div>
          <div className="relative mt-6 grid grid-cols-2 gap-4 border-t border-white/15 pt-5">
            <div>
              <div className="font-mono text-[26px] font-bold tracking-tight">
                {userDoc.verifiedTaskCount ?? 0}
              </div>
              <div className="mt-0.5 text-[11px] uppercase tracking-[0.08em] opacity-80">
                Completed
              </div>
            </div>
            <div>
              <div className="font-mono text-[26px] font-bold tracking-tight">
                {acceptedTasksCount}
              </div>
              <div className="mt-0.5 text-[11px] uppercase tracking-[0.08em] opacity-80">
                Active accepted
              </div>
            </div>
          </div>
        </div>

        {/* Volunteer details & Settings */}
        <div className="lg:col-span-2 space-y-6">
          <div>
            <div className="mb-3.5 flex items-baseline justify-between">
              <h2 className="m-0 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#8a847d]">
                Volunteer details
              </h2>
            </div>
            <div className="overflow-hidden rounded-[18px] border border-[#ececea] bg-white">
              <DetailRow
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4 text-[#1f6f5c]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92Z" />
                  </svg>
                }
                label="Phone"
                value={userDoc.phoneNumber ? userDoc.phoneNumber : 'Not set'}
                action={
                  <button
                    type="button"
                    onClick={() => {
                      setPhoneInput(userDoc.phoneNumber ?? '');
                      setPhoneStep('input');
                      setPhoneError(null);
                      setPhoneModalOpen(true);
                    }}
                    className="rounded-xl border border-[#ececea] bg-[#fafaf8] px-3.5 py-1.5 text-xs font-bold text-[#1f6f5c] transition hover:bg-[#e3efe9]"
                  >
                    {userDoc.phoneNumber ? 'Edit Phone' : 'Add & Verify Phone'}
                  </button>
                }
              />
              <DetailRow
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4 text-[#1f6f5c]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="m22 7-10 6L2 7" />
                  </svg>
                }
                label="Email"
                value={userDoc.email ? userDoc.email : 'Not set'}
                action={
                  <button
                    type="button"
                    onClick={() => {
                      setEmailInput(userDoc.email ?? '');
                      setEmailError(null);
                      setEmailModalOpen(true);
                    }}
                    className="rounded-xl border border-[#ececea] bg-[#fafaf8] px-3.5 py-1.5 text-xs font-bold text-[#1f6f5c] transition hover:bg-[#e3efe9]"
                  >
                    Change email address
                  </button>
                }
              />
              <DetailRow
                icon={
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4 text-[#1f6f5c]"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                }
                label="ID Verification"
                value={
                  userDoc.idVerified ? (
                    <span className="font-semibold text-emerald-700">Verified by Administrator</span>
                  ) : userDoc.idVerificationStatus === 'pending' ||
                    (userDoc.idImagePath && userDoc.idVerificationStatus !== 'rejected') ? (
                    <span className="font-semibold text-amber-700">Pending Admin Review</span>
                  ) : userDoc.idVerificationStatus === 'rejected' ? (
                    <span className="font-semibold text-rose-700">
                      Rejected{userDoc.idVerificationRejectionReason ? `: ${userDoc.idVerificationRejectionReason}` : ''}
                    </span>
                  ) : (
                    'Not Submitted (Optional)'
                  )
                }
                action={
                  !userDoc.idVerified ? (
                    <button
                      type="button"
                      onClick={() => {
                        setIdFile(null);
                        setIdError(null);
                        setIdSuccess(null);
                        setIdModalOpen(true);
                      }}
                      className="rounded-xl border border-[#ececea] bg-[#fafaf8] px-3.5 py-1.5 text-xs font-bold text-[#1f6f5c] transition hover:bg-[#e3efe9]"
                    >
                      {userDoc.idVerificationStatus === 'rejected'
                        ? 'Re-upload ID'
                        : userDoc.idImagePath
                        ? 'Update ID'
                        : 'Upload ID'}
                    </button>
                  ) : undefined
                }
              />
            </div>
          </div>

          {/* Commute Trail Matching Settings */}
          <div>
            <h2 className="mb-3.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#8a847d]">
              Commute Trail & Matching Settings
            </h2>
            <div className="overflow-hidden rounded-[18px] border border-[#ececea] bg-white p-5 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-[#131312]">
                    Enable Commute Trail Matching
                  </div>
                  <div className="text-xs text-[#8a847d]">
                    Allow TrailService to infer recurring routes for corridor
                    task matching.
                  </div>
                </div>
                <label
                  aria-label="Toggle commute trail matching"
                  className="relative inline-flex cursor-pointer items-center"
                >
                  <input
                    type="checkbox"
                    checked={trailConsent}
                    onChange={(e) => void handleConsentToggle(e.target.checked)}
                    className="peer sr-only"
                  />
                  <div className="peer h-7 w-12 rounded-full bg-[#ececea] after:absolute after:top-0.5 after:left-0.5 after:h-6 after:w-6 after:rounded-full after:bg-white after:shadow after:transition-all peer-checked:bg-[#1f6f5c] peer-checked:after:translate-x-5" />
                </label>
              </div>

              {/* Sub-settings visible when enabled */}
              {trailConsent && (
                <div className="mt-4 pt-4 border-t border-[#ececea] space-y-3 vc-fade-up">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Link
                      to="/your-routes"
                      className="inline-flex items-center gap-2 rounded-xl border border-[#ececea] bg-[#fafaf8] px-4 py-2.5 text-xs font-bold text-[#1f6f5c] transition hover:bg-[#e3efe9]"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path d="M12 22s-8-4.5-8-11.8A8 8 0 0 1 12 2a8 8 0 0 1 8 8.2c0 7.3-8 11.8-8 11.8z" />
                        <circle cx="12" cy="10" r="3" />
                      </svg>
                      Commute Routes →
                    </Link>

                    <button
                      type="button"
                      onClick={() => void handleWipeTrailHistory()}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-[#f0c4c0] bg-[#fdf0ef] px-4 py-2.5 text-xs font-bold text-[#a32a22] transition hover:bg-red-100"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="h-4 w-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                      Delete trail history
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Standalone Legal & Security Settings Buttons */}
          <div>
            <h2 className="mb-3.5 text-[13px] font-semibold uppercase tracking-[0.08em] text-[#8a847d]">
              Platform & Legal Settings
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <button
                type="button"
                onClick={() => setActiveModal('privacy')}
                className="flex items-center gap-3 rounded-[16px] border border-[#ececea] bg-white p-4 text-left transition hover:border-[#1f6f5c]/50 hover:bg-[#fafaf8] focus:outline-none"
              >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#e3efe9] text-[#1f6f5c]">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </span>
                <div>
                  <div className="text-xs font-bold text-[#131312]">
                    Privacy Policy
                  </div>
                  <div className="text-[11px] text-[#8a847d]">
                    DPDP Act 2025/2027
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveModal('terms')}
                className="flex items-center gap-3 rounded-[16px] border border-[#ececea] bg-white p-4 text-left transition hover:border-[#1f6f5c]/50 hover:bg-[#fafaf8] focus:outline-none"
              >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#e3efe9] text-[#1f6f5c]">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                    <polyline points="10 9 9 9 8 9" />
                  </svg>
                </span>
                <div>
                  <div className="text-xs font-bold text-[#131312]">
                    Terms & Conditions
                  </div>
                  <div className="text-[11px] text-[#8a847d]">
                    Community code
                  </div>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setActiveModal('security')}
                className="flex items-center gap-3 rounded-[16px] border border-[#ececea] bg-white p-4 text-left transition hover:border-[#1f6f5c]/50 hover:bg-[#fafaf8] focus:outline-none"
              >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[#e3efe9] text-[#1f6f5c]">
                  <svg
                    viewBox="0 0 24 24"
                    className="h-4 w-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
                <div>
                  <div className="text-xs font-bold text-[#131312]">
                    Security & Shield
                  </div>
                  <div className="text-[11px] text-[#8a847d]">
                    AES-256 & Isolation
                  </div>
                </div>
              </button>
            </div>
          </div>

          <BlockedUsersList uid={uid} />

          <div className="mt-5 flex justify-end">
            <button
              type="button"
              onClick={onSignOut}
              className="rounded-full border border-[#ececea] bg-transparent px-[22px] py-2.5 text-[13px] font-medium text-[#4f4b46] transition hover:border-[#f0c4c0] hover:bg-[#fdf0ef] hover:text-[#a32a22]"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* Standalone Setting Modals */}
      {activeModal &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#131312]/60 p-4 backdrop-blur-xs vc-fade-up">
            <div className="w-full max-w-lg overflow-hidden rounded-[24px] border border-[#ececea] bg-white p-6 shadow-xl sm:p-7">
              {activeModal === 'privacy' && (
                <>
                  <div className="flex items-center justify-between border-b border-[#ececea] pb-4">
                    <h3 className="m-0 text-lg font-bold text-[#131312]">
                      Privacy Policy (DPDP Act 2025/2027)
                    </h3>
                    <button
                      type="button"
                      onClick={() => setActiveModal(null)}
                      className="rounded-full p-1 text-[#8a847d] hover:bg-[#fafaf8]"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-4 space-y-3 text-xs leading-relaxed text-[#4f4b46]">
                    <p>
                      Hey Padosi processes location and commute trail data
                      strictly under purpose limitation for hyperlocal volunteer
                      matching.
                    </p>
                    <p>
                      <strong>On-Device Privacy:</strong> Raw GPS pings are
                      processed locally on your phone. Only derived route
                      summaries are synced to isolated storage.
                    </p>
                    <p>
                      <strong>Data Principal Rights:</strong> You hold complete
                      rights to access, inspect, and delete your inferred
                      commute routes at any time via the self-serve routes
                      screen.
                    </p>
                  </div>
                </>
              )}

              {activeModal === 'terms' && (
                <>
                  <div className="flex items-center justify-between border-b border-[#ececea] pb-4">
                    <h3 className="m-0 text-lg font-bold text-[#131312]">
                      Terms & Conditions
                    </h3>
                    <button
                      type="button"
                      onClick={() => setActiveModal(null)}
                      className="rounded-full p-1 text-[#8a847d] hover:bg-[#fafaf8]"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-4 space-y-3 text-xs leading-relaxed text-[#4f4b46]">
                    <p>
                      <strong>Community Code:</strong> Hey Padosi is a
                      mutual-aid micro-volunteering platform. All volunteers and
                      customers must interact respectfully.
                    </p>
                    <p>
                      <strong>Task Verification & Risk:</strong> Medium-risk
                      tasks require ID verification. Fraudulent activity or
                      unsafe behavior results in immediate account suspension.
                    </p>
                  </div>
                </>
              )}

              {activeModal === 'security' && (
                <>
                  <div className="flex items-center justify-between border-b border-[#ececea] pb-4">
                    <h3 className="m-0 text-lg font-bold text-[#131312]">
                      Platform Security & Shield
                    </h3>
                    <button
                      type="button"
                      onClick={() => setActiveModal(null)}
                      className="rounded-full p-1 text-[#8a847d] hover:bg-[#fafaf8]"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-4 space-y-3 text-xs leading-relaxed text-[#4f4b46]">
                    <p>
                      <strong>AES-256 & Isolation:</strong> Trail data is
                      encrypted in transit and stored in an isolated datastore
                      (`user_trails`) with strict owner-only security rules.
                    </p>
                    <p>
                      <strong>Customer Position Shield:</strong> Task posters
                      only ever see "Volunteer on the way, ETA X min". Your live
                      coordinates and route corridors are never exposed to
                      customers.
                    </p>
                  </div>
                </>
              )}

              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={() => setActiveModal(null)}
                  className="rounded-xl bg-[#1f6f5c] px-5 py-2 text-xs font-bold text-white transition hover:bg-[#185845]"
                >
                  Close
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Phone Verification Modal */}
      {phoneModalOpen &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#131312]/60 p-4 backdrop-blur-xs vc-fade-up">
            <div className="w-full max-w-md overflow-hidden rounded-[24px] border border-[#ececea] bg-white p-6 shadow-xl sm:p-7">
              <div className="flex items-center justify-between border-b border-[#ececea] pb-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e3efe9] text-[#1f6f5c]">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72A2 2 0 0 1 22 16.92Z" />
                    </svg>
                  </span>
                  <h3 className="m-0 text-lg font-bold text-[#131312]">
                    Verify Mobile Number
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setPhoneModalOpen(false)}
                  className="rounded-full p-1 text-[#8a847d] hover:bg-[#fafaf8]"
                >
                  ✕
                </button>
              </div>

              {phoneError && (
                <div className="mt-4 rounded-xl border border-red-200 bg-[#fdf0ef] p-3 text-xs font-medium text-[#a32a22]">
                  {phoneError}
                </div>
              )}

              {phoneStep === 'input' ? (
                <div className="mt-4 space-y-4">
                  <p className="text-xs leading-relaxed text-[#4f4b46]">
                    Enter your mobile number below. We will send a 4-digit OTP
                    code to verify ownership.
                  </p>
                  <div>
                    <label
                      htmlFor="phone-number-input"
                      className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a847d] mb-1.5"
                    >
                      Phone Number
                    </label>
                    <input
                      id="phone-number-input"
                      type="tel"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      placeholder="+91 98765 43210"
                      className="w-full rounded-xl border border-[#ececea] bg-[#fafaf8] px-4 py-2.5 text-sm font-medium text-[#131312] focus:border-[#1f6f5c] focus:bg-white focus:outline-none"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setPhoneModalOpen(false)}
                      className="rounded-xl border border-[#ececea] px-4 py-2 text-xs font-semibold text-[#4f4b46] hover:bg-[#fafaf8]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSendPhoneOtp}
                      className="rounded-xl bg-[#1f6f5c] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#185845]"
                    >
                      Send Verification OTP
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mt-4 space-y-4">
                  <div className="rounded-xl border border-[#1f6f5c]/20 bg-[#e3efe9]/50 p-3.5 text-xs text-[#1f6f5c]">
                    <div>
                      Verification code sent to <strong>{phoneInput}</strong>.
                    </div>
                    <div className="mt-1 font-mono text-[11px]">
                      Test OTP Code:{' '}
                      <strong className="text-[#131312]">{generatedOtp}</strong>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="phone-otp-input"
                      className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a847d] mb-1.5"
                    >
                      Enter 4-Digit OTP
                    </label>
                    <input
                      id="phone-otp-input"
                      type="text"
                      maxLength={4}
                      value={otpInput}
                      onChange={(e) => setOtpInput(e.target.value)}
                      placeholder="1234"
                      className="w-full text-center font-mono text-lg font-bold tracking-widest rounded-xl border border-[#ececea] bg-[#fafaf8] px-4 py-2.5 text-[#131312] focus:border-[#1f6f5c] focus:bg-white focus:outline-none"
                    />
                  </div>

                  <div className="flex justify-between items-center pt-2">
                    <button
                      type="button"
                      onClick={() => setPhoneStep('input')}
                      className="text-xs font-semibold text-[#1f6f5c] hover:underline"
                    >
                      ← Back to Phone Input
                    </button>
                    <button
                      type="button"
                      disabled={phoneSubmitting}
                      onClick={() => void handleVerifyPhoneOtp()}
                      className="rounded-xl bg-[#1f6f5c] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#185845] disabled:opacity-50"
                    >
                      {phoneSubmitting ? 'Verifying...' : 'Verify & Confirm'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}

      {/* Change Email Modal */}
      {emailModalOpen &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#131312]/60 p-4 backdrop-blur-xs vc-fade-up">
            <div className="w-full max-w-md overflow-hidden rounded-[24px] border border-[#ececea] bg-white p-6 shadow-xl sm:p-7">
              <div className="flex items-center justify-between border-b border-[#ececea] pb-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e3efe9] text-[#1f6f5c]">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <rect x="2" y="4" width="20" height="16" rx="2" />
                      <path d="m22 7-10 6L2 7" />
                    </svg>
                  </span>
                  <h3 className="m-0 text-lg font-bold text-[#131312]">
                    Change Email Address
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setEmailModalOpen(false)}
                  className="rounded-full p-1 text-[#8a847d] hover:bg-[#fafaf8]"
                >
                  ✕
                </button>
              </div>

              {emailError && (
                <div className="mt-4 rounded-xl border border-red-200 bg-[#fdf0ef] p-3 text-xs font-medium text-[#a32a22]">
                  {emailError}
                </div>
              )}

              <div className="mt-4 space-y-4">
                <p className="text-xs leading-relaxed text-[#4f4b46]">
                  Enter your new email address below. This will update your
                  contact information for notifications and login.
                </p>
                <div>
                  <label
                    htmlFor="user-email-input"
                    className="block text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a847d] mb-1.5"
                  >
                    New Email Address
                  </label>
                  <input
                    id="user-email-input"
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    placeholder="name@example.com"
                    className="w-full rounded-xl border border-[#ececea] bg-[#fafaf8] px-4 py-2.5 text-sm font-medium text-[#131312] focus:border-[#1f6f5c] focus:bg-white focus:outline-none"
                  />
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEmailModalOpen(false)}
                    className="rounded-xl border border-[#ececea] px-4 py-2 text-xs font-semibold text-[#4f4b46] hover:bg-[#fafaf8]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={emailSubmitting}
                    onClick={() => void handleUpdateEmail()}
                    className="rounded-xl bg-[#1f6f5c] px-4 py-2 text-xs font-bold text-white transition hover:bg-[#185845] disabled:opacity-50"
                  >
                    {emailSubmitting ? 'Updating...' : 'Update Email'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* Upload ID Modal */}
      {idModalOpen &&
        createPortal(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#131312]/60 p-4 backdrop-blur-xs vc-fade-up">
            <div className="w-full max-w-md overflow-hidden rounded-[24px] border border-[#ececea] bg-white p-6 shadow-xl sm:p-7">
              <div className="flex items-center justify-between border-b border-[#ececea] pb-4">
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e3efe9] text-[#1f6f5c]">
                    <svg
                      viewBox="0 0 24 24"
                      className="h-4 w-4"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                  </span>
                  <h3 className="m-0 text-lg font-bold text-[#131312]">
                    Community ID Verification
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setIdModalOpen(false)}
                  className="rounded-full p-1 text-[#8a847d] hover:bg-[#fafaf8]"
                  aria-label="Close"
                >
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <div className="mt-4 space-y-4">
                <p className="text-xs leading-relaxed text-[#4f4b46]">
                  Upload a clear image of your institutional, community, or student ID card (JPEG, PNG, WebP ≤ 2 MB).
                  Your document is kept strictly confidential and only inspected by platform administrators to unlock medium-risk tasks.
                </p>

                {userDoc.idVerificationStatus === 'rejected' && userDoc.idVerificationRejectionReason && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                    <strong>Previous review reason:</strong> {userDoc.idVerificationRejectionReason}
                  </div>
                )}

                <div>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => {
                      setIdError(null);
                      const file = e.target.files?.[0] ?? null;
                      setIdFile(file);
                    }}
                    className="block w-full text-xs text-[#4f4b46] file:mr-3 file:rounded-full file:border-0 file:bg-[#1f6f5c] file:px-4 file:py-2 file:text-xs file:font-bold file:text-white hover:file:bg-[#175849]"
                  />
                  {idFile && (
                    <div className="mt-2 text-xs font-medium text-[#1f6f5c]">
                      Selected: {idFile.name} ({(idFile.size / 1024).toFixed(1)} KB)
                    </div>
                  )}
                </div>

                {idError && (
                  <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                    {idError}
                  </div>
                )}
                {idSuccess && (
                  <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
                    {idSuccess}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2.5 pt-2">
                  <button
                    type="button"
                    onClick={() => setIdModalOpen(false)}
                    className="rounded-full border border-[#ececea] bg-white px-4 py-2 text-xs font-semibold text-[#4f4b46] hover:bg-[#fafaf8]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={!idFile || idSubmitting}
                    onClick={() => void handleUploadId()}
                    className="rounded-full bg-[#1f6f5c] px-5 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-[#175849] disabled:opacity-50"
                  >
                    {idSubmitting ? 'Uploading…' : 'Submit for Review'}
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <HowTrustWorksModal
        isOpen={isTrustModalOpen}
        onClose={() => setIsTrustModalOpen(false)}
      />
    </section>
  );
}

// ----- Bottom Navigation -----------------------------------------------

function BottomNav({
  screen,
  offersCount,
  onChange,
}: {
  screen: ScreenKey;
  offersCount: number;
  onChange: (next: ScreenKey) => void;
}) {
  return (
    <nav
      className="fixed bottom-[18px] left-1/2 z-30 flex -translate-x-1/2 gap-1 rounded-full border border-[#ececea] bg-white p-1.5 shadow-[0_12px_32px_-10px_rgba(20,18,15,0.18),0_4px_10px_-4px_rgba(20,18,15,0.08)]"
      aria-label="Primary"
    >
      <NavButton
        active={screen === 'dashboard'}
        onClick={() => onChange('dashboard')}
        icon={
          <svg
            viewBox="0 0 24 24"
            className="h-[18px] w-[18px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="3" width="7" height="7" rx="1" />
            <rect x="14" y="14" width="7" height="7" rx="1" />
            <rect x="3" y="14" width="7" height="7" rx="1" />
          </svg>
        }
        label="Dashboard"
        badge={offersCount > 0 ? String(offersCount) : null}
      />
      <NavButton
        active={screen === 'profile'}
        onClick={() => onChange('profile')}
        icon={
          <svg
            viewBox="0 0 24 24"
            className="h-[18px] w-[18px]"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        }
        label="Profile"
        badge={null}
      />
    </nav>
  );
}

function NavButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  badge: string | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-2 rounded-full px-[22px] py-2.5 text-[13px] font-semibold transition-all duration-300 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ' +
        (active
          ? 'scale-[1.02] bg-[#131312] text-white focus-visible:ring-white'
          : 'bg-transparent text-[#8a847d] hover:scale-[1.02] hover:text-[#131312] focus-visible:ring-[#131312]')
      }
      aria-pressed={active}
    >
      {icon}
      {label}
      {badge && (
        <span className="rounded-full bg-[#1f6f5c] px-1.5 py-[1px] font-mono text-[10px] leading-tight text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

// ----- Helpers ---------------------------------------------------------

function LiveDot() {
  return (
    <span className="relative inline-block h-2 w-2">
      <span className="absolute inset-0 rounded-full bg-[#1f6f5c]" />
      <span
        className="absolute inset-[-4px] animate-ping rounded-full bg-[#1f6f5c] opacity-25"
        aria-hidden="true"
      />
    </span>
  );
}

function HeroAvatar({
  displayName,
  photoPath,
}: {
  displayName: string | undefined;
  photoPath: string | null;
}) {
  const url = usePhotoUrl(photoPath);
  return (
    <span className="grid h-[76px] w-[76px] flex-shrink-0 place-items-center overflow-hidden rounded-full border-4 border-white/25 bg-gradient-to-br from-[#ffd28a] to-[#f08a4b] text-[28px] font-bold text-[#5a2900]">
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : (
        <span aria-hidden="true">{initialOf(displayName)}</span>
      )}
    </span>
  );
}

function DetailRow({
  icon,
  label,
  value,
  action,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3.5 border-b border-[#f3f1ec] px-[18px] py-4 last:border-b-0">
      <div className="flex items-center gap-3.5 min-w-0 flex-1">
        <span className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-[10px] bg-[#e3efe9]">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-[#8a847d]">
            {label}
          </div>
          <div className="mt-0.5 truncate text-sm font-medium text-[#131312]">
            {value}
          </div>
        </div>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const palette: Record<TaskStatus, string> = {
    searching: 'bg-blue-100 text-blue-800',
    accepted: 'bg-emerald-100 text-emerald-800',
    in_progress: 'bg-amber-100 text-amber-800',
    completed: 'bg-emerald-100 text-emerald-800',
    cancelled: 'bg-[#ececea] text-[#4f4b46]',
    expired: 'bg-[#ececea] text-[#4f4b46]',
  };
  const label: Record<TaskStatus, string> = {
    searching: 'Searching',
    accepted: 'Accepted',
    in_progress: 'In progress',
    completed: 'Completed',
    cancelled: 'Cancelled',
    expired: 'Expired',
  };
  return (
    <span
      className={
        'flex-shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide ' +
        palette[status]
      }
    >
      {label[status]}
    </span>
  );
}

function usePhotoUrl(path: string | null): string | null {
  const [cache, setCache] = useState<{
    path: string | null;
    url: string | null;
  }>({ path, url: null });
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    void getDownloadURL(storageRef(storage(), path))
      .then((u) => {
        if (!cancelled) setCache({ path, url: u });
      })
      .catch(() => {
        if (!cancelled) setCache({ path, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [path]);
  return cache.path === path ? cache.url : null;
}

function initialOf(name: string | undefined): string {
  if (!name) return 'V';
  const trimmed = name.trim();
  if (!trimmed) return 'V';
  return trimmed[0]?.toUpperCase() ?? 'V';
}

function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m < 0) return 'unknown distance';
  if (m < 1000) return `${String(Math.round(m))} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatWhen(t: Timestamp | null): string {
  if (!t) return 'just now';
  const ms = t.toMillis();
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${String(Math.floor(diff / 60_000))} min ago`;
  if (diff < 86_400_000) return `${String(Math.floor(diff / 3_600_000))} h ago`;
  return new Date(ms).toLocaleDateString();
}

interface LocationCorrectionModalProps {
  uid: string;
  isOpen: boolean;
  onClose: () => void;
}

function LocationCorrectionModal({
  uid,
  isOpen,
  onClose,
}: LocationCorrectionModalProps) {
  const [mode, setMode] = useState<'detect' | 'map'>('detect');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [mapLoc, setMapLoc] = useState<{
    lat: number;
    lng: number;
    h3Cell: string;
  } | null>(null);

  if (!isOpen) return null;

  async function handleAutoDetect() {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const loc = await getCurrentLocation();
      const h3Cell = latLngToCell(loc.lat, loc.lng, H3_RESOLUTION);
      const userRef = doc(db(), 'users', uid);
      await updateDoc(userRef, {
        lastKnownLocation: {
          lat: loc.lat,
          lng: loc.lng,
          h3Cell,
          updatedAt: serverTimestamp(),
        },
      });
      setSuccess('Location updated automatically!');
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err) {
      if (err instanceof GeolocationError) {
        setError(err.userMessage);
      } else {
        setError(
          err instanceof Error ? err.message : 'Could not detect location.',
        );
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveMapLocation() {
    if (!mapLoc) {
      setError('Please select a location on the map first.');
      return;
    }
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      const userRef = doc(db(), 'users', uid);
      await updateDoc(userRef, {
        lastKnownLocation: {
          lat: mapLoc.lat,
          lng: mapLoc.lng,
          h3Cell: mapLoc.h3Cell,
          updatedAt: serverTimestamp(),
        },
      });
      setSuccess('Location saved successfully!');
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save location.');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/60 p-4 backdrop-blur-sm">
      <div className="vc-fade-up w-full max-w-lg overflow-hidden rounded-3xl border border-[#ececea] bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-bold tracking-tight text-[#131312]">
              Update your location
            </h3>
            <p className="mt-1 text-sm text-[#4f4b46]">
              Neighbours match with you based on your location (up to 2 km
              search radius).
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 transition"
            aria-label="Close"
          >
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-xl border border-red-200 bg-[#fdf0ef] p-3 text-xs text-[#a32a22]"
          >
            {error}
          </div>
        )}

        {success && (
          <div
            role="status"
            className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800"
          >
            {success}
          </div>
        )}

        <div className="mt-5 flex gap-2 border-b border-[#ececea] pb-3 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setMode('detect')}
            className={
              'rounded-full px-4 py-2 transition ' +
              (mode === 'detect'
                ? 'bg-[#1f6f5c] text-white shadow-sm'
                : 'bg-neutral-100 text-[#4f4b46] hover:bg-neutral-200')
            }
          >
            Detect Automatically
          </button>
          <button
            type="button"
            onClick={() => setMode('map')}
            className={
              'rounded-full px-4 py-2 transition ' +
              (mode === 'map'
                ? 'bg-[#1f6f5c] text-white shadow-sm'
                : 'bg-neutral-100 text-[#4f4b46] hover:bg-neutral-200')
            }
          >
            Choose on Map
          </button>
        </div>

        <div className="mt-4">
          {mode === 'detect' && (
            <div className="py-6 text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[#e3efe9] text-[#1f6f5c]">
                <svg
                  viewBox="0 0 24 24"
                  className="h-7 w-7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 14a4 4 0 1 1 4-4 4 4 0 0 1-4 4z" />
                </svg>
              </div>
              <p className="mt-3 text-sm font-medium text-[#131312]">
                Re-detect your current GPS location
              </p>
              <p className="mt-1 text-xs text-[#8a847d]">
                Your browser will request location permission to pin your
                position.
              </p>
              <button
                type="button"
                onClick={() => void handleAutoDetect()}
                disabled={busy}
                className="mt-5 rounded-full bg-[#1f6f5c] px-6 py-2.5 text-xs font-semibold text-white shadow-sm hover:bg-[#185845] transition disabled:opacity-50"
              >
                {busy ? 'Detecting…' : 'Allow & Detect Location'}
              </button>
            </div>
          )}

          {mode === 'map' && (
            <div className="space-y-4">
              <TaskLocationPicker onLocationChange={(loc) => setMapLoc(loc)} />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-full border border-neutral-300 px-4 py-2 text-xs font-medium text-neutral-700 hover:bg-neutral-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleSaveMapLocation()}
                  disabled={busy || !mapLoc}
                  className="rounded-full bg-[#1f6f5c] px-5 py-2 text-xs font-semibold text-white hover:bg-[#185845] disabled:opacity-50"
                >
                  {busy ? 'Saving…' : 'Save Map Location'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
