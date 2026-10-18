# Progress

## Current State

All 8 milestones (M0–M8) are implemented. The codebase contains the full Phase 1 MVP feature set including auth, onboarding, task posting, matching engine, OTP proof of work, in-app chat, points/trust/safety, and admin moderation.

## Milestone Summary

| Milestone | Name                           | Status    |
| --------- | ------------------------------ | --------- |
| M0        | Foundation                     | ✅ Done   |
| M1        | Auth & roles                   | ✅ Done   |
| M2        | Profile & availability         | ✅ Done   |
| M3        | Task posting & risk            | ✅ Done   |
| M4        | Matching engine                | ✅ Done   |
| M5        | Notifications & lifecycle      | ✅ Done   |
| M6        | OTP proof of work              | ✅ Done   |
| M7        | Chat                           | ✅ Done   |
| M8        | Points & trust/safety/admin    | ✅ Done   |

## What's Implemented

### Auth & Onboarding (M1–M2)
- Phone auth (Firebase SMS OTP) + Email/password auth with `AuthMethodTabs`
- Four-step onboarding: Consent → Role → Profile → Skills
- `ProtectedRoute` guard with step-based redirects
- Dual-role support with `RoleSwitcher` and localStorage persistence

### Task Posting (M3)
- `CreateTaskPage` with category/skills selection, location picker (Leaflet map), description fields
- Risk validation (low/medium only; high/prohibited blocked)
- Scheduled task creation with `scheduledFor` timestamp
- Search radius configuration (500–10,000 m) and wait tier selection

### Matching Engine (M4)
- Server-side scoring formula in `scoring.ts`
- `dispatchOffers` trigger on task create/write
- `periodicRedispatchOffers` scheduled function (every 1 min)
- `onVolunteerAvailable` trigger for late-joining volunteers
- `rankNearbyVolunteers` callable for customer preview
- Block-aware matching (mutual blocks excluded)

### Task Lifecycle (M5)
- `acceptOffer` (transactional), `rejectOffer`
- Nudge copy progression (3 stages per wait tier)
- Radius expansion on redispatch
- `cancelAcceptedTask` and `deleteTask` with abuse detection
- `activateScheduledTasks` for scheduled → searching transition
- `updateScheduledTask` for time modifications

### OTP Proof of Work (M6)
- Start OTP: `generateStartOtp` → `verifyStartOtp`
- End OTP: `generateEndOtp` → `verifyEndOtp`
- SHA-256 hash with random salt, 10-minute TTL, constant-time comparison
- Customer/Volunteer OTP panels in task detail page

### Chat (M7)
- Per-task chat with `ChatPanel` component
- System messages for lifecycle events
- Message reporting (flag individual messages)
- Mutual-block enforcement (can't post if blocked)
- `ReportBlockPanel` for in-chat user reporting

### Points & Trust/Safety/Admin (M8)
- Point awarding on completion (base 10 + duration bonus)
- Trust score recomputation on completion and moderation
- Karma badge and toast components
- Admin dashboard with report queue, user lookup, moderation actions (warn/suspend/ban/dismiss)
- Abuse detector (rolling 7-day window, freeze → suspend escalation)
- Banned user purge (30-day daily cleanup)
- Activity log (admin-only audit feed)
- Block/unblock users
- Account freeze/unfreeze flow

### Additional Features
- TrailService: stay-point detection, trip segmentation, route clustering, departure detection, corridor matching (stub). `YourRoutesPage` for viewing routes.
- `suggestNextTasks`: post-completion task suggestions
- `PostCompletionSuggestionCard` component
- `DeparturePromptModal` for trail-based departure prompts
- Cross-role banner for dual-role users
- Accepted tasks list, my tasks list, offer inbox components
- App Check integration (ReCaptcha Enterprise)
- E2E test suite (Playwright, `e2e/phase1b-e2e.spec.ts`)
- Cloud Function test suite (unit tests for scoring, OTP, abuse detection, security rules, transactions, trust scoring, scheduled tasks, suggest-next-tasks, periodic redispatch)
- Evidence workbook generator script (`scripts/generate-evidence-workbook.js`)
- Product discovery documentation suite (`docs/product-discovery/`)

### Production Hardening Batches (Pre-Production Audit Fixes)
- **Batch 1 (PB-1 & PB-2)**: Atomic failed-attempt tracking with 5-attempt lockout for Start/End OTPs (`verifyStartOtp`, `verifyEndOtp`, `generateStartOtp`, `generateEndOtp`); atomic transaction idempotency for reward points (`awardPointsOnCompletion`).
- **Batch 2**: Firestore composite index coverage in `firestore.indexes.json` for multi-field queries across functions and client dashboards.
- **Batch 3**: Open searching task read visibility for authenticated volunteers in `firestore.rules`; server-authoritative 24-hour task expiry enforcement in `periodicRedispatchOffers` and transactional `acceptOffer`.
- **Batch 4**: Volunteer redispatch exclusion fix. Preserved cancelled/rejected offer documents instead of wiping subcollection on reassignment in `dispatchOffers`. Added server-authoritative exclusion of cancelled (`task.cancelledVolunteerIds`, offer `state: 'cancelled'`) and rejected (`state: 'rejected'`) volunteers across initial dispatch, periodic redispatch, radius expansion, and next-task suggestions.
- **Batch 5**: Admin ID Verification workflow. Server-authoritative ID verification review via Cloud Functions (`getAdminIdVerificationUrl`, `reviewIdVerification`, `submitIdVerification`). Protected Storage path (`users/{userId}/id-image`) with deny-by-default client reads (`allow read: if false;`) and short-lived (15 min) signed URLs exclusively generated for verified admins. Guarded against false approvals of deleted/missing files. Preserved server-only restriction on `idVerified` and `idVerificationStatus` in `firestore.rules`. Corrected volunteer UI to reflect real verification states (`Verified by Administrator`, `Pending Admin Review`, `Rejected`, `Not Submitted`). Added comprehensive admin verification triage panel with document preview modal, quick approve/reject, and audit logging to `adminActions` and `activityLog`.

## What's Next

- Push notifications (FCM) — out of scope for Phase 1
- Corridor matching implementation (data model exists, logic is a stub)
- Component decomposition for large dashboard files
- Multi-language support (i18n)
- Native mobile apps
- Admin catalog management UI (currently uses static JSON file)
