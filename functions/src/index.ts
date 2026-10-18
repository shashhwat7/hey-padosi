// Cloud Functions entry point.
// Governs: memory-bank/systemPatterns.md (server-authoritative model).
// Each function lives in its own file and is re-exported here so the
// emulator + deploy pipeline can find them by export name.

export { rankNearbyVolunteers } from './rank-nearby-volunteers';
export { dispatchOffers } from './dispatch-offers';
export { acceptOffer } from './accept-offer';
export { rejectOffer } from './reject-offer';
export { generateStartOtp } from './generate-start-otp';
export { verifyStartOtp } from './verify-start-otp';
export { generateEndOtp } from './generate-end-otp';
export { verifyEndOtp } from './verify-end-otp';
export { submitCustomerRating } from './submit-customer-rating';
export { awardPointsOnCompletion } from './award-points-on-completion';
export { reportUser } from './report-user';
export { blockUser } from './block-user';
export { applyModerationAction } from './apply-moderation-action';
export { scheduledPurgeBannedUsers } from './scheduled-purge-banned-users';
export { onVolunteerAvailable } from './on-volunteer-available';
export { periodicRedispatchOffers } from './periodic-redispatch-offers';
export { suggestNextTasks } from './suggest-next-tasks';
export { unblockUser } from './unblock-user';
export { cancelAcceptedTask } from './cancel-accepted-task';
export { deleteTask } from './delete-task';
export { unfreezeAccount } from './unfreeze-account';
export { activateScheduledTasks } from './activate-scheduled-tasks';
export { updateScheduledTask } from './update-scheduled-task';
export {
  getAdminIdVerificationUrl,
  reviewIdVerification,
  submitIdVerification,
} from './review-id-verification';

