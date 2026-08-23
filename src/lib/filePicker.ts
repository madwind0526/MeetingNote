import { getFilePickerMode } from "./settingsMirror";

export type FileNavigatorMode = "open" | "save" | "folder";

export interface FileNavigatorRequest {
  mode: FileNavigatorMode;
  title: string;
  // Extensions like [".json", ".pdf"] - "open"/"save" only. Files that don't match are still
  // shown so folder navigation stays predictable, but greyed out and unselectable in open mode.
  accept?: string[];
  defaultFileName?: string;
}

export interface PendingFileNavigatorRequest extends FileNavigatorRequest {
  resolve: (value: string | null) => void;
}

export interface FileNavigatorListing {
  path: string;
  parent: string | null;
  entries: { name: string; isDirectory: boolean }[];
  shortcuts: { label: string; path: string }[];
  error?: string;
}

export interface ConfiguredFilePickResult {
  handled: boolean;
  file: File | null;
}

type HostListener = (request: PendingFileNavigatorRequest | null) => void;

let hostListener: HostListener | null = null;

// FileNavigatorHost registers itself here so non-component modules can open the built-in
// navigator and await a path, just like an Electron dialog call.
export function registerFileNavigatorHost(listener: HostListener): () => void {
  hostListener = listener;
  return () => {
    if (hostListener === listener) {
      hostListener = null;
    }
  };
}

export function requestFileNavigator(request: FileNavigatorRequest): Promise<string | null> {
  return new Promise((resolve) => {
    if (!hostListener) {
      resolve(null);
      return;
    }

    hostListener({ ...request, resolve });
  });
}

function base64ToFile(base64: string, fileName: string): File {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);

  for (let index = 0; index < byteChars.length; index += 1) {
    bytes[index] = byteChars.charCodeAt(index);
  }

  return new File([bytes], fileName);
}

function acceptToElectronFilters(accept?: string[], name = "파일"): { name: string; extensions: string[] }[] | undefined {
  const extensions = (accept ?? [])
    .map((extension) => extension.trim().replace(/^\./, "").toLowerCase())
    .filter((extension) => extension && !extension.includes("*") && !extension.includes("/"));

  return extensions.length > 0 ? [{ name, extensions }] : undefined;
}

function canUseFileNavigatorApi(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return (window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost") && window.location.protocol === "http:";
}

export function isBuiltinFilePickerAvailable(): boolean {
  return Boolean(window.meetingNote?.listDirectory) || canUseFileNavigatorApi();
}

export function shouldUseBuiltinFilePicker(): boolean {
  return getFilePickerMode() === "builtin" && isBuiltinFilePickerAvailable();
}

export function isNativeFileDialogAvailable(): boolean {
  return Boolean(window.meetingNote?.openFileDialog && window.meetingNote?.readFileBase64);
}

async function fetchNavigatorJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    throw new Error(payload?.error || "파일 탐색기 요청에 실패했습니다.");
  }

  return payload as T;
}

export async function listDirectoryWithNavigator(dirPath?: string): Promise<FileNavigatorListing> {
  if (window.meetingNote?.listDirectory) {
    return window.meetingNote.listDirectory(dirPath);
  }

  const params = new URLSearchParams();
  if (dirPath) {
    params.set("path", dirPath);
  }

  return fetchNavigatorJson<FileNavigatorListing>(`/api/file-navigator/list?${params.toString()}`);
}

async function readFileBase64WithNavigator(filePath: string): Promise<string> {
  if (window.meetingNote?.readFileBase64) {
    return window.meetingNote.readFileBase64(filePath);
  }

  const params = new URLSearchParams({ path: filePath });
  const payload = await fetchNavigatorJson<{ contentBase64: string }>(`/api/file-navigator/read?${params.toString()}`);
  return payload.contentBase64;
}

async function toProjectRelativePathWithNavigator(absolutePath: string): Promise<{ path: string | null; error?: string }> {
  if (window.meetingNote?.toProjectRelativePath) {
    return window.meetingNote.toProjectRelativePath(absolutePath);
  }

  const params = new URLSearchParams({ path: absolutePath });
  return fetchNavigatorJson<{ path: string | null; error?: string }>(`/api/file-navigator/to-project-relative?${params.toString()}`);
}

export async function writeFileWithNavigator(filePath: string, contentBase64: string): Promise<void> {
  if (window.meetingNote?.writeFile) {
    await window.meetingNote.writeFile(filePath, contentBase64);
    return;
  }

  await fetchNavigatorJson<{ ok: boolean }>("/api/file-navigator/write", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, contentBase64 })
  });
}

export async function pickFileWithNavigator(accept?: string[], title = "파일 선택"): Promise<File | null> {
  const path = await requestFileNavigator({ mode: "open", title, accept });
  if (!path) {
    return null;
  }

  const base64 = await readFileBase64WithNavigator(path);
  const fileName = path.split(/[\\/]/).pop() || "file";
  return base64ToFile(base64, fileName);
}

export async function pickFileWithNativeDialog(accept?: string[], title = "파일 선택"): Promise<File | null> {
  if (!window.meetingNote?.openFileDialog || !window.meetingNote?.readFileBase64) {
    return null;
  }

  const path = await window.meetingNote.openFileDialog({ title, filters: acceptToElectronFilters(accept, title) });
  if (!path) {
    return null;
  }

  const base64 = await window.meetingNote.readFileBase64(path);
  const fileName = path.split(/[\\/]/).pop() || "file";
  return base64ToFile(base64, fileName);
}

export async function pickFileWithConfiguredPicker(accept?: string[], title = "파일 선택"): Promise<ConfiguredFilePickResult> {
  if (shouldUseBuiltinFilePicker()) {
    return { handled: true, file: await pickFileWithNavigator(accept, title) };
  }

  if (!isNativeFileDialogAvailable()) {
    return { handled: false, file: null };
  }

  try {
    return { handled: true, file: await pickFileWithNativeDialog(accept, title) };
  } catch (error) {
    console.error("Native file dialog failed.", error);
    return { handled: false, file: null };
  }
}

export async function pickSaveTargetWithNavigator(
  defaultFileName: string,
  accept?: string[],
  title = "저장 위치 선택"
): Promise<string | null> {
  return requestFileNavigator({ mode: "save", title, accept, defaultFileName });
}

export async function pickFolderWithNavigator(title = "폴더 선택"): Promise<{ path: string | null; error?: string }> {
  const absolutePath = await requestFileNavigator({ mode: "folder", title });
  if (!absolutePath) {
    return { path: null };
  }

  return toProjectRelativePathWithNavigator(absolutePath);
}

export async function registerWritePathIfNeeded(filePath: string): Promise<void> {
  await window.meetingNote?.registerWritePath?.(filePath);
}
