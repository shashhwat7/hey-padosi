# File Index

> One line per source file → purpose → key exports.

## Root

| File                      | Purpose                                            | Key Exports / Notes                       |
| ------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `index.html`              | HTML entry point; loads fonts, favicon, meta tags   | `#root` mount point                       |
| `package.json`            | Root dependencies and scripts                      | `volunteer-connector`                     |
| `firebase.json`           | Firebase service config (hosting, firestore, storage, functions, emulators) | Emulator port assignments |
| `.firebaserc`             | Firebase project binding                           | `micro---volunteer`                       |
| `firestore.rules`         | Firestore security rules                           | Deny-by-default + explicit grants         |
| `firestore.indexes.json`  | Composite index definitions                        | tasks: status + nextCheckAt               |
| `storage.rules`           | Storage security rules                             | Profile photo + ID image rules            |
| `tsconfig.json`           | Frontend TypeScript config                         | ES2022, strict, react-jsx                 |
| `tsconfig.node.json`      | Node-side TypeScript config                        | Vite config files                         |
| `vite.config.ts`          | Vite build config                                  | React + Tailwind v4 plugins               |
| `eslint.config.js`        | ESLint flat config                                 | Type-aware for src; react-hooks, jsx-a11y |
| `.prettierrc.json`        | Prettier config                                    | Formatting rules                          |
| `.prettierignore`         | Prettier ignore patterns                           | dist, node_modules, etc.                  |
| `.env.example`            | Environment variable template                      | VITE_FIREBASE_* vars                      |
| `CLAUDE.md`               | AI assistant rules + memory bank index             | Rules of engagement, commands             |
| `CHECKPOINT.md`           | Legacy entry point to memory bank                  | Points to memory-bank/                    |
| `playwright.config.ts`    | Playwright E2E test config                         | Chromium, localhost:5173                   |
| `start-all.bat`           | Windows batch script to start all services         | —                                         |
| `start-all.ps1`           | PowerShell script to start all services            | —                                         |

## src/

| File                      | Purpose                                            | Key Exports                               |
| ------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `main.tsx`                | App entry: mounts AuthProvider + RouterProvider     | —                                         |
| `router.tsx`              | Route table with ProtectedRoute guards             | `router`                                  |
| `index.css`               | Global styles: Tailwind import, fonts, vc-* animations | CSS animation classes                  |
| `vite-env.d.ts`           | Vite client type declarations + env var types      | —                                         |

## src/lib/

| File                         | Purpose                                         | Key Exports                               |
| ---------------------------- | ----------------------------------------------- | ----------------------------------------- |
| `firebase.ts`                | Firebase SDK init + emulator wiring              | `getFirebaseApp`, `auth`, `db`, `storage`, `functions`, `appCheck` |
| `auth-context.tsx`           | Auth state provider (discriminated union)        | `AuthProvider`, `useAuthState`, `UserDoc`, `AuthState`, `Role` |
| `protected-route.tsx`        | Route guard + banned/suspended/frozen screens    | `ProtectedRoute`, `RequiredStep`          |
| `auth-errors.ts`             | Firebase Auth error → user message mapping       | `readableAuthError`                       |
| `catalog.ts`                 | Typed access to seed catalog JSON                | `CATEGORIES`, `SKILLS`, `getCategory`, `getSkillLabel`, `deriveRisk` |
| `geolocation.ts`             | Browser geolocation wrapper (promise-based)      | `getCurrentLocation`, `BrowserLocation`, `GeolocationError` |
| `use-active-role.ts`         | Hook: active role for dual-role users            | `useActiveRole`, `ActiveRole`             |
| `use-redirect-when-signed-in.ts` | Hook: redirect to correct step on sign-in   | `useRedirectWhenSignedIn`                 |

## src/lib/trail-service/

