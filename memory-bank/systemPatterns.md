# System Patterns

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  Browser (React 19 SPA on Vite 8)               │
│  ┌───────────────────────────────────────────┐   │
│  │ AuthProvider → ProtectedRoute → Pages     │   │
│  │ Firebase Client SDK (Auth/Firestore/      │   │
│  │   Storage/Functions)                      │   │
│  │ TrailService (client-side, owner-only)    │   │
│  └───────────────────────────────────────────┘   │
└─────────┬───────────────────────────┬────────────┘
          │ Firestore listeners       │ HTTPS callables
          │ (onSnapshot)              │ (httpsCallable)
          ▼                           ▼
┌─────────────────────────────────────────────────┐
│  Firebase Backend (asia-south1)                  │
│  ┌────────┐ ┌───────────┐ ┌────────┐ ┌───────┐ │
│  │ Auth   │ │ Firestore │ │Storage │ │Hosting│ │
│  │ :9099  │ │  :8080    │ │ :9199  │ │ :5002 │ │
│  └────────┘ └───────────┘ └────────┘ └───────┘ │
│  ┌─────────────────────────────────────────────┐ │
│  │ Cloud Functions v2 (:5001)                  │ │
│  │  Callables · Triggers · Scheduled           │ │
│  │  Admin SDK (bypasses security rules)        │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

**Server-authoritative model**: trust scores, points, OTP generation/verification, matching ranking, moderation actions, and abuse detection all live in Cloud Functions only. Clients read computed values from Firestore but cannot write to server-only fields.

## Firestore Data Model

### Top-Level Collections

| Collection       | Doc ID                    | Purpose                                     |
| ---------------- | ------------------------- | ------------------------------------------- |
| `users`          | `{uid}`                   | User profile, roles, trust, points, status  |
| `tasks`          | `{taskId}` (auto)         | Task lifecycle, location, OTP hashes        |
| `reports`        | `{reportId}` (auto)       | User reports (pending / actioned / dismissed) |
| `blocks`         | `{blockId}` (auto)        | Mutual user blocks (userA, userB)           |
| `adminActions`   | `{actionId}` (auto)       | Moderation action log (admin-only write)    |
| `activityLog`    | `{entryId}` (auto)        | Site-wide activity feed (admin read-only)   |
| `chats`          | `{taskId}`                | Per-task chat doc (chatId === taskId)        |
| `user_trails`    | `{userId}`                | TrailService consent + route data           |

### Subcollections

| Parent            | Subcollection     | Doc ID             | Purpose                                  |
| ----------------- | ----------------- | ------------------ | ---------------------------------------- |
| `tasks/{taskId}`  | `offers`          | `{volunteerId}`    | Per-volunteer offer docs (fan-out)        |
| `tasks/{taskId}`  | `events`          | auto               | Append-only task audit trail              |
| `chats/{taskId}`  | `messages`        | auto               | Chat messages                            |
| `users/{uid}`     | `moderationLog`   | auto               | Admin moderation entries                  |
| `users/{uid}`     | `violations`      | auto               | Abuse-detector violation records          |
| `user_trails/{uid}` | `routes`        | `{routeId}`        | Canonical commute routes                  |
| `user_trails/{uid}` | `events`        | `{eventId}`        | Departure events                          |

### users/{uid} Fields

**Client-writable on create**: displayName, photoURL, bio, phoneNumber, email, roles, skills, consent, createdAt.

**Client-writable on update**: displayName, photoURL, bio, phoneNumber, email, roles, skills, idImagePath, availableNow, availabilityUpdatedAt, lastKnownLocation, freezeAcknowledgedAt.

**Server-only fields** (written by Cloud Functions via Admin SDK):
idVerified, trustScore, verifiedTaskCount, verifiedHours, points, skillPoints, openReportsCount, warningsCount, suspendedUntil, banned, lastSeenAt, isAdmin, pendingReports, accountStatus, moderationReason, frozenAt, frozenReason, warningStrikeCount, bannedAt, reportPenalty.

### tasks/{taskId} Key Fields

