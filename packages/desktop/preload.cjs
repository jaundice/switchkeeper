const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("switchkeeper", {
  read: (req) => ipcRenderer.invoke("switch:read", req),
  plan: (req) => ipcRenderer.invoke("switch:plan", req),
  apply: (req) => ipcRenderer.invoke("switch:apply", req),
  save: (req) => ipcRenderer.invoke("switch:save", req),
  topology: (req) => ipcRenderer.invoke("switch:topology", req),
  capabilities: (req) => ipcRenderer.invoke("switch:capabilities", req),
  openUrl: (url) => ipcRenderer.invoke("open:external", url),
  openLink: (url) => ipcRenderer.invoke("open:link", url),
  mibPointers: (req) => ipcRenderer.invoke("mib:pointers", req),
  mibStatus: () => ipcRenderer.invoke("mib:status"),
  importMib: () => ipcRenderer.invoke("mib:import"),
  interfaces: () => ipcRenderer.invoke("net:interfaces"),
  scan: (req) => ipcRenderer.invoke("net:scan", req),
  onScanDevice: (cb) => {
    const h = (_e, d) => cb(d);
    ipcRenderer.on("scan:device", h);
    return () => ipcRenderer.removeListener("scan:device", h);
  },
});
