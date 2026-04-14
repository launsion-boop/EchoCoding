/**
 * Smart throttle — prevents audio fatigue.
 *
 * Two mechanisms:
 * 1. Min interval: same category won't fire within N seconds
 * 2. Dedup window: identical text won't repeat within N seconds
 */

interface ThrottleEntry {
  lastTime: number;
  lastText?: string;
}

const entries = new Map<string, ThrottleEntry>();
const textHistory = new Map<string, number>(); // text hash → timestamp

export interface ThrottleOptions {
  minInterval: number;  // seconds
  dedupWindow: number;  // seconds
}

const DEFAULT_OPTIONS: ThrottleOptions = {
  minInterval: 3,
  dedupWindow: 30,
};

export function shouldThrottle(
  category: string,
  text?: string,
  options?: Partial<ThrottleOptions>,
): boolean {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const now = Date.now();

  // Check min interval for this category
  const entry = entries.get(category);
  if (entry && now - entry.lastTime < opts.minInterval * 1000) {
    return true;
  }

  // Check text dedup
  if (text) {
    const lastSeen = textHistory.get(text);
    if (lastSeen && now - lastSeen < opts.dedupWindow * 1000) {
      return true;
    }
  }

  return false;
}

export function recordUsage(category: string, text?: string): void {
  const now = Date.now();
  entries.set(category, { lastTime: now, lastText: text });
  if (text) {
    textHistory.set(text, now);
  }

  // Cleanup old entries (prevent memory leak in long sessions)
  if (textHistory.size > 200) {
    const cutoff = now - 60_000; // keep last 60s
    for (const [key, time] of textHistory) {
      if (time < cutoff) textHistory.delete(key);
    }
  }
}

export function resetThrottle(): void {
  entries.clear();
  textHistory.clear();
}