| File                       | Purpose                                          | Key Exports                               |
| -------------------------- | ------------------------------------------------ | ----------------------------------------- |
| `types.ts`                 | TrailService data models and constants            | `StayPoint`, `Trip`, `CanonicalRoute`, `DepartureEvent`, `TaskSuggestion`, `TrailConsent`, `LocationPing`, `TRAIL_CONSTANTS` |
| `trail-store.ts`           | Firestore persistence for trail data + consent    | Trail CRUD functions, consent management  |
| `stay-point-detector.ts`   | Detect stay points from location pings            | Stay-point detection logic                |
| `trip-segmenter.ts`        | Segment trips between stay points                 | Trip segmentation logic                   |
| `route-clusterer.ts`       | Cluster trips into canonical routes               | Route clustering logic                    |
| `departure-detector.ts`    | Detect departures from stay points                | Departure detection logic                 |
| `corridor-matcher.ts`      | Match tasks to route corridors                    | Corridor matching logic                   |

## src/pages/

| File                      | Purpose                                            | Key Exports                               |
| ------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `HomePage.tsx`            | Public landing page (brand, features, CTA)         | `default` export                          |
| `LoginPage.tsx`           | Login page (phone + email auth tabs)               | `default` export                          |
| `SignupPage.tsx`          | Signup page (phone + email auth tabs)              | `default` export                          |
| `AppHomePage.tsx`         | Main app hub: renders Customer or Volunteer dashboard | `default` export                       |
| `CreateTaskPage.tsx`      | Task creation form (category, skills, location, description) | `default` export                |
| `TaskDetailPage.tsx`      | Task detail: lifecycle view for both roles         | `default` export                          |
| `AdminDashboard.tsx`      | Admin panel: reports, user lookup, moderation, activity log | `default` export                 |
| `YourRoutesPage.tsx`      | View/manage saved commute routes                   | `YourRoutesPage`                          |

## src/pages/onboarding/

| File                      | Purpose                                            | Key Exports                               |
| ------------------------- | -------------------------------------------------- | ----------------------------------------- |
| `ConsentPage.tsx`         | T&C consent with version + timestamp               | `default` export                          |
| `RolePage.tsx`            | Role selection (customer/volunteer/both)            | `default` export                          |
| `ProfilePage.tsx`         | Profile setup (name, photo, optional ID image, bio) | `default` export                         |
| `SkillsPage.tsx`          | Skills selection (volunteers only)                 | `default` export                          |

## src/components/

| File                            | Purpose                                      | Key Exports                               |
| ------------------------------- | -------------------------------------------- | ----------------------------------------- |
| `CustomerDashboard.tsx`         | Customer home: my tasks, create, lifecycle   | `default` export                          |
| `VolunteerDashboard.tsx`        | Volunteer home: offer inbox, accepted tasks  | `default` export                          |
| `ChatPanel.tsx`                 | In-app chat UI with message list + input     | `default` export                          |
| `OfferInbox.tsx`                | Volunteer's pending offers list              | `default` export                          |
| `AcceptedTasksList.tsx`         | Volunteer's accepted tasks list              | `default` export                          |
| `MyTasksList.tsx`               | Customer's posted tasks list                 | `default` export                          |
| `RoleSwitcher.tsx`              | Dual-role toggle (customer ↔ volunteer)      | `default` export                          |
| `CrossRoleBanner.tsx`           | Banner for dual-role context switching       | `default` export                          |
| `AuthMethodTabs.tsx`            | Phone/Email auth method selector tabs        | `default` export                          |
| `PhoneAuthForm.tsx`             | Phone number + OTP verification form         | `default` export                          |
| `EmailAuthForm.tsx`             | Email/password sign-in/up form               | `default` export                          |
| `TaskLocationPicker.tsx`        | Leaflet map-based location picker + H3       | `default` export                          |
| `CustomerOtpPanel.tsx`          | Customer's OTP generation UI                 | `default` export                          |
| `VolunteerOtpPanel.tsx`         | Volunteer's OTP entry/verification UI        | `default` export                          |
| `CustomerRatingPanel.tsx`       | Post-completion volunteer rating form        | `default` export                          |
| `ReportBlockPanel.tsx`          | Report/block user UI (in chat and task)      | `default` export                          |
| `BlockedUsersList.tsx`          | View/unblock blocked users                   | `default` export                          |
| `KarmaBadge.tsx`                | Karma/trust score display badge              | `default` export                          |
| `KarmaToast.tsx`                | Points earned toast notification             | `default` export                          |
| `SkillIcon.tsx`                 | SVG icons for all 25 skills                  | `default` export                          |
| `Logo.tsx`                      | App logo component                           | `default` export                          |
| `OnboardingProgress.tsx`        | Step progress indicator for onboarding       | `default` export                          |
| `ReasonBottomSheet.tsx`         | Bottom sheet for cancel/delete reason selection | `default` export                        |
| `ScheduleTaskBottomSheet.tsx`   | Bottom sheet for scheduling a task           | `default` export                          |
| `PostCompletionSuggestionCard.tsx` | Post-completion nearby task suggestion card | `default` export                         |
| `DeparturePromptModal.tsx`      | Modal for trail-based departure prompts      | `default` export                          |

