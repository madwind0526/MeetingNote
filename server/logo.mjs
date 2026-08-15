import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const LOGO_PATH = path.join(ROOT, "assets", "logo.png");
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};

function parseImageDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(String(dataUrl ?? ""));

  if (!match) {
    return null;
  }

  const [, mimeType, base64] = match;
  if (!MIME_EXTENSIONS[mimeType]) {
    return null;
  }

  const buffer = Buffer.from(base64.replace(/\s/g, ""), "base64");

  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`이미지 파일은 ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB 이하여야 합니다.`);
  }

  return { buffer, mimeType };
}

// Saved under the same name/extension regardless of the uploaded file's real format - <img>
// tags render by sniffing actual content, not the src extension.
export async function saveLogoImage(dataUrl) {
  const image = parseImageDataUrl(dataUrl);

  if (!image) {
    throw new Error("올바른 이미지 파일이 아닙니다.");
  }

  await mkdir(path.dirname(LOGO_PATH), { recursive: true });

  // Vite dev-server publicDir static serving can keep serving the SPA fallback for this exact
  // path after an in-place overwrite (see C:\Claude\memory-bank\vite-dev-publicdir-overwrite-stale.md)
  // - delete first so it sees a real file-create event.
  await rm(LOGO_PATH, { force: true });
  await writeFile(LOGO_PATH, image.buffer);
}
