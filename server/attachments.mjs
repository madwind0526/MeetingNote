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
// AppSettings.attachmentsFolder is always a path relative to the project root rather than an
// OS-absolute path. This keeps the whole data tree portable if the project folder itself is moved.
export async function resolveAttachmentsBaseDir() {
  const settings = await readAppSettings();
  const configured = typeof settings?.attachmentsFolder === "string" ? settings.attachmentsFolder.trim() : "";
  const relativeDir = configured || DEFAULT_ATTACHMENTS_RELATIVE_DIR;

  return path.resolve(PROJECT_ROOT, relativeDir);
}

// Converts an OS-absolute folder path into a path relative to the project root for storing in
// AppSettings.attachmentsFolder. Throws if the folder is not actually under the project root.
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

// Turns a meeting folder label into a filesystem-safe folder name.
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

// Avoids silently overwriting a same-named file already attached to this meeting.
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

  // Stored relative to baseDir so changing AppSettings.attachmentsFolder only requires moving the
  // folder itself. Meeting records keep working against whatever base is currently configured.
  const relativePath = path.posix.join(folderName, kind, safeName);

  // B4: a presentation material also gets a sibling .md conversion saved next to it.
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

// Resolves a stored relative path under the currently configured base dir.
export async function resolveAttachmentPath(relativePath) {
  const safe = String(relativePath ?? "").replace(/^[/\\]+/, "");

  if (!safe || path.isAbsolute(safe) || safe.split(/[\\/]+/).some((segment) => segment === "..")) {
    throw new Error("잘못된 첨부 파일 경로입니다.");
  }

  const baseDir = await resolveAttachmentsBaseDir();
  const resolvedPath = path.resolve(baseDir, safe);
  const relative = path.relative(baseDir, resolvedPath);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("잘못된 첨부 파일 경로입니다.");
  }

  return resolvedPath;
}
