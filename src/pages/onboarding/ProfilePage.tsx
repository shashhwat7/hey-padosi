// Profile onboarding (step 3) — captures name (required), photo (required),
// and an optional bio for everyone. Plus an optional ID image for admin verification.
// Skills moved to step 4 (/onboarding/skills) — volunteers only.
// Stored at fixed Storage paths:
//   users/{uid}/photo
//   users/{uid}/id-image

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { doc, updateDoc } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { ref as storageRef, uploadBytes } from 'firebase/storage';
import { useAuthState } from '../../lib/auth-context';
import { db, functions, storage } from '../../lib/firebase';
import { OnboardingProgress } from '../../components/OnboardingProgress';
import { Logo } from '../../components/Logo';

const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_NAME = 80;
const MAX_BIO = 280;

function validateImage(file: File): string | null {
  if (!ALLOWED_MIME.includes(file.type)) {
    return 'Please select a valid JPEG, PNG, or WebP image.';
  }
  if (file.size > MAX_BYTES) {
    return 'Image file size must be 2 MB or smaller.';
  }
  return null;
}

export default function ProfilePage() {
  const state = useAuthState();
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [idFile, setIdFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameId = useId();
  const bioId = useId();
  const errorId = useId();
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const idInputRef = useRef<HTMLInputElement | null>(null);

  const photoPreview = useMemo(
    () => (photoFile ? URL.createObjectURL(photoFile) : null),
    [photoFile],
  );

  useEffect(() => {
    if (!photoPreview) return;
    return () => URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  if (state.status !== 'incomplete') return null;
  const user = state.user;
  const isVolunteer = state.userDoc.roles?.includes('volunteer') ?? false;

  function onPhotoChange(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setPhotoFile(null);
      return;
    }
    const v = validateImage(file);
    if (v) {
      setError(v);
      setPhotoFile(null);
      return;
    }
    setPhotoFile(file);
  }

  function onIdChange(e: ChangeEvent<HTMLInputElement>) {
    setError(null);
    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setIdFile(null);
      return;
    }
    const v = validateImage(file);
    if (v) {
      setError(v);
      setIdFile(null);
      return;
    }
    setIdFile(file);
  }

  async function handleSubmit() {
    setError(null);
    const trimmedName = displayName.trim();
    if (!trimmedName) return setError('Please enter your full name.');
    if (trimmedName.length > MAX_NAME) {
      return setError(`Name must be ${String(MAX_NAME)} characters or fewer.`);
    }
    if (!photoFile) {
      return setError(
        'Please upload a clear profile photo so neighbours can recognise you.',
      );
    }
    if (bio.length > MAX_BIO) {
      return setError(`Bio must be ${String(MAX_BIO)} characters or fewer.`);
    }

    setBusy(true);
    try {
      const photoPath = `users/${user.uid}/photo`;
      await uploadBytes(storageRef(storage(), photoPath), photoFile, {
        contentType: photoFile.type,
      });

      const update: Record<string, unknown> = {
        displayName: trimmedName,
        photoURL: photoPath,
      };
      if (bio.trim()) {
        update.bio = bio.trim();
      }

      if (idFile) {
        const idPath = `users/${user.uid}/id-image`;
        await uploadBytes(storageRef(storage(), idPath), idFile, {
          contentType: idFile.type,
        });
        update.idImagePath = idPath;
      }

      await updateDoc(doc(db(), 'users', user.uid), update);

      if (idFile) {
        try {
          const submitFn = httpsCallable(functions(), 'submitIdVerification');
          await submitFn();
        } catch {
          // Non-blocking for onboarding progression
        }
      }

      // ProtectedRoute will redirect once onSnapshot delivers updated doc:
      //   - volunteer / dual: → /onboarding/skills (step 4)
      //   - customer-only:    → /app
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not save your profile. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#fafaf8] text-[#131312]">
      <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b border-[#ececea] bg-[#fafaf8]/90 px-6 backdrop-blur-md sm:px-10">
        <div className="flex items-center gap-2.5 font-bold tracking-tight text-[#131312]">
          <Logo size="md" />
        </div>
      </header>

      <main className="vc-screen-enter mx-auto max-w-2xl px-6 py-10 sm:py-14">
        <OnboardingProgress current={3} includeSkills={isVolunteer} />

        <div className="text-center">
          <h1 className="text-2xl font-bold tracking-tight text-[#131312] sm:text-3xl">
            Set up your profile
          </h1>
          <p className="mt-2 text-sm text-[#4f4b46]">
            Real identity builds neighbourhood trust. Your photo and name help
            neighbours recognise you during tasks.
          </p>
        </div>

        <div className="mt-8 space-y-6 rounded-3xl border border-[#ececea] bg-white p-7 shadow-sm sm:p-10">
          {/* Profile Photo Upload */}
          <div>
            <span className="block text-sm font-semibold text-[#131312]">
              Profile Photo <span className="text-[#a32a22]">*</span>
            </span>
            <p className="mt-1 text-xs text-[#8a847d]">
              Please upload a clear, front-facing photo of yourself.
            </p>

            <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:gap-6">
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                className="group relative grid h-24 w-24 place-items-center overflow-hidden rounded-full border-2 border-dashed border-[#ececea] bg-[#fafaf8] transition hover:border-[#1f6f5c] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6f5c]"
                aria-label="Upload profile photo"
              >
                {photoPreview ? (
                  <img
                    src={photoPreview}
                    alt="Profile preview"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center text-[#8a847d] group-hover:text-[#1f6f5c]">
                    <svg
                      className="h-7 w-7"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.75}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                      />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
                      />
                    </svg>
                    <span className="mt-1 text-[10px] font-semibold">
                      Upload
                    </span>
                  </div>
                )}
              </button>

              <div className="space-y-1.5 text-center sm:text-left">
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  className="rounded-full border border-[#ececea] bg-white px-4 py-2 text-xs font-semibold text-[#131312] shadow-sm transition hover:border-[#d8d4cc] hover:bg-[#f3f1ec]"
                >
                  {photoFile
                    ? 'Change profile photo'
                    : 'Choose photo from device'}
                </button>
                <p className="text-xs text-[#8a847d]">
                  Supports JPEG, PNG, or WebP (max 2 MB)
                </p>
              </div>

              <input
                ref={photoInputRef}
                type="file"
                accept={ALLOWED_MIME.join(',')}
                onChange={onPhotoChange}
                className="sr-only"
              />
            </div>
          </div>

          {/* Name Field */}
          <div>
            <label
              htmlFor={nameId}
              className="block text-sm font-semibold text-[#131312]"
            >
              Full name <span className="text-[#a32a22]">*</span>
            </label>
            <input
              id={nameId}
              type="text"
              autoComplete="name"
              maxLength={MAX_NAME}
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Ramesh Kumar"
              className="mt-2 w-full rounded-xl border border-[#ececea] bg-white px-4 py-3 text-base text-[#131312] placeholder-[#8a847d] shadow-sm transition focus:border-[#1f6f5c] focus:outline-none focus:ring-1 focus:ring-[#1f6f5c]"
            />
          </div>

          {/* Bio Field */}
          <div>
            <div className="flex items-center justify-between">
              <label
                htmlFor={bioId}
                className="block text-sm font-semibold text-[#131312]"
              >
                About you{' '}
                <span className="font-normal text-[#8a847d]">(optional)</span>
              </label>
              <span className="text-xs text-[#8a847d]">
                {bio.length} / {MAX_BIO}
              </span>
            </div>
            <textarea
              id={bioId}
              maxLength={MAX_BIO}
              rows={3}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A short note for neighbours. E.g. Free on weekday evenings, happy to help with tech or plants."
              className="mt-2 w-full rounded-xl border border-[#ececea] bg-white px-4 py-3 text-base text-[#131312] placeholder-[#8a847d] shadow-sm transition focus:border-[#1f6f5c] focus:outline-none focus:ring-1 focus:ring-[#1f6f5c]"
            />
          </div>

          {/* ID Image Upload (Optional) */}
          <div className="rounded-2xl border border-[#ececea] bg-[#fafaf8] p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded bg-[#e3efe9] text-[#1f6f5c]">
                <svg
                  className="h-3.5 w-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                  />
                </svg>
              </div>
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-bold text-[#131312]">
                    Community / Student / Workplace ID{' '}
                    <span className="font-normal text-[#8a847d]">
                      (optional)
                    </span>
                  </h2>
                  <span className="rounded bg-[#ececea] px-2 py-0.5 text-[10px] font-semibold uppercase text-[#4f4b46]">
                    Admin Review
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-[#4f4b46]">
                  Uploading your institutional ID unlocks medium-risk tasks.
                  Your ID image is stored securely and never shown to other
                  users.
                </p>

                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => idInputRef.current?.click()}
                    className="rounded-full border border-[#ececea] bg-white px-4 py-2 text-xs font-semibold text-[#4f4b46] shadow-sm transition hover:bg-[#f3f1ec]"
                  >
                    {idFile ? 'Change ID image' : 'Attach ID document'}
                  </button>
                  {idFile && (
                    <span className="flex items-center gap-1.5 text-xs font-medium text-[#1f6f5c]">
                      <svg
                        className="h-3.5 w-3.5"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      ID attached ({idFile.name})
                    </span>
                  )}
                </div>
              </div>
            </div>

            <input
              ref={idInputRef}
              type="file"
              accept={ALLOWED_MIME.join(',')}
              onChange={onIdChange}
              className="sr-only"
            />
          </div>
        </div>

        {error && (
          <div
            id={errorId}
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-[#f5c6cb] bg-[#fdf0ef] p-3.5 text-sm text-[#a32a22]"
          >
            <svg
              className="mt-0.5 h-4 w-4 shrink-0"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            <span>{error}</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={busy}
          className="mt-8 w-full rounded-full bg-[#1f6f5c] px-6 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-[#185845] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#1f6f5c] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy
            ? 'Saving profile…'
            : isVolunteer
              ? 'Save & Pick Skills (Step 4 of 4) →'
              : 'Complete Setup & Enter Dashboard →'}
        </button>
      </main>
    </div>
  );
}
