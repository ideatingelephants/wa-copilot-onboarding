import crypto from "node:crypto";
import { onboardingConfig } from "./config.js";

const sessions = new Map();
const authStates = new Map();

function nowMs() {
  return Date.now();
}

function ttlMs() {
  return Math.max(1, onboardingConfig.sessionTtlHours) * 60 * 60 * 1000;
}

function randomId(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function cleanupExpired() {
  const cutoff = nowMs() - ttlMs();

  for (const [key, value] of sessions.entries()) {
    if ((value.updatedAtMs || 0) < cutoff) {
      sessions.delete(key);
    }
  }

  for (const [key, value] of authStates.entries()) {
    if ((value.createdAtMs || 0) < cutoff) {
      authStates.delete(key);
    }
  }
}

export function createSession() {
  cleanupExpired();
  const sessionId = randomId(24);
  const created = nowMs();
  sessions.set(sessionId, {
    id: sessionId,
    createdAtMs: created,
    updatedAtMs: created,
    google: null,
    setupResult: null
  });
  return sessionId;
}

export function getSession(sessionId) {
  if (!sessionId) {
    return null;
  }
  const session = sessions.get(sessionId) || null;
  if (!session) {
    return null;
  }
  session.updatedAtMs = nowMs();
  return session;
}

export function clearSession(sessionId) {
  if (sessionId) {
    sessions.delete(sessionId);
  }
}

export function saveGoogleSession(sessionId, googleData) {
  const session = getSession(sessionId);
  if (!session) {
    return null;
  }
  session.google = googleData;
  session.updatedAtMs = nowMs();
  return session;
}

export function saveSetupResult(sessionId, setupResult) {
  const session = getSession(sessionId);
  if (!session) {
    return null;
  }
  session.setupResult = setupResult;
  session.updatedAtMs = nowMs();
  return session;
}

export function createAuthState(sessionId) {
  const state = randomId(24);
  authStates.set(state, {
    sessionId,
    createdAtMs: nowMs()
  });
  return state;
}

export function consumeAuthState(state) {
  const record = authStates.get(state);
  if (!record) {
    return null;
  }
  authStates.delete(state);
  if (record.createdAtMs < nowMs() - ttlMs()) {
    return null;
  }
  return record;
}
