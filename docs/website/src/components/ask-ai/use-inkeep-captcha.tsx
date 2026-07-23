'use client';

import { solveChallenge } from 'altcha-lib';
import { useCallback, useEffect, useRef } from 'react';

/**
 * Inkeep gates every `POST /v1/chat/completions` call behind an
 * ALTCHA proof-of-work challenge. Without a fresh, valid
 * `X-INKEEP-CHALLENGE-SOLUTION` header on each request the API
 * responds with `403 Forbidden`.
 *
 * Flow (replicates `@inkeep/cxkit-primitives` `useCaptcha`):
 *   1. `GET ${baseUrl}/challenge` → `{ challenge, salt, algorithm, maxnumber }`
 *   2. Brute-force a `number` such that `H(salt + number) === challenge`
 *      using altcha-lib's `solveChallenge` (Web Crypto under the hood).
 *   3. Base64-encode `{ number, challenge, salt, algorithm, maxnumber }`
 *      and send it as the `X-INKEEP-CHALLENGE-SOLUTION` request header.
 *
 * Solutions are single-use, so we cache the *pending solve promise*
 * (not the result) — the first call to `getSolution()` after a flush
 * kicks off the network + brute-force pass, subsequent simultaneous
 * callers await the same promise, and once consumed the cache is
 * cleared so the next request kicks off a fresh challenge.
 *
 * The hook also prefetches a solution on mount so the very first
 * user submission doesn't pay the round-trip + brute-force latency
 * (typically ~100-300ms depending on `maxnumber`).
 */

const INKEEP_CHALLENGE_URL = 'https://api.inkeep.com/v1/challenge';

interface InkeepChallenge {
  challenge: string;
  salt: string;
  algorithm: string;
  maxnumber: number;
}

interface InkeepSolution extends InkeepChallenge {
  number: number;
}

async function fetchAndSolveChallenge(): Promise<InkeepSolution | null> {
  try {
    const response = await fetch(INKEEP_CHALLENGE_URL, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Failed to fetch challenge: ${response.statusText}`);
    }
    const challenge = (await response.json()) as InkeepChallenge;
    const { promise } = solveChallenge(
      challenge.challenge,
      challenge.salt,
      challenge.algorithm,
      challenge.maxnumber,
    );
    const solved = await promise;
    if (!solved) {
      throw new Error('ALTCHA challenge unsolved within maxnumber bound.');
    }
    return { number: solved.number, ...challenge };
  } catch (err) {
    console.warn('[inkeep-captcha] failed to obtain solution:', err);
    return null;
  }
}

export interface UseInkeepCaptchaResult {
  /**
   * Resolve to a ready-to-send `X-INKEEP-CHALLENGE-SOLUTION` header
   * value (base64-encoded solution JSON), or `null` if the challenge
   * round-trip failed. Single-use — the internal cache is dropped
   * once awaited, so the next call starts a new round.
   */
  getSolutionHeader: () => Promise<string | null>;
  /** Kick off (but don't await) a solve so the first user message is fast. */
  prefetch: () => void;
  /** Drop any pending/cached solve — call after an auth/rate-limit error. */
  invalidate: () => void;
}

export function useInkeepCaptcha(): UseInkeepCaptchaResult {
  const pendingRef = useRef<Promise<InkeepSolution | null> | null>(null);

  const prefetch = useCallback(() => {
    if (pendingRef.current) return;
    pendingRef.current = fetchAndSolveChallenge();
  }, []);

  const invalidate = useCallback(() => {
    pendingRef.current = null;
  }, []);

  const getSolutionHeader = useCallback(async () => {
    if (!pendingRef.current) pendingRef.current = fetchAndSolveChallenge();
    const solution = await pendingRef.current;
    // Solutions are single-use; clear the cache so the next request
    // forces a fresh challenge. Prefetch the next one immediately so
    // the user doesn't pay the latency on their next message.
    pendingRef.current = null;
    prefetch();
    if (!solution) return null;
    try {
      return typeof window === 'undefined'
        ? Buffer.from(JSON.stringify(solution)).toString('base64')
        : btoa(JSON.stringify(solution));
    } catch (err) {
      console.warn('[inkeep-captcha] failed to encode solution:', err);
      return null;
    }
  }, [prefetch]);

  useEffect(() => {
    prefetch();
  }, [prefetch]);

  return { getSolutionHeader, prefetch, invalidate };
}
