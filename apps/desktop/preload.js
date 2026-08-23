// Exposed on every page this window loads — including the workspace itself
// once connected. contextIsolation keeps it from leaking Node internals;
// the workspace page simply never calls it.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("logbridgeDesktop", {
  getServerUrl: () => ipcRenderer.invoke("logbridge:get-server-url"),
  setServerUrl: (url) => ipcRenderer.invoke("logbridge:set-server-url", url),
});
