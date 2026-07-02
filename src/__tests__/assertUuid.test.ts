/**
 * Unit tests for assertUuid() — the pre-flight guard that stops an
 * omitted/typo'd/undefined entity id from being stringified into an API
 * request path (e.g. `/merge-requests/undefined`) and surfacing as a
 * confusing Postgres 22P02 downstream. Mirrors the server-side guard in
 * haops `lib/utils/validateUuid.ts`.
 */

import { describe, it, expect } from '@jest/globals';
import { assertUuid } from '../index.js';

describe('assertUuid', () => {
  const VALID = '48f48c45-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

  it('returns the value unchanged for a valid v4 UUID', () => {
    expect(assertUuid(VALID, 'mergeRequestId')).toBe(VALID);
  });

  it('accepts uppercase UUIDs (case-insensitive)', () => {
    expect(assertUuid(VALID.toUpperCase(), 'mergeRequestId')).toBe(VALID.toUpperCase());
  });

  it.each([
    ['the literal string "undefined"', 'undefined'],
    ['the literal string "null"', 'null'],
    ['an empty string', ''],
    ['a truncated id', '48f48c45'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['a wrong-version UUID', '48f48c45-1a2b-6c3d-8e9f-0a1b2c3d4e5f'],
  ])('throws for %s', (_label, bad) => {
    expect(() => assertUuid(bad, 'mergeRequestId')).toThrow(/Invalid mergeRequestId/);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 123],
    ['an object', {}],
  ])('throws for a non-string value (%s)', (_label, bad) => {
    expect(() => assertUuid(bad, 'mergeRequestId')).toThrow(/Invalid mergeRequestId/);
  });

  it('names the offending field in the error message', () => {
    expect(() => assertUuid('undefined', 'ticketId')).toThrow(/Invalid ticketId/);
  });
});
