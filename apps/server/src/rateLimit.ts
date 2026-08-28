// API Rate Limiting & Denial-of-Service Protection (Phase 6).
// In-memory sliding-window token bucket protecting sensitive APIs.

import { getConfig } from "./config.js";

interface RateLimitEntry {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, RateLimitEntry>();

  check(key: string, customMax?: number, customWindowMs?: number): {
    allowed: boolean;
    remaining: number;
    resetMs: number;
  } {
    const config = getConfig();
    if (!config.RATE_LIMIT_ENABLED) {
      return { allowed: true, remaining: 9999, resetMs: 0 };
    }

    const max = customMax ?? config.RATE_LIMIT_MAX;
    const windowMs = customWindowMs ?? config.RATE_LIMIT_WINDOW_MS;
    const now = Date.now();

    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { tokens: max, lastRefill: now };
      this.buckets.set(key, entry);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - entry.lastRefill;
    const refillAmount = (elapsed / windowMs) * max;
    if (refillAmount > 0) {
      entry.tokens = Math.min(max, entry.tokens + refillAmount);
      entry.lastRefill = now;
    }

    if (entry.tokens >= 1) {
      entry.tokens -= 1;
      return {
        allowed: true,
        remaining: Math.floor(entry.tokens),
        resetMs: Math.ceil(((max - entry.tokens) / max) * windowMs),
      };
    }

    return {
      allowed: false,
      remaining: 0,
      resetMs: Math.ceil(((1 - entry.tokens) / max) * windowMs),
    };
  }

  reset(key?: string) {
    if (key) this.buckets.delete(key);
    else this.buckets.clear();
  }
}

export const rateLimiter = new RateLimiter();
