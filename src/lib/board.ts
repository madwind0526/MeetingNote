import type { BoardPost } from "../types/domain";

export async function listBoardPosts(): Promise<BoardPost[]> {
  const response = await fetch("/api/board");
  return response.ok ? response.json() : [];
}

export async function saveBoardPosts(posts: BoardPost[]): Promise<BoardPost[]> {
  const response = await fetch("/api/board", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(posts)
  });

  return response.json();
}
