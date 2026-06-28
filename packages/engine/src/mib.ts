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
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
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

  function cacheProviders(moduleName: string) {
    for (const p of providers(moduleName)) if (!symCache.has(p.name)) symCache.set(p.name, p);
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
      cacheProviders(name);
    }
    return ok;
  }

  function loadFile(file: string): string | null {
    const name = indexFile(file);
    if (!name) return null;
    loadModule(name);
    return name;
  }

  // Order modules so dependencies sort before the modules that import them. This keeps poison
  // attribution clean (a poisonous dependency is judged before the modules that pull it in).
  function depthOrder(names: string[]): string[] {
    const score = (n: string) => {
      const f = index.get(n);
      if (!f) return 0;
      let t = "";
      try { t = readFileSync(f, "latin1"); } catch { /* */ }
      return importsOf(t).filter((d) => index.has(d)).length;
    };
    return [...names].sort((a, b) => score(a) - score(b));
  }

  // Load a prefix ordered[0..end) into a THROWAWAY store (skipping known-bad) and report whether
  // the parser is still healthy. Because `ordered` is dependency-first, a prefix already contains
  // each module's deps, so a poison shows up exactly at its own index -- no recursive closure
  // loading needed. Keeps the real store untouched while we hunt.
  function prefixHealthy(ordered: string[], end: number, bad: Set<string>): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const probe: any = snmp.createModuleStore();
    const pbase = new Set<string>(probe.getModuleNames(true));
    quiet(() => {
      for (let i = 0; i < end; i++) {
        const n = ordered[i];
        if (bad.has(n) || pbase.has(n)) continue;
        const file = index.get(n);
        if (!file) continue;
        try { probe.loadFromFile(file); } catch { /* */ }
      }
    });
    return canaryHealthy(probe);
  }

  // Find the first module (in dependency order) that poisons the parser, via binary search on the
  // prefix length: ~log2(n) probes instead of n. Returns null if the whole good set is healthy.
  function findFirstPoison(ordered: string[], bad: Set<string>): string | null {
    const len = ordered.length;
    if (prefixHealthy(ordered, len, bad)) return null;
    let lo = 1, hi = len, ans = len;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (!prefixHealthy(ordered, mid, bad)) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ordered[ans - 1];
  }

  // Load every MIB in a directory, robust to files that poison net-snmp's parser. Some vendor
  // MIBs (Extreme's are notorious) crash the parser so badly that EVERY later load fails -- one
  // bad file would otherwise register zero modules. Strategy: load all the good ones, then check
  // a canary. If the store is healthy (the common case: clean sets, or a cached quarantine list)
  // we're done. Otherwise a poison slipped in: we binary-search the dependency-ordered list to
  // pin culprits one at a time (cheap, ~log n probes each), then rebuild the store without them.
  // The quarantine set is cached as ".switchkeeper-skip" in the dir so later loads (and restarts)
  // skip straight to a healthy store with no probing.
  function loadDir(dir: string): { loaded: number; skipped: string[] } {
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { return { loaded: 0, skipped: [] }; }
    const skipped: string[] = [];
    const names: string[] = [];
    for (const f of files) {
      if (f.startsWith(".")) continue; // our sidecar / dotfiles
      const name = indexFile(join(dir, f));
      if (name) names.push(name); else skipped.push(f); // non-MIB files are skipped
    }
    const skipFile = join(dir, ".switchkeeper-skip");
    const bad = new Set<string>();
    try {
      for (const line of readFileSync(skipFile, "utf8").split("\n")) {
        const s = line.trim();
        if (s) bad.add(s);
      }
    } catch { /* no cache yet */ }
    for (const n of bad) dynamicBad.add(n);

    const ordered = depthOrder(names);
    const startBad = bad.size;
    const loadGood = () => { for (const n of ordered) if (!bad.has(n)) loadModule(n); };

    loadGood();
    if (!canaryHealthy(store)) {
      // Discover all poisons in throwaway stores first (no repeated rebuilds of the real store).
      for (let guard = 0; guard < 200; guard++) {
        const p = findFirstPoison(ordered, bad);
        if (!p) break;
        bad.add(p);
        dynamicBad.add(p);
      }
      resetStore(); // the first attempt left the store corrupted; rebuild it clean
      loadGood();
    }

    if (bad.size !== startBad) {
      try { writeFileSync(skipFile, [...bad].join("\n") + "\n", "utf8"); } catch { /* */ }
    }
    return { loaded: registered.size, skipped: [...skipped, ...bad] };
  }

  function providers(moduleName: string): MibObject[] {
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
    loadModule,
    providers,
    findOid: (symbol: string) => symCache.get(symbol) || null,
    loadedModules: () => [...registered],
    indexedModules: () => [...index.keys()],
  };
}
