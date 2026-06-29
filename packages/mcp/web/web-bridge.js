// Web shell bridge: provides window.switchkeeper (the same API the Electron preload exposes)
// backed by fetch() to the server's /api endpoints, so the exact same renderer app.js runs
// unchanged in the browser / as an installed PWA.
(function () {
  // Parse a fetch Response defensively. The server can briefly return an empty body or a
  // non-JSON error page (timeout, proxy cut the connection, !ok status, server busy/unreachable).
  // Calling r.json() blindly throws "Unexpected end of JSON input" and surfaces as a raw
  // exception in the UI; instead we read the text first and turn any non-JSON body into a clean
  // { ok:false, error } the renderer already knows how to display.
  async function readJson(r) {
    const text = await r.text();
    if (text) {
      try {
        return JSON.parse(text);
      } catch (_e) {
        /* fall through to the structured error below */
      }
    }
    return {
      ok: false,
      error: `${r.status} ${r.statusText}: empty or non-JSON response (server may be busy/unreachable)`,
    };
  }

  async function post(path, body) {
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return await readJson(r);
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  let scanCb = null;
  window.switchkeeper = {
    read: (req) => post("/api/read", req),
    plan: (req) => post("/api/plan", req),
    // apply forwards the whole request body, so a Phase 2 `acknowledge` field
    // ({allowRisky,allowBlocked}) — when the renderer includes it — reaches the engine gate.
    apply: (req) => post("/api/apply", req),
    save: (req) => post("/api/save", req),
    topology: (req) => post("/api/topology", req),
    capabilities: (req) => post("/api/capabilities", req),
    // Lazy-tables refactor: fetch one generic table's rows on demand ({host,cred,entry}). The
    // capability model lists vendor tables as lazy stubs (no rows); the renderer calls this when the
    // user expands a table. Returns { ok, data: CapabilitySection|null } (null while the store builds).
    tableRows: (req) => post("/api/table", req),
    // Phase 3: fetch one object's MIB SYNTAX ({name?,oid?}) so the renderer can build a type-aware
    // edit widget. Returns { ok, data: MibSyntax|null } (null while the MIB store is still building).
    objectMeta: (req) => post("/api/object-meta", req),
    interfaces: async () => {
      try {
        return await readJson(await fetch("/api/interfaces"));
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    },
    scan: async (req) => {
      const res = await post("/api/scan", req);
      if (res.ok && Array.isArray(res.data) && scanCb) for (const d of res.data) scanCb(d);
      return res.ok ? { ok: true } : res;
    },
    onScanDevice: (cb) => { scanCb = cb; return () => { scanCb = null; }; },
    openUrl: (url) => { window.open(url, "_blank", "noopener"); return Promise.resolve(); },
    openLink: (url) => { window.open(url, "_blank", "noopener"); return Promise.resolve(); },
    mibPointers: (req) => post("/api/mib-pointers", req),
    mibStatus: async () => {
      try { return await readJson(await fetch("/api/mib-status")); }
      catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    },
    // Pick MIB file(s) in the browser and upload their text to the server.
    importMib: () => new Promise((resolve) => {
      const inp = document.createElement("input");
      inp.type = "file";
      inp.multiple = true;
      inp.accept = ".mib,.txt,.my,.smi";
      inp.style.display = "none";
      document.body.appendChild(inp);
      inp.addEventListener("change", async () => {
        const files = Array.from(inp.files || []);
        inp.remove();
        if (!files.length) return resolve({ ok: true, data: { canceled: true } });
        try {
          const payload = await Promise.all(files.map(async (f) => ({ name: f.name, text: await f.text() })));
          resolve(await post("/api/mib-import", { files: payload }));
        } catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
      });
      inp.click();
    }),
  };
})();
