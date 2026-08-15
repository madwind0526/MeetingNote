import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveAttachmentPath, toProjectRelativePath } from "../server/attachments.mjs";

const settingsFilePath = path.resolve(process.cwd(), process.env.MEETINGNOTE_SETTINGS_FILE ?? "data/runtime/app-settings.json");
const allowedWritePaths = new Set<string>();

function readGitValue(command: string, fallback: string) {
  try {
    return execSync(command, { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function buildVersionInfo() {
  const packageJson = JSON.parse(readFileSync(path.resolve(process.cwd(), "package.json"), "utf8")) as { version?: string };
  const version = packageJson.version ?? "0.0.0";
  const majorVersion = version.split(".")[0] || "0";
  const commitCount = readGitValue("git rev-list --count HEAD", "0");
  const commitSha = readGitValue("git rev-parse --short HEAD", "unknown");
  const shaPatch = Number.parseInt(commitSha.slice(0, 1), 16);
  const stateLabel = readGitValue("git status --porcelain", "") ? "dirty" : "clean";
  const buildVersion = `${majorVersion}.${commitCount}.${Number.isFinite(shaPatch) ? shaPatch : 0}`;

  return {
    version,
    buildVersion,
    buildLabel: `v${buildVersion}, ${stateLabel}`,
    commitSha,
    commitCount,
    dirty: stateLabel === "dirty"
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

ipcMain.handle("dialog:saveFile", async (_event, options: { defaultPath?: string; filters?: Electron.FileFilter[] }) => {
  const result = await dialog.showSaveDialog({
    defaultPath: options.defaultPath,
    filters: options.filters
  });

  if (result.canceled || !result.filePath) {
    return null;
  }

  const filePath = path.resolve(result.filePath);
  allowedWritePaths.add(filePath);

  return filePath;
});

ipcMain.handle("dialog:openFile", async (_event, options: { filters?: Electron.FileFilter[] }) => {
  const result = await dialog.showOpenDialog({
    filters: options.filters,
    properties: ["openFile"]
  });

  return result.canceled ? null : result.filePaths[0];
});

// Lets the user pick a real folder for AppSettings.attachmentsFolder (Settings > 저장 폴더). A
// plain `<input type="file">` in the renderer can't do this - only Electron's native dialog
// exposes a real, absolute folder path. The dialog itself can only ever return an absolute path,
// so it's immediately converted to a path relative to the project root (see
// toProjectRelativePath) before being handed back to the renderer - nothing absolute ever gets
// persisted into AppSettings.
ipcMain.handle("dialog:openDirectory", async () => {
  const result = await dialog.showOpenDialog({
    defaultPath: process.cwd(),
    properties: ["openDirectory", "createDirectory"]
  });

  if (result.canceled || !result.filePaths[0]) {
    return { path: null };
  }

  try {
    return { path: toProjectRelativePath(result.filePaths[0]) };
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

void app.whenReady().then(() => {
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