- customerId, customerName, customerPhotoURL, title, category, requiredSkills, description (meetingPoint, whatToBring, preference?, safetyNote?), location (lat, lng, h3Cell), riskLevel, estimatedMinutes, status, searchRadiusM, createdAt, expiresAt
- Scheduled: scheduledFor, scheduledCreatedAt
- Lifecycle (server-written): acceptedVolunteerId, acceptedAt, startedAt, completedAt
- OTP (server-written): startOtpHash, startOtpSalt, startOtpExpiresAt, endOtpHash, endOtpSalt, endOtpExpiresAt
- Rating (server-written): customerRating, customerRatingComment, customerRatedAt
- Redispatch: lastRedispatchAt, nextCheckAt, lastNudgeStage, lastNudgeSentAt, statusMessage, nearingExpiry
- Wait tier: expectedWaitTier (fast/normal/flexible), waitStartedAt
- Reassignment: cancelledVolunteerIds (array of volunteer UIDs excluded from redispatch)

### offers/{volunteerId} Fields

volunteerId, taskId, customerId, taskTitle, taskCategory, taskRiskLevel, displayName, photoURL, state (offered/accepted/rejected/superseded/cancelled), score, scoreBreakdown, distanceM, offeredAt, respondedAt.

### chats/{taskId} Fields

taskId, participants (2-element array), createdAt, lastMessageAt, lastMessagePreview.

### chats/{taskId}/messages/{msgId} Fields

senderUid, text, sentAt, system (boolean). Server-added: reportedBy (array).

## Firestore Indexes

Composite index on `tasks`: `status` ASC + `nextCheckAt` ASC (used by periodic redispatch).

## Security Rules Summary

### Firestore

- Deny-by-default; explicit grants only.
- `users/{uid}`: owner read/create/update; admin read. Server-only fields enforced via allowlists. No client delete.
- `tasks/{taskId}`: read by customer or accepted volunteer or admin (suspended/banned users blocked). Create by customer (field validation + risk check). No client update or delete.
- `tasks/{taskId}/offers/{volunteerId}`: read by task customer. No client write.
- `tasks/{taskId}/events/{eventId}`: read by customer or accepted volunteer or admin. No client write.
- `reports/{reportId}`: read by reporter or admin. Create by Cloud Function only. Update by admin.
- `blocks/{blockId}`: read by either party. Write by Cloud Function only.
- `adminActions/{actionId}`: read by target user or admin. Write by Cloud Function only.
- `activityLog/{entryId}`: admin read only. Write by Cloud Function only.
- `chats/{chatId}`: participant-only read/create/update. Create validates taskId, participants, and task status. Update restricted to lastMessageAt + lastMessagePreview.
- `chats/{chatId}/messages/{msgId}`: participant read + create (senderUid must match, system must be false, text ≤ 1000 chars). Mutual block check via `canPostMessage`. No client update/delete.
- `users/{uid}/moderationLog`, `users/{uid}/violations`: owner + admin read. No client write.
- `user_trails/{userId}` + subcollections: owner read/write (suspended/banned blocked).
- Collection-group `offers`: volunteer reads own offers via `volunteerId == auth.uid`.
- Suspended/banned users globally blocked from task reads, offers, chat.

### Storage

- Deny-by-default.
- `/users/{uid}/photo`: any signed-in user can read; owner write/delete (JPEG/PNG/WebP ≤ 2 MB).
- `/users/{uid}/id-image`: no client read (Admin SDK only); owner write/delete.

## Cloud Functions Inventory

All functions deploy to `asia-south1`.

### HTTPS Callables

| Function                | Trigger     | Purpose                                         |
| ----------------------- | ----------- | ----------------------------------------------- |
| `rankNearbyVolunteers`  | callable    | Customer previews ranked volunteer list          |
| `acceptOffer`           | callable    | Volunteer accepts task (transactional)           |
| `rejectOffer`           | callable    | Volunteer rejects task offer                     |
| `generateStartOtp`      | callable    | Customer generates start OTP                     |
| `verifyStartOtp`        | callable    | Volunteer verifies start OTP                     |
| `generateEndOtp`        | callable    | Customer generates end OTP                       |
| `verifyEndOtp`          | callable    | Volunteer verifies end OTP                       |
| `submitCustomerRating`  | callable    | Customer rates volunteer (1–5 + optional comment) |
| `reportUser`            | callable    | Submit user/message report                       |
| `blockUser`             | callable    | Block another user                               |
| `unblockUser`           | callable    | Unblock a previously blocked user                |
| `applyModerationAction` | callable    | Admin: warn/suspend/ban/dismiss                  |
| `cancelAcceptedTask`    | callable    | Volunteer cancels accepted task                  |
| `deleteTask`            | callable    | Customer deletes own task                        |
| `unfreezeAccount`       | callable    | User acknowledges warning freeze                 |
| `suggestNextTasks`      | callable    | Post-completion task suggestions (up to 2)       |
| `updateScheduledTask`   | callable    | Customer updates scheduled time                  |

