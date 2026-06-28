// Switchkeeper server. One process exposes THREE things over HTTP (--http <port>):
//   - the web UI (the same renderer the Electron app uses, reused as a PWA) at /
//   - a JSON HTTP API the web UI calls at /api/*
//   - the MCP server (engine tools for agents) at /mcp
// Or stdio MCP (default, no --http) for a local agent.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  listInterfaces,
  discover,
  discoverMany,
  readDevice,
  planDevice,
  applyDevice,
  saveDevice,
  profileForEnterprise,
  mibPointersFor,
  readTopology,
  createMibStore,
} from "../../engine/src/index.ts";
import type { Credential, Edit } from "../../engine/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererDir = path.join(__dirname, "..", "..", "desktop", "renderer");
const webDir = path.join(__dirname, "..", "web");

/** UI credential object -> engine Credential. */
function credFromWeb(c: any): Credential {
  if (c && c.version === "v3") {
    return {
      protocol: "snmpV3",
      v3: {
        user: c.v3?.user ?? "",
        authProtocol: c.v3?.authProto,
        authKey: c.v3?.authKey,
        privProtocol: c.v3?.privProto,
        privKey: c.v3?.privKey,
      },
    };
  }
  return { protocol: "snmpV2c", readCommunity: c?.community || "public", writeCommunity: c?.writeCommunity };
}
function v2c(community?: string, writeCommunity?: string): Credential {
  return { protocol: "snmpV2c", readCommunity: community ?? "public", writeCommunity };
}
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

// --- server-side MIB store: user-uploaded MIBs persist in MIB_DIR ---
// Parsing a large vendor MIB set is CPU-heavy and would block the event loop, so we never parse on
// the request path. The store is served from MIB_DIR's on-disk cache (instant); if that cache is
// missing/stale, a SEPARATE process (build-mib-cache.ts) rebuilds it in the background while the
// server stays responsive. /api/mib-status reports {ready, building} so callers can poll.
const MIB_DIR = process.env.SWITCHKEEPER_MIB_DIR || path.resolve(__dirname, "..", "..", "..", "mibs");
const STD_MIB_DIR = path.resolve(__dirname, "..", "mibs-std"); // bundled standard IETF/IEEE MIBs
let _mibStore: ReturnType<typeof createMibStore> | null = null;
let mibBuilding = false;

// Populate the store from MIB_DIR's cache without parsing. Returns the store, or null if no cache.
function tryLoadMibCache() {
  const s = createMibStore();
  try { s.indexDir(STD_MIB_DIR); } catch { /* no bundle */ }
  try { if (s.loadDirFromCache(MIB_DIR)) _mibStore = s; } catch { /* */ }
  return _mibStore;
}

// Kick off the cold build in a child process (non-blocking); it writes the cache when done.
function spawnMibBuild() {
  if (mibBuilding) return;
  mibBuilding = true;
  try { fs.mkdirSync(MIB_DIR, { recursive: true }); } catch { /* */ }
  const script = path.join(__dirname, "build-mib-cache.ts");
  const child = spawn(process.execPath, [...process.execArgv, script, MIB_DIR, STD_MIB_DIR], { stdio: "ignore" });
  child.on("error", () => { mibBuilding = false; });
  child.on("exit", () => { mibBuilding = false; tryLoadMibCache(); }); // pick up the fresh cache
}

// The ready store, or null while building (callers handle the not-ready case).
function mibStore() {
  if (_mibStore) return _mibStore;
  if (tryLoadMibCache()) return _mibStore; // cache present -> instant
  spawnMibBuild(); // no cache yet -> build in the background
  return null;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "switchkeeper", version: "0.1.0" });
  server.registerTool("switch_list_interfaces", {
    description: "List this host's network interfaces and their IPv4 subnets (to pick a scan range).",
    inputSchema: {},
  }, async () => ok(listInterfaces()));
  server.registerTool("switch_discover", {
    description: "SNMP-sweep a subnet/CIDR; returns answering devices with vendor enterprise no. and model.",
    inputSchema: { subnet: z.string().describe("CIDR, range, or IP, e.g. 192.168.1.0/24"), community: z.string().optional() },
  }, async ({ subnet, community }) => ok(await discover(subnet, { community })));
  server.registerTool("switch_read", {
    description: "Read a switch's full state: ports, VLANs, PVIDs, PoE, LAGs, capabilities.",
    inputSchema: { host: z.string(), community: z.string().optional() },
  }, async ({ host, community }) => ok(await readDevice(host, v2c(community))));
  server.registerTool("switch_plan", {
    description: "Dry-run: diff edits against the live switch (no writes). edits e.g. [{\"kind\":\"setPvid\",\"bridgePort\":1,\"vid\":10}].",
    inputSchema: { host: z.string(), edits: z.array(z.record(z.any())), community: z.string().optional() },
  }, async ({ host, edits, community }) => ok(await planDevice(host, v2c(community), edits as Edit[])));
  server.registerTool("switch_apply", {
    description: "Apply edits with read-back verify + rollback. Requires a write community. save=true persists after.",
    inputSchema: { host: z.string(), edits: z.array(z.record(z.any())), writeCommunity: z.string(), community: z.string().optional(), save: z.boolean().optional() },
  }, async ({ host, edits, writeCommunity, community, save }) =>
    ok(await applyDevice(host, v2c(community, writeCommunity), edits as Edit[], { save: !!save })));
  server.registerTool("switch_save", {
    description: "Persist running config to startup (vendor-specific; may be unsupported on some models).",
    inputSchema: { host: z.string(), writeCommunity: z.string(), community: z.string().optional() },
  }, async ({ host, writeCommunity, community }) => ok(await saveDevice(host, v2c(community, writeCommunity))));
  server.registerTool("switch_mib_pointers", {
    description: "Where to download the vendor MIB for a switch, given its SNMP enterprise number (and optionally sysDescr). Returns official links plus a search fallback.",
    inputSchema: { enterprise: z.number().optional(), sysDescr: z.string().optional() },
  }, async ({ enterprise, sysDescr }) => ok(mibPointersFor(enterprise, sysDescr)));
  server.registerTool("switch_topology", {
    description: "Read LLDP neighbours and the forwarding database (MAC->port) from a switch, for uplink/trunk discovery (a port with many MACs is an uplink).",
    inputSchema: { host: z.string(), community: z.string().optional() },
  }, async ({ host, community }) => ok(await readTopology(host, v2c(community))));
  return server;
}

