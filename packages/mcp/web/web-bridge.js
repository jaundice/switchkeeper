// Web shell bridge: provides window.switchkeeper (the same API the Electron preload exposes)
// backed by fetch() to the server's /api endpoints, so the exact same renderer app.js runs
// unchanged in the browser / as an installed PWA.
(function () {
  async function post(path, body) {
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      return await r.json();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  let scanCb = null;
  window.switchkeeper = {
    read: (req) => post("/api/read", req),
    plan: (req) => post("/api/plan", req),
    apply: (req) => post("/api/apply", req),
    save: (req) => post("/api/save", req),
    topology: (req) => post("/api/topology", req),
    interfaces: async () => {
      try {
        return await (await fetch("/api/interfaces")).json();
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
      try { return await (await fetch("/api/mib-status")).json(); }
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
