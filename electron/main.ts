import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAttachmentPath, toProjectRelativePath } from "../server/attachments.mjs";
import { readMembers, createMember, updateMember, disableMember, verifyLogin, toPublicMember } from "../server/members.mjs";

const settingsFilePath = path.resolve(process.cwd(), process.env.MEETINGNOTE_SETTINGS_FILE ?? "data/runtime/app-settings.json");
const allowedWritePaths = new Set<string>();

// Build version is set by hand in package.json's "version" field instead of being derived from
// git history at request time - `git status --porcelain` in particular scans the whole working
// tree and was a real contributor to slow startup, on top of spawning 3 git subprocesses on every
// launch (this ran on every app boot, not just once).
function buildVersionInfo() {
  const packageJson = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { version?: string };
  const version = packageJson.version ?? "0.0.0";

  return {
    version,
    buildVersion: version,
    buildLabel: `v${version}`,
    commitSha: "",
    commitCount: "",
    dirty: false
  };
}

ipcMain.handle("settings:load", async () => {
  try {
    const raw = await readFile(settingsFilePath, "utf8");

    return JSON.parse(raw);
  } catch {
    return null;
  }
});

ipcMain.handle("build:getInfo", () => buildVersionInfo());

ipcMain.handle("settings:save", async (_event, settings: unknown) => {
  await mkdir(path.dirname(settingsFilePath), { recursive: true });
  await writeFile(settingsFilePath, JSON.stringify(settings, null, 2), "utf8");

  return true;
});

ipcMain.handle("settings:clear", async () => {
  await rm(settingsFilePath, { force: true });

  return true;
});

ipcMain.handle("dialog:saveFile", async (event, options: { defaultPath?: string; filters?: Electron.FileFilter[] }) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const dialogOptions: Electron.SaveDialogOptions = {
    defaultPath: options.defaultPath,
    filters: options.filters
  };
  const result = owner ? await dialog.showSaveDialog(owner, dialogOptions) : await dialog.showSaveDialog(dialogOptions);

  if (result.canceled || !result.filePath) {
    return null;
  }

  const filePath = path.resolve(result.filePath);
  allowedWritePaths.add(filePath);

  return filePath;
});

ipcMain.handle("dialog:openFile", async (event, options: { title?: string; filters?: Electron.FileFilter[] }) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const dialogOptions: Electron.OpenDialogOptions = {
    title: options.title,
    filters: options.filters,
    properties: ["openFile"]
  };
  const result = owner ? await dialog.showOpenDialog(owner, dialogOptions) : await dialog.showOpenDialog(dialogOptions);

  return result.canceled ? null : result.filePaths[0];
});

// plain `<input type="file">` in the renderer can't do this - only Electron's native dialog
// exposes a real, absolute folder path. The dialog itself can only ever return an absolute path,
// so it's immediately converted to a path relative to the project root (see
// toProjectRelativePath) before being handed back to the renderer - nothing absolute ever gets
// persisted into AppSettings.
ipcMain.handle("dialog:openDirectory", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  const dialogOptions: Electron.OpenDialogOptions = {
    defaultPath: process.cwd(),
    properties: ["openDirectory", "createDirectory"]
  };
  const result = owner ? await dialog.showOpenDialog(owner, dialogOptions) : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || !result.filePaths[0]) {
    return { path: null };
  }

  try {
    return { path: toProjectRelativePath(result.filePaths[0]) };
  } catch (error) {
    return { path: null, error: error instanceof Error ? error.message : "잘못된 폴더입니다." };
  }
});

// because some corporate security policies block Electron's native `dialog` module (and the OS
// Explorer shell it wraps) entirely, so `dialog:openFile`/`dialog:saveFile`/`dialog:openDirectory`
// above silently fail there - this gives those users an alternative that only ever touches the
// filesystem through plain `fs.readdir`/`fs.stat`, no OS shell dialog involved.
function fileNavigatorShortcuts() {
  return [
    { label: "바탕화면", path: app.getPath("desktop") },
    { label: "문서", path: app.getPath("documents") },
    { label: "다운로드", path: app.getPath("downloads") },
    { label: "프로젝트 폴더", path: process.cwd() }
  ];
}

