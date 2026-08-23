import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("meetingNote", {
  clearSettings: () => ipcRenderer.invoke("settings:clear"),
  getBuildInfo: () => ipcRenderer.invoke("build:getInfo"),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings: unknown) => ipcRenderer.invoke("settings:save", settings),
  openFileDialog: (options: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke("dialog:openFile", options),
  openFolderDialog: () => ipcRenderer.invoke("dialog:openDirectory"),
  saveFileDialog: (options: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke("dialog:saveFile", options),
  writeFile: (filePath: string, base64: string) => ipcRenderer.invoke("file:write", filePath, base64),
  listDirectory: (dirPath?: string) => ipcRenderer.invoke("fs:listDir", dirPath),
  readFileBase64: (filePath: string) => ipcRenderer.invoke("fs:readFileBase64", filePath),
  registerWritePath: (filePath: string) => ipcRenderer.invoke("fs:registerWritePath", filePath),
  toProjectRelativePath: (absolutePath: string) => ipcRenderer.invoke("fs:toProjectRelativePath", absolutePath),
  openAttachment: (relativePath: string) => ipcRenderer.invoke("file:openAttachment", relativePath),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  login: (loginId: string, password: string) => ipcRenderer.invoke("auth:login", loginId, password),
  listMembers: () => ipcRenderer.invoke("members:list"),
  createMember: (draft: unknown) => ipcRenderer.invoke("members:create", draft),
  updateMember: (id: string, patch: unknown) => ipcRenderer.invoke("members:update", id, patch),
  disableMember: (id: string) => ipcRenderer.invoke("members:disable", id),
  platform: process.platform
});
