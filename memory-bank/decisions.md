# Decisions Log

> Append-only. Each entry records a locked design decision.

---

### D-001 — Two Distinct OTP Systems

Auth OTP (Firebase SMS for sign-in) and Task Start/End OTP (app-generated 4-digit code, SHA-256 hashed with random 16-byte salt, 10-minute TTL) are completely separate. Task OTPs are generated server-side, plaintext returned once to customer via callable response, never written to Firestore in plaintext, never sent to volunteer's client, never logged.

**Stored in**: `otp.ts` (helpers), `generate-start-otp.ts`, `verify-start-otp.ts`, `generate-end-otp.ts`, `verify-end-otp.ts`.

---

### D-002 — Server-Authoritative Model

Trust scores, points, OTP generation/verification, matching ranking, and moderation actions live exclusively in Cloud Functions. Clients can read computed values but never write server-only fields. Enforced by Firestore rules allowlists (`userCreateAllowedKeys`, `userUpdateAllowedKeys`, `userServerOnlyKeys`).

---

### D-003 — Deny-by-Default Security Rules

All Firestore and Storage rules start with deny-all. Every access grant is explicit, role-scoped, and owner-scoped. No `if true` rules exist anywhere.

---

### D-004 — H3 Resolution 9 for Geospatial Indexing

H3 hexagonal grid at resolution 9 (~175 m edge length) is used for location hashing, matching proximity, and trail corridor matching. `h3-js` v4.4.0 is used on both client and server.

---

### D-005 — Offer Fan-Out via Subcollection

Offers are stored as `tasks/{taskId}/offers/{volunteerId}`. Volunteers query their offers via collection-group query (`volunteerId == auth.uid`). Customer reads offers as task subcollection. This avoids denormalisation into a separate top-level collection.

---

### D-006 — Chat ID === Task ID

Each task has at most one chat, stored at `chats/{taskId}`. This 1:1 mapping simplifies lookups and security rule validation. Chat is created on task acceptance.

---

### D-007 — Transactional Accept (Race Safety)

`acceptOffer` uses a Firestore transaction: read task (must be `searching`), read offer (must be `offered`), then atomically flip task to `accepted` + mark offer as `accepted`. Only one concurrent accept can win. Sibling offers are marked `superseded` outside the transaction (non-critical).

---

### D-008 — Abuse Detection: Rolling-Window Violations

Cancellations and deletions are tracked in `users/{uid}/violations` subcollection. A 7-day rolling window with a threshold of 3 triggers escalation: first strike freezes account, second strike suspends for 3 days (system-initiated).

---

### D-009 — Banned User Purge: 30-Day Retention

`scheduledPurgeBannedUsers` runs daily. Users banned for >30 days have their Auth account, Storage files, and Firestore `users/{uid}` doc (with subcollections) permanently deleted. Tasks, reports, blocks, and adminActions are preserved for audit trail. Dangling UID references are tolerated with fallback rendering.

---

### D-010 — Periodic Redispatch with Nudge Tiers

`periodicRedispatchOffers` runs every 1 minute. Uses the `nextCheckAt` indexed field to efficiently query only tasks due for processing. Radius expansion (1000 m base × tier multiplier) and 3-stage nudge copy progression are tier-dependent (fast/normal/flexible). 

---

### D-011 — Customer-Facing Design System

CSS animation classes prefixed `vc-*` (fade-up, shimmer, check-pop, radar, blip, cell-flip, dot-bounce) form the design system. All animations respect `prefers-reduced-motion`. Font stack: Inter for body, Outfit for headings.

---

### D-012 — Onboarding Classification Logic

AuthState discriminated union (`loading | signed-out | error | no-doc | incomplete | ready`) drives the entire routing guard. Classification checks: consent → roles → profile (displayName + photoURL) → skills (volunteers only).

---

### D-013 — Trail Data Isolation (DPDP Act)