### Firestore Triggers

| Function                  | Trigger                                 | Purpose                                          |
| ------------------------- | --------------------------------------- | ------------------------------------------------ |
| `dispatchOffers`          | `onDocumentWritten(tasks/{taskId})`      | Fan out offers on task create or back-to-searching |
| `awardPointsOnCompletion` | `onDocumentUpdated(tasks/{taskId})`      | Award points + recompute trust on completion      |
| `onVolunteerAvailable`    | `onDocumentUpdated(users/{uid})`         | Dispatch offers when volunteer goes available     |

### Scheduled Functions

| Function                     | Schedule          | Purpose                                      |
| ---------------------------- | ----------------- | -------------------------------------------- |
| `periodicRedispatchOffers`   | every 1 minute    | Re-dispatch + radius expansion + nudge copy  |
| `scheduledPurgeBannedUsers`  | daily             | Purge banned users after 30-day retention    |
| `activateScheduledTasks`     | every 1 minute    | Flip `scheduled` tasks to `searching`        |

### Shared Modules (non-exported)

| Module                    | Purpose                                           |
| ------------------------- | ------------------------------------------------- |
| `scoring.ts`              | Matching formula, eligibility, ranking, haversine  |
| `recompute-trust-score.ts`| Trust score computation                            |
| `otp.ts`                  | OTP generation, hashing, constant-time comparison  |
| `chat.ts`                 | Chat creation + system message helper              |
| `audit.ts`                | Task event audit trail writer                      |
| `activity-log.ts`         | Site-wide activity log writer                      |
| `abuse-detector.ts`       | Violation recording + freeze/suspend escalation    |
| `moderation-helper.ts`    | Active status check (shared guard)                 |
| `nudge-copy-bank.ts`      | Wait-tier configs + nudge stage copy               |

## Matching Formula

```
score = 0.30 × distance       (1 - gridDist/15, clamped [0,1])
      + 0.25 × skill          (overlap / required)
      + 0.20 × trust          (trustScore / 100)
      + 0.15 × availability   (always 1.0 currently)
      + 0.10 × pastCompletion (min(1, 0.2 + verified × 0.05))
      - reportPenalty          (min(0.5, reports × 0.1 + warnings × 0.15))
```

Eligibility filters: not the customer, not banned/suspended, is a volunteer, has location, has overlapping skills, within search radius (haversine), medium-risk requires `idVerified`.

## Trust Score Formula

```
rawScore = 0.35 × min(1, verifiedTaskCount / 20)
         + 0.30 × scaledAvgRating (avgRating / 5.0; defaults to 1.0 for no ratings)
         + 0.15 × min(1, verifiedHours / 40)
         + 0.10 × (idVerified ? 1 : 0)
         - reportPenalty
trustScore = round(clamp(rawScore, 0.3, 1.0) × 100)   // range: 30–100
```

## Points System

- Volunteer: base 10 pts + 1 pt per 15 min estimated (capped at +8 bonus) = 10–18 pts per task.
- Customer (dual-role with volunteer): 2 pts per completed task.
- Skill-specific points: +1 per required skill on completion.
- Points and verified hours tracked on `users/{uid}` doc.

## Abuse Detection

- Violations: `volunteer_cancel_after_accept` and `customer_task_delete`.
- Rolling 7-day window: ≥3 violations triggers escalation.
- Strike 1: account frozen (warning screen, user must acknowledge).
- Strike 2+: 3-day system-initiated suspension.
- Frozen screen shown in `ProtectedRoute`; acknowledged via `unfreezeAccount` callable.

