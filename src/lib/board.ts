import type { BoardPost } from "../types/domain";
import { jsonAuthHeaders } from "./auth";

export async function listBoardPosts(): Promise<BoardPost[]> {
  const response = await fetch("/api/board");
  return response.ok ? response.json() : [];
}

export async function saveBoardPosts(posts: BoardPost[]): Promise<BoardPost[]> {
  const response = await fetch("/api/board", {
    method: "PUT",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(posts)
  });

  return response.json();
}