## src/assets/

| File                      | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `hey-padosi-logo.png`     | App logo image (also in public/)                   |

## functions/src/

| File                              | Purpose                                      | Key Exports                               |
| --------------------------------- | -------------------------------------------- | ----------------------------------------- |
| `index.ts`                        | Functions entry point; re-exports all functions | All 24 exported functions                |
| `scoring.ts`                      | Matching formula, eligibility, ranking        | `rankForTask`, `rankForCorridor`, `isEligible`, `score`, `haversineM`, `ScoreBreakdown`, `RankedVolunteer`, `TaskDoc`, `UserDoc` |
| `dispatch-offers.ts`              | Firestore trigger: fan out offers on task create | `dispatchOffers`                        |
| `accept-offer.ts`                 | Callable: volunteer accepts task              | `acceptOffer`                             |
| `reject-offer.ts`                 | Callable: volunteer rejects offer             | `rejectOffer`                             |
| `generate-start-otp.ts`           | Callable: customer generates start OTP        | `generateStartOtp`                        |
| `verify-start-otp.ts`             | Callable: volunteer verifies start OTP        | `verifyStartOtp`                          |
| `generate-end-otp.ts`             | Callable: customer generates end OTP          | `generateEndOtp`                          |
| `verify-end-otp.ts`               | Callable: volunteer verifies end OTP          | `verifyEndOtp`                            |
| `submit-customer-rating.ts`       | Callable: customer rates volunteer            | `submitCustomerRating`                    |
| `award-points-on-completion.ts`   | Trigger: award points on task completion      | `awardPointsOnCompletion`                 |
| `recompute-trust-score.ts`        | Shared: trust score computation               | `recomputeTrustScore`, `computeTrustScorePure` |
| `report-user.ts`                  | Callable: submit user report                  | `reportUser`                              |
| `block-user.ts`                   | Callable: block another user                  | `blockUser`                               |
| `unblock-user.ts`                 | Callable: unblock a user                      | `unblockUser`                             |
| `apply-moderation-action.ts`      | Callable: admin moderation (warn/suspend/ban/dismiss) | `applyModerationAction`          |
| `on-volunteer-available.ts`       | Trigger: dispatch offers when volunteer goes online | `onVolunteerAvailable`              |
| `periodic-redispatch-offers.ts`   | Scheduled: re-dispatch + radius expansion     | `periodicRedispatchOffers`, `computeNudgeUpdate`, `computeNextCheckAt` |
| `suggest-next-tasks.ts`           | Callable: post-completion task suggestions    | `suggestNextTasks`                        |
| `cancel-accepted-task.ts`         | Callable: volunteer cancels accepted task     | `cancelAcceptedTask`                      |
| `delete-task.ts`                  | Callable: customer deletes own task           | `deleteTask`                              |
| `unfreeze-account.ts`             | Callable: acknowledge warning freeze          | `unfreezeAccount`                         |
| `activate-scheduled-tasks.ts`     | Scheduled: flip scheduled tasks to searching  | `activateScheduledTasks`, `SCHEDULING_CONFIG` |
| `update-scheduled-task.ts`        | Callable: update scheduled task time          | `updateScheduledTask`, `validateScheduledTime` |
| `scheduled-purge-banned-users.ts` | Scheduled: purge banned users after 30 days   | `scheduledPurgeBannedUsers`               |
| `rank-nearby-volunteers.ts`       | Callable: customer previews volunteer ranking | `rankNearbyVolunteers`                    |
| `otp.ts`                          | Shared: OTP generation, hashing, comparison   | `generateOtpCode`, `generateSalt`, `hashOtp`, `constantTimeEquals`, `OTP_TTL_MS` |
| `chat.ts`                         | Shared: chat creation + system messages       | `ensureChatForTask`, `appendSystemMessage` |
| `audit.ts`                        | Shared: task audit trail writer               | `writeAuditEvent`, `AuditEventType`       |
| `activity-log.ts`                 | Shared: site-wide activity log writer         | `appendActivityLog`, `safeDisplayName`, `ActivityEventType` |
| `abuse-detector.ts`               | Shared: violation tracking + escalation       | `recordViolationAndCheckAbuse`, `VIOLATION_WINDOW_DAYS`, `VIOLATION_FREEZE_THRESHOLD` |
| `moderation-helper.ts`            | Shared: active status check guard             | `checkActiveStatus`                       |
| `nudge-copy-bank.ts`              | Shared: wait-tier config + nudge copy         | `WAIT_TIER_CONFIG`, `NUDGE_COPY_BANK`, `NEARING_EXPIRY_COPY`, `WaitTier` |
| `log-user-registered.ts`          | Shared: log user registration event           | —                                         |

