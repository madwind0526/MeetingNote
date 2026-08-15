import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("meetingNote", {
  clearSettings: () => ipcRenderer.invoke("settings:clear"),
  getBuildInfo: () => ipcRenderer.invoke("build:getInfo"),
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings: unknown) => ipcRenderer.invoke("settings:save", settings),
  openFileDialog: (options: { filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke("dialog:openFile", options),
  openFolderDialog: () => ipcRenderer.invoke("dialog:openDirectory"),
  saveFileDialog: (options: { defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    ipcRenderer.invoke("dialog:saveFile", options),
  writeFile: (filePath: string, base64: string) => ipcRenderer.invoke("file:write", filePath, base64),
  openAttachment: (relativePath: string) => ipcRenderer.invoke("file:openAttachment", relativePath),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  platform: process.platform
});
