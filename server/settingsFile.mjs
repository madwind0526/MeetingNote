import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const SETTINGS_PATH = path.resolve(process.cwd(), process.env.MEETINGNOTE_SETTINGS_FILE ?? "data/runtime/app-settings.json");

// Shared by vite.config.mts's /api/settings route and server/attachments.mjs, so the configured
// attachments folder (see AppSettings.attachmentsFolder) is available wherever files get saved
// or opened, without those modules needing to know about the HTTP layer.
export async function readAppSettings() {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function settingsFilePath() {
  return SETTINGS_PATH;
}
