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

// Shared by sttLocalWhisperCli.mjs, sttLocalWhisperX.mjs, and vocalIsolation.mjs so Settings'
// CPU/GPU choice (AppSettings.computeDevice) is the one place all three local tools read their
// torch device from, instead of each shelling out with its own hardcoded "cuda" default. Missing/
// invalid settings resolve to "cuda" - the same default all three used before this setting existed.
export async function resolveComputeDevice() {
  const settings = await readAppSettings();
  return settings?.computeDevice === "cpu" ? "cpu" : "cuda";
}
