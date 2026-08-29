import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readAppSettings } from "./settingsFile.mjs";
import { convertMaterialToMarkdown } from "./converters/toMarkdown.mjs";

export const PROJECT_ROOT = process.cwd();
const DEFAULT_ATTACHMENTS_RELATIVE_DIR = "data/attachments";
// 16kHz mono 16-bit WAV (this app's fixed decode/encode rate, see src/lib/audio.ts) runs about
// 1.92MB/min raw - 50MB capped out at ~26 minutes, well short of the 1-hour meetings this app is
// meant to handle. 200MB covers ~104 minutes of raw audio with room to spare.
export const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const VALID_KINDS = new Set(["materials", "audio"]);

// Copies attached files into <base>/<meeting folder label>/<kind>/<file name> so Explorer shows
// one human-readable folder per meeting with materials and audio recordings kept apart.
// AppSettings.attachmentsFolder is
// always a path *relative to the project root* (C:\Claude\MeetingNote) rather than an OS-absolute
// path - this keeps the whole data/ tree portable if the project folder itself is ever moved or
// copied elsewhere, since nothing on disk points at a fixed drive/absolute location. Resolved
// fresh on every call so a mid-session folder change takes effect immediately.
export async function resolveAttachmentsBaseDir() {
  const settings = await readAppSettings();
  const configured = typeof settings?.attachmentsFolder === "string" ? settings.attachmentsFolder.trim() : "";
  const relativeDir = configured || DEFAULT_ATTACHMENTS_RELATIVE_DIR;

  return path.resolve(PROJECT_ROOT, relativeDir);
}

// Converts an OS-absolute folder path (as returned by Electron's native "select a folder"
// dialog, which can only ever return an absolute path) into a path relative to the project root,
// for storing in AppSettings.attachmentsFolder. Throws if the folder isn't actually under the
// project root (e.g. a different drive, or a sibling folder like C:\Claude\PhoneBook), since a
// relative path with leading ".." segments would defeat the point of staying project-relative.
export function toProjectRelativePath(absolutePath) {
  const relative = path.relative(PROJECT_ROOT, absolutePath);

  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${PROJECT_ROOT} 하위 폴더만 선택할 수 있습니다.`);
  }

  return relative.split(path.sep).join("/");
}

function sanitizeFileName(fileName) {
  return String(fileName || "file").replace(/[\\/:*?"<>|]/g, "_");
}

// Turns a meeting folder label into a filesystem-safe folder name: strips characters Windows
// forbids in path segments, collapses whitespace, and caps the length so a very long label
// doesn't blow past Windows' path-length limits.
function sanitizeFolderName(folderLabel) {
  const trimmed = String(folderLabel ?? "").trim();
  const base = trimmed || "untitled";
  const safe = base
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "_")
    .trim()
    .slice(0, 80)
    .trim();

  return safe || "untitled";
}

// Avoids silently overwriting a same-named file already attached to this meeting (e.g. two
// different "roadmap.pptx" uploads) by appending "-2", "-3", ... before the extension.
async function uniqueFilePath(dir, fileName) {
  const ext = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - ext.length);
  let candidate = fileName;
  let attempt = 1;

  while (existsSync(path.join(dir, candidate))) {
    attempt += 1;
    candidate = `${base}-${attempt}${ext}`;
  }

  return candidate;
}

export async function saveAttachment(meetingFolderLabel, kind, fileName, contentBase64) {
  if (!VALID_KINDS.has(kind)) {
    throw new Error("잘못된 첨부 종류입니다.");
  }

  const buffer = Buffer.from(contentBase64 ?? "", "base64");

  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`첨부파일은 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB 이하여야 합니다.`);
  }

  const folderName = sanitizeFolderName(meetingFolderLabel);
  const baseDir = await resolveAttachmentsBaseDir();
  const meetingDir = path.join(baseDir, folderName, kind);
  await mkdir(meetingDir, { recursive: true });

  const safeName = await uniqueFilePath(meetingDir, sanitizeFileName(fileName));
  await writeFile(path.join(meetingDir, safeName), buffer);

  // Stored relative to baseDir (not the OS-absolute path) so a later change of
  // AppSettings.attachmentsFolder - e.g. moving to a new PC - only requires moving the folder
  // itself; every meeting record keeps working against whatever base is currently configured.
  // NOTE: since the folder is named after a date/title label (not a stable id), editing either
  // field after attaching files does NOT move already-saved files. They stay under the old folder
  // and keep working, while new attachments land under the new folder label.
  const relativePath = path.posix.join(folderName, kind, safeName);

  // B4: a presentation material (PDF/DOCX/PPTX) also gets a sibling .md conversion saved right
  // next to it, so B5 can later feed it to an LLM alongside the matching STT transcript. Never
  // attempted for "audio" uploads, and any conversion failure is silent - the actual attachment
  // upload the user is waiting on must never fail because of this best-effort side step.
  let mdRelativePath = null;
  if (kind === "materials") {
    try {
      const markdown = await convertMaterialToMarkdown(buffer, safeName);
      if (markdown) {
        const mdBaseName = path.basename(safeName, path.extname(safeName));
        const mdSafeName = await uniqueFilePath(meetingDir, `${mdBaseName}.md`);
        await writeFile(path.join(meetingDir, mdSafeName), markdown, "utf8");
        mdRelativePath = path.posix.join(folderName, kind, mdSafeName);
      }
    } catch {
      mdRelativePath = null;
    }
  }

  return { path: relativePath, mdPath: mdRelativePath };
}

// Resolves a stored relative path (as returned by saveAttachment) to an absolute path under the
// *currently configured* base dir, rejecting any attempt to escape it (e.g. via "../").
export async function resolveAttachmentPath(relativePath) {
  const safe = String(relativePath ?? "").replace(/^[/\\]+/, "");

  if (!safe || safe.includes("..") || path.isAbsolute(safe)) {
    throw new Error("잘못된 첨부파일 경로입니다.");
  }

  const baseDir = await resolveAttachmentsBaseDir();
  return path.join(baseDir, safe);
}
