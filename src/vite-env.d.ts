/// <reference types="vite/client" />

declare const __MEETINGNOTE_VERSION__: string;
declare const __MEETINGNOTE_BUILD_VERSION__: string;
declare const __MEETINGNOTE_BUILD_LABEL__: string;
declare const __MEETINGNOTE_COMMIT_SHA__: string;
declare const __MEETINGNOTE_COMMIT_COUNT__: string;
declare const __MEETINGNOTE_GIT_DIRTY__: boolean;

interface MeetingNoteBridge {
  clearSettings: () => Promise<boolean>;
  getBuildInfo: () => Promise<unknown>;
  loadSettings: () => Promise<unknown>;
  saveSettings: (settings: unknown) => Promise<boolean>;
  openFileDialog: (options: { filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  openFolderDialog: () => Promise<{ path: string | null; error?: string }>;
  saveFileDialog: (options: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
  writeFile: (filePath: string, base64: string) => Promise<boolean>;
  openAttachment: (relativePath: string) => Promise<string>;
  quitApp: () => Promise<boolean>;
  platform: string;
}

interface Window {
  meetingNote?: MeetingNoteBridge;
}
