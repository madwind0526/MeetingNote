import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

export async function writeBoardPosts(posts) {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(posts, null, 2), "utf8");

  return posts;
}