Trail data is stored in a separate `user_trails/{uid}` collection with owner-only read/write. 45-day default retention. Consent is tracked separately with timestamp. Self-serve erasure is supported via `trail-store.ts`.

---

### D-014 — Reporting Window Constraint

Reports are only allowed during active task status (accepted/in_progress) or within 24 hours of completion. Volunteer-side reports additionally require the Start OTP to have been verified (status must be `in_progress` or later). Duplicate reports on the same (reporter, reported, task) triple are rejected.

---

### D-015 — Volunteer Comes Online Matching

`onVolunteerAvailable` Firestore trigger fires when a user doc's `availableNow` flips false→true. It scans all `searching` tasks and writes offer docs for eligible tasks the volunteer doesn't already have offers on. Complements `periodicRedispatchOffers` to cover the "volunteer joins after initial dispatch" gap.

---

### D-016 — Scheduled Tasks

Tasks can be created with `status: 'scheduled'` and a `scheduledFor` timestamp. `activateScheduledTasks` runs every minute and flips eligible tasks to `searching`, triggering `dispatchOffers`. Customers can update the scheduled time via `updateScheduledTask` callable (min lead time: 30 min, max horizon: 7 days).

---

### D-017 — Post-Completion Task Suggestions

`suggestNextTasks` callable surfaces up to 2 nearby open tasks to a volunteer after completing a task. Uses the completed task's location as a proxy for the volunteer's current position. Creates offer docs for suggested tasks so `acceptOffer` works transactionally.

---

### D-018 — Account Status States

Four states: `active` (default), `warned` (admin warning issued), `suspended` (time-limited ban), `banned` (permanent). Additionally `frozenAt` (abuse-detector warning-freeze, orthogonal to account status). `ProtectedRoute` globally intercepts suspended/banned/frozen states.

---

### D-019 — App Check Integration

Firebase App Check with ReCaptcha Enterprise is conditionally initialised. In emulator mode, a debug token is used. In production, requires `VITE_FIREBASE_APPCHECK_SITE_KEY` env var. Gracefully returns `null` if not configured.

---

### D-020 — Volunteer Redispatch Exclusion Invariant

Cancelled and rejected offer documents in `tasks/{taskId}/offers/{volunteerId}` are preserved across task lifecycles and reassignments rather than deleted. Volunteers who have cancelled (tracked in `task.cancelledVolunteerIds` and offer doc with `state: 'cancelled'`) or rejected (`state: 'rejected'`) are excluded server-authoritatively from subsequent dispatch passes, periodic redispatches, radius expansions, availability sweeps, and next-task suggestions. Volunteers with active offers (`state: 'offered'`) are excluded from re-dispatch to prevent duplicate active offers. Superseded volunteers or other eligible volunteers remain eligible for dispatch upon reassignment.

---

### D-021 — Server-Authoritative Admin ID Verification Workflow

ID verification reviews are performed strictly through Cloud Functions (`getAdminIdVerificationUrl`, `reviewIdVerification`, `submitIdVerification`). User documents carry `idVerificationStatus: 'pending' | 'verified' | 'rejected'` alongside server-authoritative `idVerified: boolean`. The Storage document `users/{userId}/id-image` is guarded with `allow read: if false;` in `storage.rules`, completely prohibiting direct client reads; authenticated administrators access the document exclusively via short-lived (15-minute) signed read URLs generated by the Cloud Function after verifying admin claims. Firestore rules forbid client writes to `idVerified`, `idVerificationStatus`, `idVerificationReviewedAt`, `idVerificationReviewedBy`, and `idVerificationRejectionReason`. Missing or deleted storage files strictly fail verification preconditions. Approvals atomically recompute the volunteer trust score (+0.10) and record immutable audit records in `adminActions` and `activityLog`. Medium-risk task eligibility requires `idVerified === true`, while low-risk tasks remain accessible without ID verification.

