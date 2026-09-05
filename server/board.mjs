import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canManageAuthoredRecord, isAdminMember } from "./sessions.mjs";

const ROOT = process.cwd();
const DB_PATH = path.join(ROOT, "data/db/board.json");

async function ensureDb() {
  try {
    await readFile(DB_PATH, "utf8");
  } catch {
    await mkdir(path.dirname(DB_PATH), { recursive: true });
    await writeFile(DB_PATH, "[]", "utf8");
  }
}

export async function readBoardPosts() {
  await ensureDb();
  const raw = await readFile(DB_PATH, "utf8");

  return JSON.parse(raw);
}

function withoutComments(post) {
  const { comments, ...rest } = post;
  void comments;
  return rest;
}

function asMap(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertCommentChangesAllowed(previousComments, nextComments, member) {
  const previousById = asMap(previousComments);
  const nextById = asMap(nextComments);

  for (const nextComment of nextComments) {
    const previousComment = previousById.get(nextComment.id);
    if (!previousComment) {
      if (nextComment.authorId !== member.id) {
        throw new Error("다른 사용자 이름으로 댓글을 등록할 수 없습니다.");
      }
      continue;
    }

    if (!sameJson(previousComment, nextComment) && !canManageAuthoredRecord(previousComment, member)) {
      throw new Error("댓글을 수정할 권한이 없습니다.");
    }
  }

  for (const previousComment of previousComments) {
    if (!nextById.has(previousComment.id) && !canManageAuthoredRecord(previousComment, member)) {
      throw new Error("댓글을 삭제할 권한이 없습니다.");
    }
  }
}

function assertBoardWriteAllowed(previousPosts, nextPosts, member) {
  const previousById = asMap(previousPosts);
  const nextById = asMap(nextPosts);

  for (const nextPost of nextPosts) {
    const previousPost = previousById.get(nextPost.id);
    if (!previousPost) {
      if (nextPost.authorId !== member.id) {
        throw new Error("다른 사용자 이름으로 게시글을 등록할 수 없습니다.");
      }
      if ((nextPost.category === "공지" || nextPost.pinned) && !isAdminMember(member)) {
        throw new Error("공지 등록과 고정은 관리자만 사용할 수 있습니다.");
      }
      continue;
    }

    if (previousPost.authorId !== nextPost.authorId) {
      throw new Error("게시글 작성자를 변경할 수 없습니다.");
    }

    if ((previousPost.pinned !== nextPost.pinned || previousPost.category !== nextPost.category) && !isAdminMember(member)) {
      throw new Error("게시글 분류와 고정 상태는 관리자만 변경할 수 있습니다.");
    }

    if (!sameJson(withoutComments(previousPost), withoutComments(nextPost)) && !canManageAuthoredRecord(previousPost, member)) {
      throw new Error("게시글을 수정할 권한이 없습니다.");
    }

    assertCommentChangesAllowed(previousPost.comments ?? [], nextPost.comments ?? [], member);
  }

  for (const previousPost of previousPosts) {
    if (!nextById.has(previousPost.id) && !canManageAuthoredRecord(previousPost, member)) {
      throw new Error("게시글을 삭제할 권한이 없습니다.");
    }
  }
}

export async function writeBoardPosts(posts, member) {
  const previousPosts = await readBoardPosts();
  if (!member) {
    throw new Error("로그인이 필요합니다.");
  }
  assertBoardWriteAllowed(previousPosts, posts, member);

  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(posts, null, 2), "utf8");

  return posts;
}