## Wait Tier System

| Tier       | Nudge stages (minutes) | Radius step multiplier |
| ---------- | ---------------------- | ---------------------- |
| `fast`     | 3, 8, 15               | 1.5×                   |
| `normal`   | 5, 15, 30              | 1.0×                   |
| `flexible` | 10, 30, 60             | 0.75×                  |

Base radius bump: 1000 m per redispatch. Max radius: 10,000 m.

## PII Inventory

| Field                        | Location                    | Sensitivity | Notes                                   |
| ---------------------------- | --------------------------- | ----------- | --------------------------------------- |
| Phone number                 | `users/{uid}.phoneNumber`   | PII         | Never logged; Auth OTP via Firebase     |
| Email                        | `users/{uid}.email`         | PII         | Never logged                            |
| Display name                 | `users/{uid}.displayName`   | PII         | Public within app                       |
| Photo                        | Storage `/users/{uid}/photo`| PII         | Readable by any signed-in user          |
| ID image                     | Storage `/users/{uid}/id-image` | Sensitive PII | No client read; Admin SDK only      |
| Location (lat/lng)           | `users/{uid}.lastKnownLocation` | PII     | Never logged as precise coords          |
| Location H3 cell             | `users/{uid}.lastKnownLocation.h3Cell` | Reduced PII | Resolution 9              |
| Task location                | `tasks/{taskId}.location`   | PII         | H3 cell + lat/lng                       |
| Auth tokens / OTPs           | In memory only              | Secret      | Never logged, never stored in plaintext |
| Trail data                   | `user_trails/{uid}/**`      | Sensitive PII | Owner-only; 45-day default retention |
| Consent timestamp            | `users/{uid}.consent`       | Compliance  | T&C version + acceptedAt                |

## UI Patterns

- **AuthState discriminated union**: `loading | signed-out | error | no-doc | incomplete | ready`. All route guards and pages pattern-match on this.
- **ProtectedRoute**: route guard with `requires` prop (`consent | role | profile | skills | ready`). Globally intercepts banned/suspended/frozen users.
- **Dual dashboards**: `CustomerDashboard` and `VolunteerDashboard` rendered by `AppHomePage` based on `useActiveRole` hook. `RoleSwitcher` for dual-role users.
- **Onboarding steps**: ConsentPage → RolePage → ProfilePage → SkillsPage (volunteers only).
- **Animation system**: `vc-*` CSS classes (fade-up, fade-in, shimmer, check-pop, radar, cell-flip, dot-bounce). `prefers-reduced-motion` respected.
- **Component composition**: large dashboard components (CustomerDashboard ~76KB, VolunteerDashboard ~103KB) contain embedded sub-views for different lifecycle states. Task detail page handles both customer and volunteer perspectives.
- **Map integration**: `TaskLocationPicker` uses react-leaflet for task location selection with H3 cell computation.
- **TrailService**: client-side module (`src/lib/trail-service/`) for commute trail detection — stay-point detection, trip segmentation, route clustering, departure detection, corridor matching. Data stored in `user_trails/{uid}` with owner-only access. `YourRoutesPage` renders saved routes.

## Routing

| Path                       | Component         | Guard         |
| -------------------------- | ----------------- | ------------- |
| `/`                        | HomePage          | none (public) |
| `/login`                   | LoginPage         | none (public) |
| `/signup`                  | SignupPage        | none (public) |
| `/onboarding/consent`      | ConsentPage       | `consent`     |
| `/onboarding/role`         | RolePage          | `role`        |
| `/onboarding/profile`      | ProfilePage       | `profile`     |
| `/onboarding/skills`       | SkillsPage        | `skills`      |
| `/app`                     | AppHomePage       | `ready`       |
| `/your-routes`             | YourRoutesPage    | `ready`       |
| `/create-task`             | CreateTaskPage    | `ready`       |
| `/tasks/:taskId`           | TaskDetailPage    | `ready`       |
| `/app/tasks/:taskId`       | TaskDetailPage    | `ready`       |
| `/admin`                   | AdminDashboard    | `ready` + admin |
| `*`                        | → `/app`          | redirect      |
