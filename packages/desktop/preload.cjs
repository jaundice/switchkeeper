const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("switchkeeper", {
  read: (req) => ipcRenderer.invoke("switch:read", req),
  plan: (req) => ipcRenderer.invoke("switch:plan", req),
  apply: (req) => ipcRenderer.invoke("switch:apply", req),
  save: (req) => ipcRenderer.invoke("switch:save", req),
  openUrl: (url) => ipcRenderer.invoke("open:external", url),
  interfaces: () => ipcRenderer.invoke("net:interfaces"),
  scan: (req) => ipcRenderer.invoke("net:scan", req),
  onScanDevice: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on("scan:device", h);
    return () => ipcRenderer.removeListener("scan:device", h);
  },
});