ipcMain.handle("fs:listDir", async (_event, dirPath?: string) => {
  const target = dirPath && dirPath.trim() ? path.resolve(dirPath.trim()) : app.getPath("documents");
  const shortcuts = fileNavigatorShortcuts();

  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      throw new Error("폴더가 아닙니다.");
    }

    const rawEntries = await readdir(target, { withFileTypes: true });
    const entries = rawEntries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1;
        }
        return a.name.localeCompare(b.name, "ko");
      });
    const parent = path.dirname(target);

    return { path: target, parent: parent === target ? null : parent, entries, shortcuts };
  } catch (error) {
    return {
      path: target,
      parent: null,
      entries: [],
      shortcuts,
      error: error instanceof Error ? error.message : "폴더를 열지 못했습니다."
    };
  }
});

ipcMain.handle("fs:readFileBase64", async (_event, filePath: string) => {
  const buffer = await readFile(path.resolve(filePath));
  return buffer.toString("base64");
});

// Mirrors what `dialog:saveFile` already does for the native save dialog - the built-in file
// navigator's "save" mode calls this once the user confirms a target path, so `file:write` below
// accepts it through the same allowlist check either picker used.
ipcMain.handle("fs:registerWritePath", async (_event, filePath: string) => {
  allowedWritePaths.add(path.resolve(filePath));
  return true;
});

// same project-relative-only constraint as `dialog:openDirectory` above.
ipcMain.handle("fs:toProjectRelativePath", async (_event, absolutePath: string) => {
  try {
    return { path: toProjectRelativePath(absolutePath) };
  } catch (error) {
    return { path: null, error: error instanceof Error ? error.message : "잘못된 폴더입니다." };
  }
});

ipcMain.handle("file:write", async (_event, filePath: string, base64: string) => {
  const resolvedPath = path.resolve(filePath);

  if (!allowedWritePaths.delete(resolvedPath)) {
    throw new Error("저장 다이얼로그에서 선택한 경로에만 파일을 저장할 수 있습니다.");
  }

  await writeFile(resolvedPath, Buffer.from(base64, "base64"));

  return true;
});

// Opens a previously-uploaded meeting attachment (see /api/attachments in vite.config.mts, which
// stores files under <configured attachments folder>/<meeting title>/materials|audio/) with the
// OS's own default application - e.g. a .docx opens in Word, a .pdf in the system PDF viewer.
// resolveAttachmentPath (shared with the HTTP route) both resolves against whatever
// AppSettings.attachmentsFolder is currently configured and rejects path traversal.
ipcMain.handle("file:openAttachment", async (_event, relativePath: string) => {
  let absolutePath: string;

  try {
    absolutePath = await resolveAttachmentPath(relativePath);
  } catch (error) {
    return error instanceof Error ? error.message : "잘못된 첨부파일 경로입니다.";
  }

  const errorMessage = await shell.openPath(absolutePath);

  return errorMessage || "";
});

ipcMain.handle("auth:login", async (_event, loginId: string, password: string) => verifyLogin(loginId, password));

ipcMain.handle("members:list", async () => {
  const members = await readMembers();
  return members.map(toPublicMember);
});

ipcMain.handle("members:create", async (_event, draft: unknown) => createMember(draft));

ipcMain.handle("members:update", async (_event, id: string, patch: unknown) => updateMember(id, patch));

ipcMain.handle("members:disable", async (_event, id: string) => disableMember(id));

ipcMain.handle("app:quit", () => {
  setTimeout(() => app.quit(), 0);

  return true;
});

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: "MeetingNote",
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    void win.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }

  void win.loadFile(path.join(__dirname, "../dist/index.html"));
};

// `navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })` call routes through here
// instead of Chromium's normal screen/window picker dialog. `audio: "loopback"` is what actually
// gets the PC's speaker output (everything currently playing through it) as a MediaStream track;
// a `getUserMedia({ audio: true })` call would only ever capture the microphone, never this. The
// video track this hands back is required by the API shape but immediately discarded by the
// renderer (see src/lib/systemAudioCapture.ts) - only the audio track is used.
function registerSystemAudioCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources[0]) {
        callback({ video: sources[0], audio: "loopback" });
      } else {
        callback({});
      }
    } catch {
      callback({});
    }
  }, { useSystemPicker: false });
}

void app.whenReady().then(() => {
  registerSystemAudioCaptureHandler();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
