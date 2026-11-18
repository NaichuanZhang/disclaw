// ---------------------------------------------------------------------------
// Browser — viewer tokens
//
// The gateway has no auth, so a viewer link is protected only by its token:
// 32 random bytes, bound to one browser and to the Discord user who asked for
// it, valid for 15 minutes. Only a SHA-256 of each token is kept, and the
// comparison is constant-time. Pure apart from crypto; the clock is injectable.
// ---------------------------------------------------------------------------

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const VIEWER_TOKEN_TTL_MS = 15 * 60 * 1000;

export interface ViewerGrant {
  browserId: string;
  userId: string;
  expiresAt: number;
}

export interface ViewerTokenStore {
  mint(browserId: string, userId: string): { token: string; expiresAt: number };
  /** The grant when `token` is live and bound to `browserId` (and `userId`, if given). */
  verify(token: string, browserId: string, userId?: string): ViewerGrant | null;
  /** Drop every token for a browser (it closed). */
  revokeBrowser(browserId: string): void;
  purge(): void;
  size(): number;
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function createViewerTokenStore(
  opts: { now?: () => number; ttlMs?: number } = {},
): ViewerTokenStore {
  const now = opts.now ?? (() => Date.now());
  const ttlMs = opts.ttlMs ?? VIEWER_TOKEN_TTL_MS;
  const grants = new Map<string, ViewerGrant & { hash: Buffer }>();

  function purge(): void {
    const t = now();
    for (const [key, grant] of grants) if (grant.expiresAt <= t) grants.delete(key);
  }

  return {
    mint(browserId, userId) {
      purge();
      const token = randomBytes(32).toString("base64url");
      const hash = digest(token);
      const expiresAt = now() + ttlMs;
      grants.set(hash.toString("hex"), { browserId, userId, expiresAt, hash });
      return { token, expiresAt };
    },

    verify(token, browserId, userId) {
      if (typeof token !== "string" || token.length < 16 || token.length > 128) return null;
      const hash = digest(token);
      const grant = grants.get(hash.toString("hex"));
      if (!grant || !timingSafeEqual(grant.hash, hash)) return null;
      if (grant.expiresAt <= now()) {
        grants.delete(hash.toString("hex"));
        return null;
      }
      if (!safeEqual(grant.browserId, browserId)) return null;
      if (userId !== undefined && !safeEqual(grant.userId, userId)) return null;
      return { browserId: grant.browserId, userId: grant.userId, expiresAt: grant.expiresAt };
    },

    revokeBrowser(browserId) {
      for (const [key, grant] of grants) if (grant.browserId === browserId) grants.delete(key);
    },

    purge,

    size() {
      return grants.size;
    },
  };
}

const defaultStore = createViewerTokenStore();

export function mintViewerToken(browserId: string, userId: string): { token: string; expiresAt: number } {
  return defaultStore.mint(browserId, userId);
}

export function verifyViewerToken(token: string, browserId: string, userId?: string): ViewerGrant | null {
  return defaultStore.verify(token, browserId, userId);
}

export function revokeViewerTokens(browserId: string): void {
  defaultStore.revokeBrowser(browserId);
}
