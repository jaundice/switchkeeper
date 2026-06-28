// MIB loader: read standard + vendor MIB files and resolve symbol -> OID.
//
// Built on net-snmp's ModuleStore (already a dependency). Switchkeeper ships only
// the standard, freely-redistributable IETF/IEEE MIBs as a resolution base and lets
// users IMPORT their device's vendor MIBs; we never bundle vendor files.
//
// Why this is non-trivial: net-snmp's store ships only ~9 base modules (it lacks
// IF-MIB / BRIDGE-MIB / Q-BRIDGE-MIB / etc. that nearly every vendor MIB imports),
// and loadFromFile silently skips any module whose IMPORTS are unresolved (it just
// logs "Can not find X"). So a naive directory load registers almost nothing. The
// fix is a moduleName->file index plus a TOPOLOGICAL load that pulls each module's
// import closure first. Validated against a 7,900-file real-world archive.
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import snmp from "net-snmp";

export interface MibObject {
  name: string;
  oid: string;
  module: string;
  scalarType?: number;
  maxAccess?: number;
}

// "<NAME> DEFINITIONS ::= BEGIN" (the module declaration).
const DEF_RE = /^\s*([A-Za-z0-9][A-Za-z0-9-]*)\s+DEFINITIONS\b[\s\S]*?::=\s*BEGIN/m;

function moduleNameOf(text: string): string | null {
  const m = text.match(DEF_RE);
  return m ? m[1] : null;
}

// Module names referenced by this module's IMPORTS section (the "FROM <MOD>" parts).
function importsOf(text: string): string[] {
  const s = text.indexOf("IMPORTS");
  if (s < 0) return [];
  const e = text.indexOf(";", s);
  const blk = text.slice(s, e < 0 ? undefined : e);
  const mods = new Set<string>();
  const re = /FROM\s+([A-Za-z0-9][A-Za-z0-9-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(blk))) mods.add(m[1]);
  return [...mods];
}

// net-snmp's parser is chatty (console.log/warn/error) on unresolved imports.
// Run loads with that output suppressed.
function quiet<T>(fn: () => T): T {
  const o = { log: console.log, warn: console.warn, error: console.error };
  const noop = () => {};
  console.log = noop;
  console.warn = noop;
  console.error = noop;
  try {
    return fn();
  } finally {
    console.log = o.log;
    console.warn = o.warn;
    console.error = o.error;
  }
}

// A few real-world MIBs crash net-snmp's ModuleStore parser in a way that POISONS the whole
// store, so every subsequent load fails. We skip loading them: any module that imports one of
// these still loads (just with those few symbols unresolved). Discovered empirically against a
// large vendor archive (RMON2 / token-ring RMON / the LLDP-EXT family).
const CORRUPTORS = new Set<string>(["RMON2-MIB", "TOKEN-RING-RMON-MIB"]);
function isCorruptor(name: string): boolean {
  return CORRUPTORS.has(name) || name.startsWith("LLDP-EXT-");
}

// Beyond the static list above, vendor archives ship many MIBs that net-snmp's parser can't
// handle (Extreme's are a notorious example); some of these don't just fail to parse, they
// corrupt the store so EVERY later load fails. We detect them empirically with a "canary": a
// trivial MIB that must register in a healthy store. After a candidate is loaded into a
// throwaway store, if the canary no longer registers, that candidate poisoned the parser.
const CANARY_FILE = join(tmpdir(), "switchkeeper-canary.mib");
const CANARY_TEXT =
  "SKCANARY-MIB DEFINITIONS ::= BEGIN\nIMPORTS OBJECT-TYPE, enterprises, Integer32 FROM SNMPv2-SMI;\n" +
  "skCanary OBJECT-TYPE SYNTAX Integer32 MAX-ACCESS read-only STATUS current DESCRIPTION \"c\" ::= { enterprises 99998 }\nEND\n";
let canaryWritten = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function canaryHealthy(probe: any): boolean {
  if (!canaryWritten) {
    try { writeFileSync(CANARY_FILE, CANARY_TEXT); } catch { /* */ }
    canaryWritten = true;
  }
  return quiet(() => {
    try {
      probe.loadFromFile(CANARY_FILE);
      const p = probe.getProvidersForModule("SKCANARY-MIB");
      return !!(p && p.length);
    } catch {
      return false;
    }
  });
}

