import { randomUUID } from "node:crypto";
import { readMembers, toPublicMember, verifyLogin } from "./members.mjs";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function nowMs() {
  return Date.now();
}

function pruneExpiredSessions() {
  const now = nowMs();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function createSession(member) {
  pruneExpiredSessions();
  const token = randomUUID();
  sessions.set(token, { memberId: member.id, expiresAt: nowMs() + SESSION_TTL_MS });
  return { ok: true, member: toPublicMember(member), sessionToken: token };
}

function bearerTokenFromRequest(request) {
  const header = request.headers.authorization;
  if (typeof header !== "string") {
    return "";
  }

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

export async function createLoginSession(loginId, password) {
  const result = await verifyLogin(loginId, password);
  if (!result.ok || !result.member) {
    return result;
  }

  const members = await readMembers();
  const member = members.find((candidate) => candidate.id === result.member.id);
  if (!member || member.disabled) {
    return { ok: false, error: "로그인이 만료되었습니다. 다시 로그인해 주세요." };
  }

  return createSession(member);
}

export async function createSkipLoginSession() {
  if (process.env.MEETINGNOTE_ALLOW_SKIP_LOGIN !== "true") {
    return { ok: false, error: "로그인 건너뛰기는 이 실행 환경에서 비활성화되어 있습니다." };
  }

  const members = await readMembers();
  const activeMembers = members.filter((member) => !member.disabled);
  const member = activeMembers.find((candidate) => candidate.role === "admin") ?? activeMembers[0];

  if (!member) {
    return { ok: false, error: "로그인할 수 있는 계정이 없습니다." };
  }

  return createSession(member);
}

export async function getAuthenticatedMember(request) {
  pruneExpiredSessions();
  const token = bearerTokenFromRequest(request);
  const session = token ? sessions.get(token) : null;

  if (!session) {
    return null;
  }

  const members = await readMembers();
  const member = members.find((candidate) => candidate.id === session.memberId);
  if (!member || member.disabled) {
    sessions.delete(token);
    return null;
  }

  session.expiresAt = nowMs() + SESSION_TTL_MS;
  return toPublicMember(member);
}

export function isAdminMember(member) {
  return member?.role === "admin";
}

export function canManageAuthoredRecord(record, member) {
  return Boolean(member && (isAdminMember(member) || record?.authorId === member.id));
}
