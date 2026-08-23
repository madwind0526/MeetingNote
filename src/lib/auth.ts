import type { LoginResult, PublicMember } from "../types/domain";

const SESSION_STORAGE_KEY = "meetingnote-session";

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    throw new Error(payload?.error || `요청이 실패했습니다 (${response.status}).`);
  }

  return payload as T;
}

export async function login(loginId: string, password: string): Promise<LoginResult> {
  if (window.meetingNote?.login) {
    return window.meetingNote.login(loginId, password);
  }

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

export function saveSession(member: PublicMember) {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(member));
}

export function loadSession(): PublicMember | null {
  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);

  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as PublicMember;
  } catch {
    return null;
  }
}

export function clearSession() {
  window.localStorage.removeItem(SESSION_STORAGE_KEY);
}

export interface MemberDraft {
  name: string;
  loginId: string;
  password: string;
  role: "admin" | "일반";
  // Set by LoginView's self-service "계정 신청" so the account is created pending admin activation
  // (see MemberManagementModal's 활성화/비활성화 toggle). Admin-created accounts never set this,
  // so they stay immediately active, matching prior behavior.
  disabled?: boolean;
}

// Solo-use shortcut: logs in as the first available (non-disabled) member without a password, so
// a single local user doesn't have to type credentials every launch. Does not touch verifyLogin or
// any server-side auth check - it only picks an existing member and treats it as the session, the
// same way a normal login would after the server already validated that member's password.
export async function skipLogin(): Promise<PublicMember | null> {
  const members = await fetchMembers();
  const active = members.filter((member) => !member.disabled);
  const preferred = active.find((member) => member.role === "admin") ?? active[0];

  return preferred ?? null;
}

export async function fetchMembers(): Promise<PublicMember[]> {
  if (window.meetingNote?.listMembers) {
    return window.meetingNote.listMembers();
  }

  const response = await fetch("/api/members");
  const payload = await parseJsonResponse<{ members: PublicMember[] }>(response);

  return payload.members;
}

export async function createMemberRequest(draft: MemberDraft): Promise<PublicMember[]> {
  if (window.meetingNote?.createMember) {
    return window.meetingNote.createMember(draft);
  }

  const response = await fetch("/api/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft)
  });
  const payload = await parseJsonResponse<{ members: PublicMember[] }>(response);

  return payload.members;
}

export async function updateMemberRequest(
  id: string,
  patch: Partial<Pick<MemberDraft, "name" | "role">> & { newPassword?: string; disabled?: boolean }
): Promise<PublicMember[]> {
  if (window.meetingNote?.updateMember) {
    return window.meetingNote.updateMember(id, patch);
  }

  const response = await fetch(`/api/members/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  const payload = await parseJsonResponse<{ members: PublicMember[] }>(response);

  return payload.members;
}

export async function disableMemberRequest(id: string): Promise<PublicMember[]> {
  if (window.meetingNote?.disableMember) {
    return window.meetingNote.disableMember(id);
  }

  const response = await fetch(`/api/members/${id}`, { method: "DELETE" });
  const payload = await parseJsonResponse<{ members: PublicMember[] }>(response);

  return payload.members;
}
