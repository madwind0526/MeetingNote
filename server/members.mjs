import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

const ROOT = process.cwd();
const MEMBERS_PATH = path.join(ROOT, "data/db/members.json");
const SEED_ADMIN_LOGIN_ID = "admin";
const SEED_ADMIN_PASSWORD = "admin1234";

export function hashPassword(password) {
  return createHash("sha256").update(password, "utf8").digest("hex");
}

// Strips passwordHash before a member record is ever sent to the renderer.
export function toPublicMember(member) {
  const { passwordHash, ...rest } = member;
  void passwordHash;
  return rest;
}

async function ensureMembers() {
  try {
    await readFile(MEMBERS_PATH, "utf8");
  } catch {
    await mkdir(path.dirname(MEMBERS_PATH), { recursive: true });

    const seedAdmin = {
      id: randomUUID(),
      name: "관리자",
      loginId: SEED_ADMIN_LOGIN_ID,
      passwordHash: hashPassword(SEED_ADMIN_PASSWORD),
      role: "admin",
      createdAt: new Date().toISOString(),
      disabled: false
    };

    await writeFile(MEMBERS_PATH, JSON.stringify([seedAdmin], null, 2), "utf8");
  }
}

export async function readMembers() {
  await ensureMembers();
  const raw = await readFile(MEMBERS_PATH, "utf8");

  return JSON.parse(raw);
}

async function writeMembers(members) {
  await mkdir(path.dirname(MEMBERS_PATH), { recursive: true });
  await writeFile(MEMBERS_PATH, JSON.stringify(members, null, 2), "utf8");
}

export async function verifyLogin(loginId, password) {
  const members = await readMembers();
  const found = members.find((member) => member.loginId === loginId);

  if (!found || found.passwordHash !== hashPassword(password ?? "")) {
    return { ok: false, error: "아이디 또는 비밀번호가 올바르지 않습니다." };
  }

  if (found.disabled) {
    return { ok: false, error: "비활성화된 계정입니다. 관리자에게 문의하세요." };
  }

  return { ok: true, member: toPublicMember(found) };
}

export async function createMember(draft) {
  const members = await readMembers();
  const loginId = String(draft?.loginId ?? "").trim();

  if (!loginId) {
    throw new Error("아이디를 입력해 주세요.");
  }
  if (members.some((member) => member.loginId === loginId)) {
    throw new Error("이미 사용 중인 아이디입니다.");
  }

  const member = {
    id: randomUUID(),
    name: String(draft?.name ?? "").trim() || loginId,
    loginId,
    passwordHash: hashPassword(String(draft?.password ?? "") || loginId),
    role: draft?.role === "admin" ? "admin" : "일반",
    createdAt: new Date().toISOString(),
    // set this) stay immediately active, matching prior behavior.
    disabled: draft?.disabled === true
  };

  const nextMembers = [...members, member];
  await writeMembers(nextMembers);

  return nextMembers.map(toPublicMember);
}

export async function updateMember(id, patch) {
  const members = await readMembers();

  const nextMembers = members.map((member) => {
    if (member.id !== id) {
      return member;
    }

    const { newPassword, ...rest } = patch ?? {};

    return {
      ...member,
      ...rest,
      id: member.id,
      loginId: member.loginId,
      ...(typeof newPassword === "string" && newPassword.trim() ? { passwordHash: hashPassword(newPassword.trim()) } : {})
    };
  });

  await writeMembers(nextMembers);

  return nextMembers.map(toPublicMember);
}

// Soft delete - see Member.disabled comment in domain.ts for why this doesn't remove the row.
export async function disableMember(id) {
  const members = await readMembers();
  const nextMembers = members.map((member) => (member.id === id ? { ...member, disabled: true } : member));

  await writeMembers(nextMembers);

  return nextMembers.map(toPublicMember);
}