export interface MibStore {
  /** Recursively index a directory of MIB files (moduleName -> file). Returns count indexed. */
  indexDir(dir: string): number;
  /** Index + load a single MIB file (and its import closure). Returns the module name or null. */
  loadFile(file: string): string | null;
  /** Load every MIB in a directory, auto-skipping files that poison the parser. */
  loadDir(dir: string): { loaded: number; skipped: string[] };
  /** Fast path: populate from the dir's saved cache if it still matches; true if loaded, else false. */
  loadDirFromCache(dir: string): boolean;
  /** Load a module by name (resolving its IMPORTS closure from the index first). */
  loadModule(name: string): boolean;
  /** All objects (name/oid) defined by a loaded module. */
  providers(moduleName: string): MibObject[];
  /** Resolve a single symbol (e.g. "ifName", "rlCopyRowStatus") to its OID across loaded modules. */
  findOid(symbol: string): MibObject | null;
  /** Module names that successfully registered. */
  loadedModules(): string[];
  /** Module names known from indexing (loaded or not). */
  indexedModules(): string[];
}

export function createMibStore(): MibStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let store: any = snmp.createModuleStore();
  let baseNames = new Set<string>(store.getModuleNames(true));
  const index = new Map<string, string>(); // moduleName -> filepath
  let registered = new Set<string>(); // modules that actually parsed/registered
  let seen = new Set<string>(); // attempted (incl. unknown imports)
  let inprog = new Set<string>(); // cycle guard
  let symCache = new Map<string, MibObject>(); // symbol -> object (first definition wins)
  let symDirty = true; // symCache needs (re)building
  // The distilled result of parsing: module -> its objects. This is ALL the engine needs at
  // runtime, and unlike net-snmp's ModuleStore (which has no serialize/clone API) it's plain data
  // we can persist. A loadDir warm-load rebuilds this from a JSON cache and skips parsing entirely.
  let resolved = new Map<string, MibObject[]>();
  let indexedNames: string[] | null = null; // set on a warm (cache) load, where we don't index files
  const dynamicBad = new Set<string>(); // modules found to poison net-snmp's parser

  // A poison can't be undone once loaded, so when one is found mid-scan we discard the store and
  // rebuild from scratch (the index survives; good modules get reloaded). dynamicBad persists.
  function resetStore() {
    store = snmp.createModuleStore();
    baseNames = new Set<string>(store.getModuleNames(true));
    registered = new Set<string>();
    seen = new Set<string>();
    inprog = new Set<string>();
    symCache = new Map<string, MibObject>();
    symDirty = true;
  }

  function indexFile(file: string): string | null {
    let text: string;
    try {
      text = readFileSync(file, "latin1");
    } catch {
      return null;
    }
    const name = moduleNameOf(text);
    if (!name) return null;
    if (!index.has(name)) index.set(name, file);
    return name;
  }

  function indexDir(dir: string): number {
    let n = 0;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop() as string;
      let entries;
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (indexFile(p)) n++;
      }
    }
    return n;
  }

  // Pull providers for any newly-registered modules into `resolved` (the distilled, cacheable map).
  // getProvidersForModule is O(store size), so we do this in one batch after loading rather than
  // per-module mid-load (which was quadratic). On a warm load `resolved` is already filled from disk.
  function syncResolved() {
    for (const m of registered) if (!resolved.has(m)) resolved.set(m, providersLive(m));
  }

  // Build the symbol -> OID lookup from `resolved`. Lazy (on first findOid after a load).
  function buildSymCache() {
    syncResolved();
    symCache = new Map<string, MibObject>();
    for (const list of resolved.values()) for (const p of list) if (!symCache.has(p.name)) symCache.set(p.name, p);
    symDirty = false;
  }

  function loadModule(name: string): boolean {
    if (baseNames.has(name) || registered.has(name)) return true;
    if (isCorruptor(name) || dynamicBad.has(name)) { seen.add(name); return false; } // skip: poisons the store
    if (inprog.has(name)) return false; // cycle: dependency still loading
    const file = index.get(name);
    if (!file) {
      seen.add(name);
      return false; // import not in our search path; net-snmp will note it's missing
    }
    inprog.add(name);
    let text = "";
    try {
      text = readFileSync(file, "latin1");
    } catch {
      /* ignore */
    }
    for (const dep of importsOf(text)) loadModule(dep);
    let ok = false;
    quiet(() => {
      try {
        store.loadFromFile(file);
        ok = true;
      } catch {
        ok = false;
      }
    });
    inprog.delete(name);
    seen.add(name);
    if (ok) {
      registered.add(name);
      symDirty = true; // defer the (expensive) provider scan until findOid is actually called
    }
    return ok;
  }

  function loadFile(file: string): string | null {
    const name = indexFile(file);
    if (!name) return null;
    loadModule(name);
    syncResolved(); // keep the distilled map in step with single-file imports
    symDirty = true;
    return name;
  }

  // In-index import dependencies of a module (cached; reads each file once).
  const depCache = new Map<string, string[]>();
  function depsOf(name: string): string[] {
    let d = depCache.get(name);
    if (d) return d;
    const f = index.get(name);
    let t = "";
    if (f) { try { t = readFileSync(f, "latin1"); } catch { /* */ } }
    d = importsOf(t).filter((x) => index.has(x) && x !== name);
    depCache.set(name, d);
    return d;
  }

  // True topological order: every module's dependencies come strictly before it (post-order DFS,
  // cycle-safe). Critical for poison discovery -- if deps don't precede a module, it loads with
  // unresolved imports and net-snmp may flag IT as the poison, which then quarantines a dependency
  // and cascades false positives through everything that imports it (and balloons the build time).
  function topoOrder(names: string[]): string[] {
    const out: string[] = [];
    const done = new Set<string>();
    const onstack = new Set<string>();
    const visit = (n: string) => {
      if (done.has(n) || !index.has(n)) return;
      if (onstack.has(n)) return; // import cycle: break it
      onstack.add(n);
      for (const d of depsOf(n)) visit(d);
      onstack.delete(n);
      done.add(n);
      out.push(n); // deps already pushed -> n comes after them
    };
    for (const n of names) visit(n);
    return out;
  }

  // A cheap fingerprint of a directory's MIB files (name+size+mtime, stat only -- no reads). If it
  // matches a saved cache, the parse result is reused verbatim.
  function dirSignature(dir: string): string {
    let files: string[] = [];
    try { files = readdirSync(dir).filter((f) => !f.startsWith(".")).sort(); } catch { return ""; }
    return files
      .map((f) => {
        try { const s = statSync(join(dir, f)); return `${f}:${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return `${f}:?`; }
      })
      .join("|");
  }

  // Load good modules ordered[from..to) into a THROWAWAY store (no recursion: `ordered` is
  // dependency-first, so a module's deps already precede it). Quiet; errors ignored.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function probeLoadRange(probe: any, base: Set<string>, ordered: string[], from: number, to: number, bad: Set<string>) {
    quiet(() => {
      for (let i = from; i < to; i++) {
        const n = ordered[i];
        if (bad.has(n) || base.has(n)) continue;
        const file = index.get(n);
        if (!file) continue;
        try { probe.loadFromFile(file); } catch { /* */ }
      }
    });
  }

  // Discover every module that poisons net-snmp's parser, adding them to `bad`. Done in throwaway
  // stores with a windowed linear scan that resumes after each culprit, so total work is only a
  // few full passes regardless of how many poisons there are -- crucial because parsing a large
  // vendor set (e.g. Extreme, whose EXTREME-BASE-MIB alone is ~150 KB and a dependency of every
  // other module) is expensive, so re-parsing the whole set per-probe (binary search) is far too
  // slow on modest hardware. WINDOW keeps the canary-check count bounded. `onFound` is called as
  // each culprit is identified so the caller can persist progress (making the scan resumable).
  function discoverPoisons(ordered: string[], bad: Set<string>, onFound?: (name: string) => void) {
    const WINDOW = 24;
    const len = ordered.length;
    let start = 0;
    for (let guard = 0; guard < len + 4 && start < len; guard++) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const probe: any = snmp.createModuleStore();
      const base = new Set<string>(probe.getModuleNames(true));
      probeLoadRange(probe, base, ordered, 0, start, bad); // good prefix (already cleared)
      let found = -1;
      for (let j = start; j < len && found < 0; j = Math.min(j + WINDOW, len)) {
        const end = Math.min(j + WINDOW, len);
        probeLoadRange(probe, base, ordered, j, end, bad);
        if (!canaryHealthy(probe)) {
          // poison is in [j,end): pinpoint it one module at a time from a fresh prefix
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fine: any = snmp.createModuleStore();
          const fbase = new Set<string>(fine.getModuleNames(true));
          probeLoadRange(fine, fbase, ordered, 0, j, bad);
          for (let k = j; k < end; k++) {
            const n = ordered[k];
            if (bad.has(n) || fbase.has(n)) continue;
            const file = index.get(n);
            if (!file) continue;
            quiet(() => { try { fine.loadFromFile(file); } catch { /* */ } });
            if (!canaryHealthy(fine)) { found = k; break; }
          }
          if (found < 0) found = end - 1; // safety: blame the last in the window
        }
        if (end >= len) break;
      }
      if (found < 0) break; // clean from `start` to the end
      bad.add(ordered[found]);
      dynamicBad.add(ordered[found]);
      if (onFound) onFound(ordered[found]); // persist progress -> resumable across restarts
      start = found; // resume right after the (now quarantined) culprit
    }
  }

  // Fast path only: if the dir's saved cache still matches the files, rebuild the distilled map
  // from JSON (no net-snmp parsing) and return true. Returns false if there's no valid cache, in
  // which case the caller must run the (slow, one-time) cold build via loadDir. This lets a server
  // keep parsing off its request path: serve from cache instantly, build in the background.
  function loadDirFromCache(dir: string): boolean {
    try {
      const c = JSON.parse(readFileSync(join(dir, ".switchkeeper-cache.json"), "utf8"));
      if (c && c.sig && c.sig === dirSignature(dir) && c.modules) {
        resolved = new Map(Object.entries(c.modules) as [string, MibObject[]][]);
        indexedNames = Array.isArray(c.indexed) ? c.indexed : [...resolved.keys()];
        for (const n of c.skipped || []) dynamicBad.add(n);
        symDirty = true;
        return true;
      }
    } catch { /* no/stale cache */ }
    return false;
  }

  // Load every MIB in a directory, robust to files that poison net-snmp's parser. Some vendor
  // MIBs (Extreme's are notorious) crash the parser so badly that EVERY later load fails -- one
  // bad file would otherwise register zero modules. Strategy: load all the good ones, then check
  // a canary. If the store is healthy (the common case: clean sets, or a cached quarantine list)
  // we're done. Otherwise a poison slipped in: discover the culprit(s) in throwaway stores, then
  // rebuild the real store without them.
  //
  // Two on-disk caches in the dir make repeat loads cheap (parsing a big vendor set is the slow
  // part, and net-snmp can't serialize its parsed store): ".switchkeeper-skip" remembers the
  // quarantined modules, and ".switchkeeper-cache.json" stores the distilled module->objects map
  // plus a signature of the files. If the signature still matches, we rebuild everything from the
  // JSON and skip net-snmp parsing entirely -- a restart goes from minutes to milliseconds.
  function loadDir(dir: string): { loaded: number; skipped: string[] } {
    const sig = dirSignature(dir);
    const cacheFile = join(dir, ".switchkeeper-cache.json");
    const skipFile = join(dir, ".switchkeeper-skip");
    if (loadDirFromCache(dir)) return { loaded: resolved.size, skipped: [...dynamicBad] };

    let files: string[] = [];
    try { files = readdirSync(dir); } catch { return { loaded: 0, skipped: [] }; }
    const skipped: string[] = [];
    const names: string[] = [];
    for (const f of files) {
      if (f.startsWith(".")) continue; // our sidecar / dotfiles
      const name = indexFile(join(dir, f));
      if (name) names.push(name); else skipped.push(f); // non-MIB files are skipped
    }
    // Seed quarantine from a prior (possibly interrupted) run so discovery resumes, not restarts.
    const bad = new Set<string>();
    try {
      for (const line of readFileSync(skipFile, "utf8").split("\n")) {
        const s = line.trim();
        if (s) bad.add(s);
      }
    } catch { /* no prior run */ }
    for (const n of bad) dynamicBad.add(n);
    const persistSkip = () => { try { writeFileSync(skipFile, [...bad].join("\n") + "\n", "utf8"); } catch { /* */ } };

    const ordered = topoOrder(names);
    const loadGood = () => { for (const n of ordered) if (!bad.has(n)) loadModule(n); };

    loadGood();
    if (!canaryHealthy(store)) {
      discoverPoisons(ordered, bad, persistSkip); // find culprits; persist each so a restart resumes
      resetStore(); // the first attempt left the real store corrupted; rebuild it clean
      loadGood();
    }

    // Distill the parse result and persist both caches so the next load skips parsing entirely.
    resolved = new Map();
    syncResolved();
    indexedNames = [...index.keys()];
    symDirty = true;
    const quarantined = [...skipped, ...bad];
    persistSkip();
    try {
      writeFileSync(cacheFile, JSON.stringify({ sig, indexed: indexedNames, skipped: quarantined, modules: Object.fromEntries(resolved) }));
    } catch { /* */ }
    return { loaded: resolved.size, skipped: quarantined };
  }

  // Extract a module's objects from the LIVE net-snmp store (used during a cold parse).
  function providersLive(moduleName: string): MibObject[] {
    let raw: Array<{ name: string; oid?: string; scalarType?: number; maxAccess?: number }> = [];
    try {
      raw = quiet(() => store.getProvidersForModule(moduleName)) || [];
    } catch {
      raw = [];
    }
    return raw
      .filter((p) => p && p.oid)
      .map((p) => ({
        name: p.name,
        oid: p.oid as string,
        module: moduleName,
        scalarType: p.scalarType,
        maxAccess: p.maxAccess,
      }));
  }

  return {
    indexDir,
    loadFile,
    loadDir,
    loadDirFromCache,
    loadModule,
    // Serve from the distilled map (covers warm/cache loads); fall back to the live store.
    providers: (m: string) => resolved.get(m) ?? providersLive(m),
    findOid: (symbol: string) => { if (symDirty) buildSymCache(); return symCache.get(symbol) || null; },
    loadedModules: () => [...new Set<string>([...resolved.keys(), ...registered])],
    indexedModules: () => indexedNames ?? [...index.keys()],
  };
}
