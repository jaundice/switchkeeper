// Electron main process. The engine is bundled into ./build/engine.cjs (esbuild) and called
// in-process, so the packaged app is fully self-contained (no host Node / no child processes).
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const engine = require("./build/engine.cjs");

// UI credential object -> engine Credential.
function credFromWeb(c) {
  if (c && c.version === "v3") {
    const v = c.v3 || {};
    return {
      protocol: "snmpV3",
      v3: { user: v.user || "", authProtocol: v.authProto, authKey: v.authKey, privProtocol: v.privProto, privKey: v.privKey },
    };
  }
  return { protocol: "snmpV2c", readCommunity: (c && c.community) || "public", writeCommunity: c && c.writeCommunity };
}
const fail = (e) => ({ ok: false, error: String((e && e.message) || e) });

ipcMain.handle("switch:read", async (_e, { host, cred }) => {
  try { return { ok: true, state: await engine.readDevice(host, credFromWeb(cred)) }; } catch (e) { return fail(e); }
});
ipcMain.handle("switch:plan", async (_e, { host, cred, edits }) => {
  try { return { ok: true, data: { mode: "plan", changeSet: await engine.planDevice(host, credFromWeb(cred), edits || []) } }; } catch (e) { return fail(e); }
});
ipcMain.handle("switch:apply", async (_e, { host, cred, edits, acknowledge }) => {
  // Phase 2: forward the acknowledge gate ({allowRisky,allowBlocked}) to the engine; never auto-save
  // here (save is the separate switch:save action, gated on reachableAfter in the UI).
  try { const r = await engine.applyDevice(host, credFromWeb(cred), edits || [], { save: false, acknowledge }); return { ok: true, data: { mode: "apply", changeSet: r.changeSet, save: r.save, reachableAfter: r.reachableAfter } }; } catch (e) { return fail(e); }
});
ipcMain.handle("switch:save", async (_e, { host, cred }) => {
  try { const r = await engine.applyDevice(host, credFromWeb(cred), [], { save: true }); return { ok: true, data: { mode: "apply", changeSet: r.changeSet, save: r.save } }; } catch (e) { return fail(e); }
});
ipcMain.handle("switch:topology", async (_e, { host, cred }) => {
  try { return { ok: true, data: await engine.readTopology(host, credFromWeb(cred)) }; } catch (e) { return fail(e); }
});
// Adaptive MIB-driven capability model. Uses the desktop's in-process MibStore (ensureMibStore),
// so generic vendor sections appear once the user has imported the device's MIBs. Read-only.
ipcMain.handle("switch:capabilities", async (_e, { host, cred }) => {
  try { return { ok: true, data: await engine.readDeviceCapabilities(host, credFromWeb(cred), ensureMibStore()) }; } catch (e) { return fail(e); }
});
// Phase 3: editor metadata for one writable object. Uses the desktop's in-process MibStore so the
// renderer (Advanced mode) can build a type-aware edit widget from the object's MIB SYNTAX. No
// device needed. Returns data:null if the object can't be resolved (renderer falls back to text).
ipcMain.handle("switch:object-meta", async (_e, { name, oid } = {}) => {
  try { return { ok: true, data: engine.describeObject(ensureMibStore(), name || oid) }; } catch (e) { return fail(e); }
});
ipcMain.handle("net:interfaces", async () => {
  try { return { ok: true, data: engine.listInterfaces() }; } catch (e) { return fail(e); }
});
ipcMain.handle("net:scan", async (event, { specs, cred }) => {
  try {
    const arr = String(specs).split(",").map((s) => s.trim()).filter(Boolean);
    await engine.discoverMany(arr, {
      credential: credFromWeb(cred),
      onFound: (d) => event.sender.send("scan:device", { ...d, vendor: engine.profileForEnterprise(d.vendorEnterprise).name }),
    });
    return { ok: true };
  } catch (e) { return fail(e); }
});
ipcMain.handle("open:external", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\/[\w.-]+(:\d+)?\/?$/.test(url)) shell.openExternal(url);
});
// Open a full https URL (used for MIB download pointers, which have paths/query).
ipcMain.handle("open:link", (_e, url) => {
  if (typeof url === "string" && /^https:\/\/[\w.-]+(:\d+)?(\/[^\s]*)?$/.test(url)) shell.openExternal(url);
});

// ---- MIB loader: download pointers + import vendor MIBs (in-process MibStore) ----
let mibStore = null;
// Bundled standard MIBs: in a packaged build they're copied to resources (electron-builder
// extraResources); in dev (electron .) they live in the sibling mcp package.
const STD_MIB_DIR = (() => {
  try {
    const packaged = path.join(process.resourcesPath || "", "mibs-std");
    if (fs.existsSync(packaged)) return packaged;
  } catch { /* not packaged */ }
  return path.join(__dirname, "..", "mcp", "mibs-std");
})();
const ensureMibStore = () => {
  if (!mibStore) {
    mibStore = engine.createMibStore();
    try { mibStore.indexDir(STD_MIB_DIR); } catch { /* bundle not present (packaged build) */ }
  }
  return mibStore;
};

ipcMain.handle("mib:pointers", (_e, { enterprise, sysDescr } = {}) => {
  try { return { ok: true, data: engine.mibPointersFor(enterprise, sysDescr) }; } catch (e) { return fail(e); }
});
ipcMain.handle("mib:status", () => {
  try { return { ok: true, data: { loaded: mibStore ? mibStore.loadedModules().length : 0, indexed: mibStore ? mibStore.indexedModules().length : 0 } }; } catch (e) { return fail(e); }
});
ipcMain.handle("mib:import", async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: "Import MIB files",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "MIB files", extensions: ["mib", "txt", "my", "smi"] }, { name: "All files", extensions: ["*"] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: true, data: { canceled: true } };
    const store = ensureMibStore();
    const imported = [];
    for (const f of r.filePaths) { const m = store.loadFile(f); if (m) imported.push(m); }
    return { ok: true, data: { canceled: false, imported, modules: store.loadedModules().length, indexed: store.indexedModules().length } };
  } catch (e) { return fail(e); }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1180,
    height: 820,
    backgroundColor: "#0f1419",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
