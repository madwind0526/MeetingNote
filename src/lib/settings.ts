import type { AppSettings } from "../types/domain";
import { defaultSettings } from "../types/domain";
import { jsonAuthHeaders } from "./auth";

const SETTINGS_STORAGE_KEY = "meetingnote-settings";

function normalizeSettings(parsed: Partial<AppSettings> | null): AppSettings {
  const settings = { ...defaultSettings, ...(parsed ?? {}) };

  if (!["replace", "add", "skip"].includes(settings.importDuplicateMode)) {
    settings.importDuplicateMode = defaultSettings.importDuplicateMode;
  }

  if (!["pdf", "docx", "pptx", "md", "json"].includes(settings.exportDefaultFormat)) {
    settings.exportDefaultFormat = defaultSettings.exportDefaultFormat;
  }

  if (!["mock", "local-whisper-cli", "local-whisperx", "openai-whisper", "naver-clova"].includes(settings.sttProvider)) {
    settings.sttProvider = defaultSettings.sttProvider;
  }

  if (!["native", "builtin"].includes(settings.filePickerMode)) {
    settings.filePickerMode = defaultSettings.filePickerMode;
  }

  if (!["cpu", "gpu"].includes(settings.computeDevice)) {
    settings.computeDevice = defaultSettings.computeDevice;
  }

  if (typeof settings.vadOnset !== "number" || !Number.isFinite(settings.vadOnset)) {
    settings.vadOnset = defaultSettings.vadOnset;
  }

  if (typeof settings.vadOffset !== "number" || !Number.isFinite(settings.vadOffset)) {
    settings.vadOffset = defaultSettings.vadOffset;
  }

  if (typeof settings.systemMessage !== "string") {
    settings.systemMessage = defaultSettings.systemMessage;
  }

  if (typeof settings.silenceThreshold !== "number" || !Number.isFinite(settings.silenceThreshold) || settings.silenceThreshold < 0) {
    settings.silenceThreshold = defaultSettings.silenceThreshold;
  }

  return settings;
}

function persistSettingsFile(settings: AppSettings) {
  const fileSave =
    window.meetingNote?.saveSettings?.(settings) ??
    // Electron IPC (above) never touches HTTP, but this browser-tab fallback does, and
    // /api/settings PUT now requires a logged-in member (see vite.config.mts) - same
    // jsonAuthHeaders() every other authenticated fetch in this app uses.
    fetch("/api/settings", {
      method: "PUT",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(settings)
    }).then((response) => response.ok);

  void fileSave.catch((error: unknown) => {
    console.error("Failed to save settings file.", error);
  });
}

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") {
    return defaultSettings;
  }

  const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);

  if (!raw) {
    return defaultSettings;
  }

  try {
    return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return defaultSettings;
  }
}

export async function loadSettingsFile(): Promise<AppSettings | null> {
  try {
    const parsed =
      (await window.meetingNote?.loadSettings?.()) ??
      (await fetch("/api/settings")
        .then((response) => (response.ok ? response.json() : null))
        .catch(() => null));

    if (!parsed) {
      return null;
    }

    const settings = normalizeSettings(parsed as Partial<AppSettings>);
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return settings;
  } catch (error) {
    console.error("Failed to load settings file.", error);
    return null;
  }
}

export function saveSettings(settings: AppSettings) {
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  persistSettingsFile(settings);
}