const httpIdx = process.argv.indexOf("--http");
if (httpIdx >= 0) {
  const port = Number(process.argv[httpIdx + 1] ?? 7341);
  const app = express();
  app.use(express.json({ limit: "16mb" })); // MIB text uploads can be large

  // --- web UI (reuse the Electron renderer, transformed for the browser) ---
  let webHtml: string | null = null;
  const getWebHtml = () => {
    if (webHtml === null) {
      let h = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");
      h = h.replace(
        /<meta http-equiv="Content-Security-Policy"[^>]*>/,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self';">`,
      );
      h = h.replace(
        '<script src="app.js"></script>',
        '<link rel="manifest" href="/manifest.webmanifest"><script src="/web-bridge.js"></script><script src="/app.js"></script>' +
          '<script>if("serviceWorker"in navigator)navigator.serviceWorker.register("/sw.js").catch(()=>{});</script>',
      );
      webHtml = h;
    }
    return webHtml;
  };
  app.get("/", (_req, res) => res.type("html").send(getWebHtml()));
  app.get("/app.js", (_req, res) => res.type("application/javascript").send(fs.readFileSync(path.join(rendererDir, "app.js"), "utf8")));
  app.use(express.static(webDir)); // web-bridge.js, manifest.webmanifest, sw.js, icon.svg

  app.get("/health", (_req, res) => res.json({ ok: true, service: "switchkeeper" }));

  // --- JSON HTTP API for the web UI (mirrors the Electron IPC shapes) ---
  const wrap = (fn: (b: any) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req.body || {})); }
    catch (e) { res.json({ ok: false, error: String((e && (e as Error).message) || e) }); }
  };
  app.post("/api/read", wrap(async (b) => ({ ok: true, state: await readDevice(b.host, credFromWeb(b.cred)) })));
  app.post("/api/plan", wrap(async (b) => ({ ok: true, data: { mode: "plan", changeSet: await planDevice(b.host, credFromWeb(b.cred), b.edits || []) } })));
  app.post("/api/apply", wrap(async (b) => {
    const r = await applyDevice(b.host, credFromWeb(b.cred), b.edits || [], { save: false });
    return { ok: true, data: { mode: "apply", changeSet: r.changeSet, save: r.save } };
  }));
  app.post("/api/save", wrap(async (b) => {
    const r = await applyDevice(b.host, credFromWeb(b.cred), [], { save: true });
    return { ok: true, data: { mode: "apply", changeSet: r.changeSet, save: r.save } };
  }));
  app.post("/api/scan", wrap(async (b) => {
    const specs = String(b.specs || "").split(",").map((s) => s.trim()).filter(Boolean);
    const results = await discoverMany(specs, { credential: credFromWeb(b.cred) });
    return { ok: true, data: results.map((r) => ({ ...r, vendor: profileForEnterprise(r.vendorEnterprise).name })) };
  }));
  app.get("/api/interfaces", (_req, res) => res.json({ ok: true, data: listInterfaces() }));
  app.post("/api/mib-pointers", wrap(async (b) => ({ ok: true, data: mibPointersFor(b.enterprise, b.sysDescr) })));
  app.post("/api/topology", wrap(async (b) => ({ ok: true, data: await readTopology(b.host, credFromWeb(b.cred)) })));
  app.get("/api/mib-status", (_req, res) => {
    const s = mibStore(); // null while a background build is in progress
    if (!s) return res.json({ ok: true, data: { ready: false, building: mibBuilding, loaded: 0, indexed: 0, dir: MIB_DIR } });
    res.json({ ok: true, data: { ready: true, building: false, loaded: s.loadedModules().length, indexed: s.indexedModules().length, dir: MIB_DIR } });
  });
  app.post("/api/mib-import", wrap(async (b) => {
    const files: { name: string; text: string }[] = Array.isArray(b.files)
      ? b.files
      : (b.name && typeof b.text === "string" ? [{ name: b.name, text: b.text }] : []);
    if (!files.length) return { ok: false, error: "no MIB files provided" };
    fs.mkdirSync(MIB_DIR, { recursive: true });
    const imported: string[] = [];
    for (const f of files) {
      const safe = path.basename(String(f.name || "uploaded.mib")).replace(/[^\w.\-]/g, "_");
      fs.writeFileSync(path.join(MIB_DIR, safe), String(f.text ?? ""), "latin1");
      imported.push(safe);
    }
    // New files invalidate the cache signature; rebuild in the background (no request-path parsing).
    _mibStore = null;
    spawnMibBuild();
    return { ok: true, data: { imported, building: true, message: "MIBs saved; indexing in the background (poll /api/mib-status)" } };
  }));

  // --- MCP endpoint (stateless) ---
  app.post("/mcp", async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(port, () => {
    console.error(`switchkeeper on :${port} (UI /, API /api, MCP /mcp)`);
    mibStore(); // warm the MIB cache (serves instantly if cached, else builds in the background)
  });
} else {
  await buildServer().connect(new StdioServerTransport());
}
