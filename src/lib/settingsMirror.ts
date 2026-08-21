import type { AppSettings } from "../types/domain";

// Lets non-component modules (lib/api.ts, lib/filePicker.ts) read the current file-picker
// preference without threading it through every component prop chain between App.tsx and each
// file-picking call site. App.tsx calls setSettingsMirror whenever `settings` changes.
let current: AppSettings | null = null;

export function setSettingsMirror(settings: AppSettings) {
  current = settings;
}

export function getFilePickerMode(): AppSettings["filePickerMode"] {
  return current?.filePickerMode ?? "native";
}
