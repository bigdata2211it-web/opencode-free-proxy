import { ocId } from "./utils.mjs";

const userSessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

// Periodically evict stale sessions so the Map doesn't grow unbounded.
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [user, session] of userSessions) {
    if (now - session.ts > SESSION_TTL) userSessions.delete(user);
  }
}, CLEANUP_INTERVAL).unref();

export function getSession(user) {
  const now = Date.now();
  const existing = userSessions.get(user);
  if (!existing || now - existing.ts > SESSION_TTL) {
    const session = { id: ocId("ses"), ts: now };
    userSessions.set(user, session);
    return session.id;
  }
  // Bump timestamp on activity so active sessions stay alive.
  existing.ts = now;
  return existing.id;
}

/** Force a new session id (e.g. after rate-limit so free-tier quota resets). */
export function rotateSession(user) {
  const session = { id: ocId("ses"), ts: Date.now() };
  userSessions.set(user, session);
  return session.id;
}
