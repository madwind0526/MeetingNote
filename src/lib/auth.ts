import type { LoginResult, PublicMember } from "../types/domain";

const SESSION_STORAGE_KEY = "meetingnote-session";

interface StoredSession {
  member: PublicMember;
  sessionToken: string;
}

// Fired when an authenticated request comes back 401 - the server-side session is gone (expired,
// or a dev-server restart wiped its in-memory session store) even though a stale token is still
// cached in localStorage. Without this, App.tsx never learns the session died: `session` state is
// only ever set once at startup from loadSession(), so the user stays stuck looking at the main
// app - every action just keeps failing with the same "login required" error instead of being
// sent back to the login screen. Every parseJsonResponse below (and the copies in api.ts/llm.ts/
// dictionary.ts) calls this on a 401; App.tsx subscribes via onSessionExpired to clear `session`.
const SESSION_EXPIRED_EVENT = "meetingnote-session-expired";

export function notifySessionExpired() {
  clearSession();
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

export function onSessionExpired(handler: () => void): () => void {
  window.addEventListener(SESSION_EXPIRED_EVENT, handler);
  return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handler);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    if (response.status === 401) {
      notifySessionExpired();
    }
    throw new Error(payload?.error || `요청이 실패했습니다 (${response.status}).`);
  }

  return payload as T;
}

export async function login(loginId: string, password: string): Promise<LoginResult> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loginId, password })
  });

  if (!response.ok) {
    return { ok: false, error: "로그인 요청이 실패했습니다." };
  }

  return (await response.json()) as LoginResult;
}

function parseStoredSession(raw: string | null): StoredSession | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession> | PublicMember;
    if ("member" in parsed && parsed.member && typeof parsed.sessionToken === "string" && parsed.sessionToken) {
      return { member: parsed.member as PublicMember, sessionToken: parsed.sessionToken };
    }
  } catch {
    return null;
  }

  return null;
}

export function saveSession(member: PublicMember, sessionToken: string) {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ member, sessionToken }));
}

export function loadSession(): PublicMember | null {
  return parseStoredSession(window.localStorage.getItem(SESSION_STORAGE_KEY))?.member ?? null;
}

export function getSessionToken(): string | null {
  return parseStoredSession(window.localStorage.getItem(SESSION_STORAGE_KEY))?.sessionToken ?? null;
}

export function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function jsonAuthHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeaders() };
}

export function clearSession() {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

export interface MemberDraft {
  name: string;
  loginId: string;
  password: string;
  role: "admin" | "일반";
  // so they stay immediately active, matching prior behavior.
  disabled?: boolean;
}

// Solo-use shortcut: logs in as the first available (non-disabled) member without a password, so
// a single local user doesn't have to type credentials every launch. Does not touch verifyLogin or
// any server-side auth check - it only picks an existing member and treats it as the session, the
// same way a normal login would after the server already validated that member's password.
export async function skipLogin(): Promise<LoginResult> {
  const response = await fetch("/api/auth/skip", {
    method: "POST",
    headers: jsonAuthHeaders()
  });

  return (await response.json()) as LoginResult;
}

export async function fetchMembers(): Promise<PublicMember[]> {
  const response = await fetch("/api/members", { headers: authHeaders() });
  const payload = await parseJsonResponse<{ members: PublicMember[] }>(response);

  return payload.members;
}

export async function createMemberRequest(draft: MemberDraft): Promise<PublicMember[]> {
  const response = await fetch("/api/members", {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(draft)
  });
  const payload = await parseJsonResponse<{ members: PublicMember[] }>(response);

  return payload.members;
}

export async function updateMemberRequest(
  id: string,
  patch: Partial<Pick<MemberDraft, "name" | "role">> & { newPassword?: string; disabled?: boolean }
): Promise<PublicMember[]> {
  const response = await fetch(`/api/members/${id}`, {
    method: "PUT",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(patch)
  });
  const payload = await parseJsonResponse<{ members: PublicMember[] }>(response);

  return payload.members;
}

export async function disableMemberRequest(id: string): Promise<PublicMember[]> {
  const response = await fetch(`/api/members/${id}`, { method: "DELETE", headers: authHeaders() });
  const payload = await parseJsonResponse<{ members: PublicMember[] }>(response);

  return payload.members;
}
