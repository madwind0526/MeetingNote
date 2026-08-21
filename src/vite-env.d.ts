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
  listDirectory: (dirPath?: string) => Promise<{
    path: string;
    parent: string | null;
    entries: { name: string; isDirectory: boolean }[];
    shortcuts: { label: string; path: string }[];
    error?: string;
  }>;
  readFileBase64: (filePath: string) => Promise<string>;
  registerWritePath: (filePath: string) => Promise<boolean>;
  toProjectRelativePath: (absolutePath: string) => Promise<{ path: string | null; error?: string }>;
  openAttachment: (relativePath: string) => Promise<string>;
  quitApp: () => Promise<boolean>;
  login: (loginId: string, password: string) => Promise<import("./types/domain").LoginResult>;
  listMembers: () => Promise<import("./types/domain").PublicMember[]>;
  createMember: (draft: unknown) => Promise<import("./types/domain").PublicMember[]>;
  updateMember: (id: string, patch: unknown) => Promise<import("./types/domain").PublicMember[]>;
  disableMember: (id: string) => Promise<import("./types/domain").PublicMember[]>;
  platform: string;
}

interface Window {
  meetingNote?: MeetingNoteBridge;
}
