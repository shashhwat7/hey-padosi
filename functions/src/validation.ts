// Shared boundary validation helpers for Cloud Functions (Batch 6 Hardening)
// Reusable, strict input validators returning typed results or throwing HttpsError('invalid-argument').

import { HttpsError } from 'firebase-functions/v2/https';

/**
 * Validates a required string parameter.
 * Trims whitespace and enforces minimum and maximum length boundaries.
 */
export function validateString(
  value: unknown,
  fieldName: string,
  minLen = 1,
  maxLen = 100,
): string {
  if (typeof value !== 'string') {
    throw new HttpsError(
      'invalid-argument',
      `${fieldName} must be a string.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length < minLen || trimmed.length > maxLen) {
    throw new HttpsError(
      'invalid-argument',
      `${fieldName} must be between ${minLen} and ${maxLen} characters.`,
    );
  }
  return trimmed;
}

/**
 * Validates an optional string parameter.
 * Returns undefined if null/undefined/empty. If provided, enforces maximum length.
 */
export function validateOptionalString(
  value: unknown,
  fieldName: string,
  maxLen = 500,
): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new HttpsError(
      'invalid-argument',
      `${fieldName} must be a string if provided.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    throw new HttpsError(
      'invalid-argument',
      `${fieldName} must be at most ${maxLen} characters.`,
    );
  }
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Validates an enum string parameter against an allowlist of valid options.
 */
export function validateEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new HttpsError(
      'invalid-argument',
      `${fieldName} must be one of: ${allowed.join(', ')}.`,
    );
  }
  return value as T;
}

/**
 * Validates an integer within [min, max] range.
 */
export function validateInteger(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new HttpsError(
      'invalid-argument',
      `${fieldName} must be an integer between ${min} and ${max}.`,
    );
  }
  return value;
}

/**
 * Validates a finite number within [min, max] range.
 */
export function validateNumber(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new HttpsError(
      'invalid-argument',
      `${fieldName} must be a valid number between ${min} and ${max}.`,
    );
  }
  return num;
}
