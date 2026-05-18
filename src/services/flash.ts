/**
 * In-memory flash-message store for one-time UI notifications (e.g. a
 * newly created token shown after a form POST redirects).
 *
 * Keys are UUIDs handed out in redirect URLs; each entry self-expires
 * after `FLASH_TTL_MS` and is also deleted on first read. The store is
 * deliberately process-local — flash is a single-request concept and
 * never needs to survive a restart.
 *
 * Extracted from `src/index.tsx` as part of the C1 pragmatic split.
 */

interface FlashEntry {
  newToken?: string;
  error?: string;
  expiresAt: number;
}

const flashStore = new Map<string, FlashEntry>();
const FLASH_TTL_MS = 60_000; // 60s

export type FlashData = Omit<FlashEntry, "expiresAt">;

export function setFlash(data: FlashData): string {
  const key = crypto.randomUUID();
  flashStore.set(key, { ...data, expiresAt: Date.now() + FLASH_TTL_MS });
  setTimeout(() => flashStore.delete(key), FLASH_TTL_MS + 1000);
  return key;
}

export function getFlash(key: string | undefined): FlashData | null {
  if (!key) return null;
  const entry = flashStore.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    flashStore.delete(key);
    return null;
  }
  flashStore.delete(key);
  const { expiresAt: _exp, ...data } = entry;
  return data;
}
