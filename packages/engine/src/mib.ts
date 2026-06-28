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
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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

export interface MibStore {
  /** Recursively index a directory of MIB files (moduleName -> file). Returns count indexed. */
  indexDir(dir: string): number;
  /** Index + load a single MIB file (and its import closure). Returns the module name or null. */
  loadFile(file: string): string | null;
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
  const store: any = snmp.createModuleStore();
  const baseNames = new Set<string>(store.getModuleNames(true));
  const index = new Map<string, string>(); // moduleName -> filepath
  const registered = new Set<string>(); // modules that actually parsed/registered
  const seen = new Set<string>(); // attempted (incl. unknown imports)
  const inprog = new Set<string>(); // cycle guard
  const symCache = new Map<string, MibObject>(); // symbol -> object (first definition wins)

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
    if (isCorruptor(name)) { seen.add(name); return false; } // skip: would poison the store
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
    loadModule,
    providers,
    findOid: (symbol: string) => symCache.get(symbol) || null,
    loadedModules: () => [...registered],
    indexedModules: () => [...index.keys()],
  };
}
