const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("switchkeeper", {
  read: (req) => ipcRenderer.invoke("switch:read", req),
  plan: (req) => ipcRenderer.invoke("switch:plan", req),
  // apply forwards the whole request, so a Phase 2 `acknowledge` field reaches the main process.
  apply: (req) => ipcRenderer.invoke("switch:apply", req),
  save: (req) => ipcRenderer.invoke("switch:save", req),
  topology: (req) => ipcRenderer.invoke("switch:topology", req),
  capabilities: (req) => ipcRenderer.invoke("switch:capabilities", req),
  // Lazy-tables refactor: load one generic table's rows on demand ({host,cred,entry}). The capability
  // model lists vendor tables as lazy stubs (no rows); the renderer calls this on first expand.
  tableRows: (req) => ipcRenderer.invoke("switch:table", req),
  // Phase 3: fetch one object's MIB SYNTAX so the renderer can build a type-aware edit widget.
  objectMeta: (req) => ipcRenderer.invoke("switch:object-meta", req),
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