## functions/src/ (Test Files)

| File                              | Purpose                                      |
| --------------------------------- | -------------------------------------------- |
| `scoring.test.ts`                 | Tests for matching formula and eligibility    |
| `otp-helpers.test.ts`             | Tests for OTP generation and hashing          |
| `abuse-detector.test.ts`          | Tests for abuse detection logic               |
| `security-rules.test.ts`          | Firestore security rules unit tests           |
| `transactions.test.ts`            | Transaction-related tests                     |
| `trust-scoring.test.ts`           | Trust score computation tests                 |
| `points.test.ts`                  | Points awarding tests                         |
| `batch3-batch4.test.ts`           | Batch test suite (M3–M4 features)             |
| `batch5-batch7.test.ts`           | Batch test suite (M5–M7 features)             |
| `scheduled-tasks.test.ts`         | Scheduled task activation tests               |
| `suggest-next-tasks.test.ts`      | Post-completion suggestion tests              |
| `periodic-redispatch-offers.test.ts` | Periodic redispatch tests                  |
| `unblock-user.test.ts`            | Unblock user tests                            |
| `risk-validation.test.ts`         | Risk validation tests                         |
| `redispatch-exclusions.test.ts`   | Batch 4: Volunteer redispatch exclusion tests |

## scripts/

| File                                | Purpose                                    |
| ----------------------------------- | ------------------------------------------ |
| `dev-all.js`                        | Orchestrates functions build:watch + emulators + vite dev |
| `start-emulators.js`               | Starts Firebase emulators with import/export |
| `seed-all.js`                       | Seeds admin + users into emulators          |
| `seed-admin.js`                     | Seeds admin user                            |
| `seed-users.js`                     | Seeds test users                            |
| `generate-evidence-workbook.js`     | Generates test evidence Excel workbook      |
| `seed/catalog.json`                 | Starter catalog: 7 categories, 25 skills    |

## e2e/

| File                      | Purpose                                            |
| ------------------------- | -------------------------------------------------- |
| `phase1b-e2e.spec.ts`    | Playwright E2E test spec for Phase 1B              |

## docs/

| Directory            | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `product-discovery/` | 12+ product discovery documents (audit, competitive analysis, roadmap, UX improvements) |
| `testing/`           | Test evidence workbook (`phase1b-test-evidence.xlsx`) |
