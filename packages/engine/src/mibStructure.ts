// Phase 4: enumerate ALL objects a module defines (incl. table COLUMNS) and decode an instance OID
// back to the port/VLAN its row represents.
//
// Why this is needed: net-snmp's ModuleStore (mib.ts providers()) exposes scalars and table ENTRY
// rows, but NOT the individual columns of a table — yet the columns are exactly the per-port /
// per-row settings Phase 4 surfaces and (for read-write ones) lets the user edit. The columns are
// in the MIB text though, as OBJECT-TYPE blocks whose `::= { <entry> N }` hangs them off the entry.
// So we re-parse the module's source text (which the store already indexed), resolve every object's
// OID from its `::= { parent N }` chain seeded by the providers we DO have, and classify each as a
// scalar / table / row / column. buildRowDecoder then uses a table's INDEX clause to map a cell's
// instance suffix to a port (ifIndex) or VLAN — the SafetyEngine needs this to protect the mgmt path.
//
// Scope is deliberately bounded and conservative (default-to-safe): we resolve OIDs only from the
// `::= { parent N }` chain within the module (+ provider OIDs as seeds), and decode only the two
// index shapes we can be confident about (single ifIndex, vlan-first). Anything we can't pin down,
// the decoder returns null for — which the SafetyEngine treats as risky, never safe.
import type { MibStore, MibObject } from "./mib.ts";
import type { ObjectAccess, MibBaseType, DeviceState } from "./model.ts";
import { describeObject } from "./mibSyntax.ts";
import { accessFromMaxAccess } from "./objectResolver.ts";

export interface ModuleObject {
  name: string;
  oid: string;
  access: ObjectAccess;
  base: MibBaseType;
  kind: "scalar" | "table" | "row" | "column";
  table?: string; // for columns: the owning table/entry (row) symbol
}

// SNMPv2-SMI MAX-ACCESS keyword -> the numeric code accessFromMaxAccess understands (mirror of
// mibSyntax.ts; kept local so the two modules don't couple through a private export).
const MAX_ACCESS_CODE: Record<string, number> = {
  "not-accessible": 0,
  "accessible-for-notify": 1,
  "read-only": 2,
  "read-write": 3,
  "read-create": 4,
};

interface RawObject {
  name: string;
  parent: string; // symbol or numeric token from `::= { parent N }`
  sub: number; // the N in `::= { parent N }`
  syntax: string; // raw SYNTAX expression (for kind + base)
  access?: string; // raw MAX-ACCESS keyword
  hasIndex: boolean; // has an INDEX or AUGMENTS clause -> it's a table entry (row)
}

/**
 * Enumerate every OBJECT-TYPE the module defines, including table columns. Returns objects with
 * resolved numeric OIDs and a kind. Empty if the module text isn't available (e.g. a net-snmp base
 * module with no indexed file).
 */
// Parsing a module's source (regex every OBJECT-TYPE + resolve the OID chain) is CPU-heavy and a
// loaded store is immutable, so memoize per store+module. Without this, a capability read that
// enumerates many vendor modules re-parses them on every request and blocks the event loop.
const enumCache = new WeakMap<MibStore, Map<string, ModuleObject[]>>();

export function enumerateModule(mib: MibStore, module: string): ModuleObject[] {
  let perStore = enumCache.get(mib);
  if (!perStore) { perStore = new Map(); enumCache.set(mib, perStore); }
  const hit = perStore.get(module);
  if (hit) return hit;
  const result = enumerateModuleUncached(mib, module);
  perStore.set(module, result);
  return result;
}

function enumerateModuleUncached(mib: MibStore, module: string): ModuleObject[] {
  const text = mib.moduleText(module);
  if (!text) return [];

  // 1. Parse every OBJECT-TYPE block: name, its `::= { parent N }`, SYNTAX, MAX-ACCESS, INDEX.
  const raws = parseObjectTypes(text);
  if (!raws.length) return [];
  const rawByName = new Map<string, RawObject>(raws.map((r) => [r.name, r]));

  // 2. Seed known OIDs from the providers (scalars + entries are providers) AND from any symbol the
  //    store can resolve (findOid) — these anchor the `::= { parent N }` chain so module-local OBJECT
  //    IDENTITY/group nodes that aren't OBJECT-TYPEs still resolve as parents.
  const oidByName = new Map<string, string>();
  for (const p of mib.providers(module)) oidByName.set(p.name, p.oid);

  // 3. Resolve each object's OID by walking `::= { parent N }` up to a seeded ancestor. Iterate to a
  //    fixpoint since parents may themselves be unresolved columns/rows defined later in the file.
  resolveOids(raws, oidByName, mib);

  // 4. Classify + emit. A SEQUENCE OF is the table; an entry with INDEX/AUGMENTS is the row; an
  //    object whose parent is a row is a column; everything else is a scalar.
  const rowNames = new Set(raws.filter((r) => r.hasIndex).map((r) => r.name));
  const out: ModuleObject[] = [];
  for (const r of raws) {
    const oid = oidByName.get(r.name);
    if (!oid) continue; // couldn't resolve its OID -> can't surface it safely
    const kind = classify(r, rowNames, rawByName);
    out.push({
      name: r.name,
      oid,
      access: r.access ? accessFromMaxAccess(MAX_ACCESS_CODE[r.access]) : "unknown",
      base: baseOf(mib, module, r),
      kind,
      table: kind === "column" ? r.parent : undefined,
    });
  }
  return out;
}

/** Resolve `base` for an object: reuse describeObject (it parses SYNTAX/TC) when we can, else map the
 *  raw SYNTAX head. describeObject needs the object resolvable via sourceFor, which it is for real
 *  stores; fall back to a cheap SYNTAX-head map so enumeration still labels columns sensibly. */
function baseOf(mib: MibStore, _module: string, r: RawObject): MibBaseType {
  const desc = describeObject(mib, r.name);
  if (desc) return desc.base;
  return baseFromSyntaxHead(r.syntax);
}

/** Cheap fallback: map the leading token of a SYNTAX expression to a MibBaseType. */
function baseFromSyntaxHead(syntax: string): MibBaseType {
  const s = syntax.replace(/\s+/g, " ").trim();
  if (/^(INTEGER|Integer32)\s*\{/.test(s)) return "enum";
  if (/^(INTEGER|Integer32)\b/.test(s)) return "integer";
  if (/^(Unsigned32|Gauge32|Gauge)\b/.test(s)) return "unsigned";
  if (/^(Counter32|Counter64|Counter)\b/.test(s)) return "counter";
  if (/^TimeTicks\b/.test(s)) return "timeticks";
  if (/^IpAddress\b/.test(s)) return "ipaddress";
  if (/^OBJECT\s+IDENTIFIER\b/.test(s)) return "oid";
  if (/^BITS\b/.test(s)) return "bits";
  if (/^OCTET\s+STRING\b/.test(s)) return "string";
  if (/^TruthValue\b/.test(s)) return "boolean";
  return "unknown";
}

function classify(
  r: RawObject,
  rowNames: Set<string>,
  rawByName: Map<string, RawObject>,
): ModuleObject["kind"] {
  if (/^\s*SEQUENCE\s+OF\b/.test(r.syntax)) return "table"; // SYNTAX SEQUENCE OF FooEntry
  if (r.hasIndex) return "row"; // an INDEX/AUGMENTS clause makes this the conceptual-row entry
  // A column hangs directly off a row (entry). Some MIBs nest a column under a column-of-column
  // (rare), so we only treat the immediate-parent-is-a-row case as a column.
  if (rowNames.has(r.parent)) return "column";
  // If the parent is itself only known as a column we still treat this as a column of that table's
  // owning row — but to stay conservative we just call it scalar unless the parent is a row.
  if (rawByName.has(r.parent) && rawByName.get(r.parent)!.hasIndex) return "column";
  return "scalar";
}

// ---------------------------------------------------------------------------
// OBJECT-TYPE parsing
// ---------------------------------------------------------------------------

// Match: "<name> OBJECT-TYPE … ::= { <parent> <N> }". We capture the whole body between OBJECT-TYPE
// and the OID assignment so we can pull SYNTAX/MAX-ACCESS/INDEX out of it.
//
// WHY the body excludes "OBJECT-TYPE": a non-greedy `[\s\S]*?` would otherwise let an IMPORTS line
// like "IMPORTS OBJECT-TYPE, … FROM …;" (where OBJECT-TYPE is a clause keyword, not a definition)
// swallow the text up to the FIRST real `::= { parent N }`, capturing "IMPORTS" as a bogus object
// and skipping the genuine first definition. Forbidding a second "OBJECT-TYPE" in the body bounds
// each match to a single definition, and we also reject the IMPORTS/keyword pseudo-name below.
const OBJECT_TYPE_RE = /([A-Za-z][A-Za-z0-9-]*)\s+OBJECT-TYPE\b((?:(?!OBJECT-TYPE)[\s\S])*?)::=\s*\{\s*([A-Za-z0-9][A-Za-z0-9-]*)\s+(\d+)\s*\}/g;

// Tokens that are never object names (they appear as `<KW> OBJECT-TYPE` only inside an IMPORTS list).
const NOT_A_NAME = new Set<string>(["IMPORTS", "FROM"]);

function parseObjectTypes(text: string): RawObject[] {
  const out: RawObject[] = [];
  let m: RegExpExecArray | null;
  OBJECT_TYPE_RE.lastIndex = 0;
  while ((m = OBJECT_TYPE_RE.exec(text))) {
    const [, name, body, parent, subStr] = m;
    if (NOT_A_NAME.has(name)) continue; // IMPORTS/FROM are clause keywords, not definitions
    out.push({
      name,
      parent,
      sub: Number(subStr),
      syntax: clauseValue(body, "SYNTAX") ?? "",
      access: (clauseValue(body, "MAX-ACCESS") ?? clauseValue(body, "ACCESS") ?? "").trim() || undefined,
      // INDEX or AUGMENTS present -> this OBJECT-TYPE is a conceptual-row entry (a "row").
      hasIndex: /\bINDEX\b/.test(body) || /\bAUGMENTS\b/.test(body),
    });
  }
  return out;
}

// Clause keywords that begin the next clause (used to bound a clause's value). Mirrors mibSyntax.ts.
const CLAUSE_KEYWORDS = [
  "SYNTAX", "UNITS", "MAX-ACCESS", "ACCESS", "STATUS", "DESCRIPTION",
  "REFERENCE", "INDEX", "AUGMENTS", "DEFVAL", "PIB-REFERENCES", "PIB-TAG",
];

/** Value of a clause keyword within an OBJECT-TYPE body (the text up to the next clause keyword). */
function clauseValue(body: string, keyword: string): string | null {
  const re = new RegExp(`\\b${escapeRe(keyword)}\\b`);
  const km = re.exec(body);
  if (!km) return null;
  const from = km.index + km[0].length;
  const rest = body.slice(from);
  // Quoted clause (DESCRIPTION/REFERENCE/UNITS): take the whole "...".
  const q = rest.match(/^\s*"([\s\S]*?)"/);
  if (q) return q[1];
  let end = rest.length;
  for (const kw of CLAUSE_KEYWORDS) {
    if (kw === keyword) continue;
    const m2 = new RegExp(`\\b${escapeRe(kw)}\\b`).exec(rest);
    if (m2 && m2.index < end) end = m2.index;
  }
  return rest.slice(0, end).trim();
}

// ---------------------------------------------------------------------------
// OID resolution from the `::= { parent N }` chain
// ---------------------------------------------------------------------------

/** Resolve every object's numeric OID by composing parentOid + "." + sub, iterating to a fixpoint so
 *  forward references (a column whose parent row is defined later) still resolve. Seeds come from the
 *  providers (oidByName) and from findOid for any unseeded parent symbol the store knows. */
function resolveOids(raws: RawObject[], oidByName: Map<string, string>, mib: MibStore): void {
  // The parent token may be a symbol the store can resolve directly (e.g. an OBJECT IDENTITY group
  // node that isn't an OBJECT-TYPE). Seed those once up front.
  for (const r of raws) {
    if (!oidByName.has(r.parent)) {
      const hit = mib.findOid(r.parent);
      if (hit) oidByName.set(r.parent, hit.oid);
    }
  }
  // Fixpoint: at most raws.length passes is enough for the deepest chain.
  for (let pass = 0; pass < raws.length + 1; pass++) {
    let progressed = false;
    for (const r of raws) {
      if (oidByName.has(r.name)) continue;
      const parentOid = oidByName.get(r.parent);
      if (parentOid) {
        oidByName.set(r.name, parentOid + "." + r.sub);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// buildRowDecoder — instance OID -> { port?, vlan? } | null
// ---------------------------------------------------------------------------

// INDEX element names whose FIRST element identifies a VLAN. Matched case-insensitively as a
// substring so vendor variants (dot1qVlanIndex, dot1qFdbId-as-vlan, *VlanIndex, *VlanId) are caught.
// Conservative: only the LEADING index element is consulted, and only for these well-known shapes.
const VLAN_INDEX_HINTS = ["vlanindex", "vlanid", "dot1qvlan", "dot1qfdbid"];
// INDEX element names that identify an interface (ifIndex). The standard ifIndex, plus the common
// IF-MIB augmentation pattern. Again matched as a substring, leading element only.
const IFINDEX_HINTS = ["ifindex"];
// INDEX element names that identify a bridge port (dot1dBasePort and the common vendor variants).
// A bridge-port index maps DIRECTLY to a Port.bridgePort, so no ifIndex->port translation is needed.
// Conservative substring match, leading element only. We require the hint to END in "port" so a
// column merely *named* with "port" inside (e.g. "portSpeed") never counts — only true *...Port index
// element names. dot1dBasePort / dot1dStpPort / *BridgePort / a bare "port" all qualify.
const BRIDGEPORT_INDEX_HINTS = ["dot1dbaseport", "dot1dstpport", "bridgeport", "baseport"];

interface TableShape {
  columnOid: string; // a column base OID under this table (longest match used to find the owner)
  indexNames: string[]; // the INDEX element symbols, in order
}

/**
 * Build a decoder mapping a full instance OID to the entity its row represents, using the owning
 * table's INDEX clause. Returns a closure so the (one-time) module enumeration is cached.
 *
 *  - single INDEX { ifIndex }                  -> { port }  (ifIndex mapped to a Port via state)
 *  - INDEX whose FIRST element is an ifIndex    -> { port }  even with trailing index parts (the
 *                                                  leading suffix integer is the ifIndex)
 *  - INDEX whose FIRST element is a bridge port -> { port }  (maps directly to Port.bridgePort)
 *  - INDEX whose FIRST element is a VLAN id     -> { vlan }  (the leading suffix integer)
 *  - anything else / unresolvable               -> null      (SafetyEngine treats null as risky)
 *
 * Conservative by design: when we can't confidently map a row we return null, never a guess. The
 * decoder only knows about the modules the passed-in store has loaded; with no vendor MIBs it still
 * decodes standard ifIndex/dot1q tables from the standard knowledge baked into the hints.
 */
export function buildRowDecoder(
  mib: MibStore,
  state: DeviceState,
): (instanceOid: string) => { port?: number; vlan?: number } | null {
  // Enumerate every loaded module's columns + rows once, building a list of (columnOid, indexNames)
  // so an instance OID can be matched to the LONGEST column-OID prefix (its owning column/table).
  const tables = collectTableShapes(mib);
  tables.sort((a, b) => b.columnOid.length - a.columnOid.length); // longest prefix first

  // ifIndex -> Port lookup (built once). The decoder maps a decoded ifIndex to the port number the
  // rest of the engine speaks (bridgePort where known — that's what the protected set uses — else
  // the ifIndex itself so an ifIndex-keyed protected set still matches).
  const portByIf = new Map<number, number>();
  for (const p of state.ports) {
    portByIf.set(p.ifIndex, p.bridgePort ?? p.ifIndex);
  }
  // The set of known bridge ports, so a bridge-port-indexed row can be confidently tied to a port
  // the protected set speaks (which is keyed by bridge port).
  const bridgePorts = new Set<number>();
  for (const p of state.ports) if (p.bridgePort !== undefined) bridgePorts.add(p.bridgePort);

  return (instanceOid: string) => {
    if (!/^[0-9]+(\.[0-9]+)*$/.test(instanceOid)) return null;
    // Find the owning column: the longest columnOid that is a strict prefix of the instance OID.
    for (const t of tables) {
      const prefix = t.columnOid + ".";
      if (!instanceOid.startsWith(prefix)) continue;
      const suffix = instanceOid.slice(prefix.length);
      return decodeSuffix(suffix, t.indexNames, portByIf, bridgePorts);
    }
    return null; // not under any table we enumerated -> undecodable
  };
}

/**
 * Decode an instance suffix against the table's INDEX names. Only the safely-decodable shapes; every
 * other shape returns null (which the SafetyEngine treats as risky, never safe).
 *
 * We consult ONLY the LEADING index element (the first suffix integer), because that is the only part
 * we can map without knowing each index element's encoded width — a downstream OCTET STRING or
 * variable-length index would make a trailing element ambiguous. So:
 *   - leading ifIndex      -> { port } (translated via state's ifIndex->port map; the raw ifIndex if
 *                             unknown, so an ifIndex-keyed protected set still matches)
 *   - leading bridge port  -> { port } only when that bridge port is one we actually read (otherwise
 *                             we can't be sure the index really is a bridge port -> null, stay risky)
 *   - leading VLAN id      -> { vlan }
 * A leading ifIndex/VLAN is accepted EVEN WITH trailing index parts (e.g. INDEX { ifIndex, x }), since
 * only the leading element is needed to identify the port/VLAN the row touches.
 */
function decodeSuffix(
  suffix: string,
  indexNames: string[],
  portByIf: Map<number, number>,
  bridgePorts: Set<number>,
): { port?: number; vlan?: number } | null {
  const parts = suffix.split(".").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;

  const first = (indexNames[0] ?? "").toLowerCase();
  const lead = parts[0];

  // Leading ifIndex -> a port. Single-element index keeps the original strict behaviour; a multi-part
  // index is fine too because only the leading ifIndex identifies the port.
  if (IFINDEX_HINTS.some((h) => first.includes(h))) {
    if (indexNames.length === 1 && parts.length !== 1) return null; // single index must be single suffix
    const port = portByIf.get(lead);
    // Map to a known port if we have one; if the ifIndex isn't in state we still know it's a port
    // index, but we can't tie it to a protected bridgePort — return the ifIndex itself so an
    // ifIndex-based protected set can still match. (Protected sets use bridge ports, so an unknown
    // ifIndex yields a port number that simply won't be in the set: unprotected -> risky, not safe.)
    return { port: port ?? lead };
  }

  // Leading bridge port (dot1dBasePort & friends) -> a port directly. Only confident when the leading
  // integer is a bridge port we actually read; otherwise the "*port" name could be coincidental, so we
  // stay conservative and return null (risky) rather than claim a mapping.
  if (BRIDGEPORT_INDEX_HINTS.some((h) => first.includes(h))) {
    if (bridgePorts.has(lead)) return { port: lead };
    return null;
  }

  // Leading VLAN id -> a VLAN. The leading suffix integer is the VLAN (trailing parts ignored).
  if (VLAN_INDEX_HINTS.some((h) => first.includes(h))) {
    return { vlan: lead };
  }

  // No recognised leading index name: too ambiguous to map safely.
  return null;
}

/** Enumerate all loaded modules and collect (columnOid, ownerIndexNames) for every column. */
function collectTableShapes(mib: MibStore): TableShape[] {
  const shapes: TableShape[] = [];
  for (const module of mib.loadedModules()) {
    const objs = enumerateModule(mib, module);
    if (!objs.length) continue;
    // Map row symbol -> its INDEX element names, parsed from the module text once.
    const indexByRow = parseRowIndexes(mib.moduleText(module) ?? "");
    for (const o of objs) {
      if (o.kind !== "column" || !o.table) continue;
      const indexNames = indexByRow.get(o.table);
      if (!indexNames || !indexNames.length) continue; // no decodable index -> skip (stay safe)
      shapes.push({ columnOid: o.oid, indexNames });
    }
  }
  return shapes;
}

/**
 * Public helper: the INDEX element names of a table's entry (row), in order, parsed from the
 * module text. Used by deviceCapabilities to attach a human `index` note (and by buildRowDecoder).
 * Returns [] when the entry has no parseable INDEX clause.
 */
export function rowIndexNames(mib: MibStore, module: string, entry: string): string[] {
  const map = parseRowIndexes(mib.moduleText(module) ?? "");
  return map.get(entry) ?? [];
}

/** Parse `<entry> OBJECT-TYPE … INDEX { a, b, c } …` -> Map(entry -> [a,b,c]). Bounded text scan. */
function parseRowIndexes(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // Reuse the OBJECT-TYPE matcher to land on each entry, then pull its INDEX clause.
  let m: RegExpExecArray | null;
  OBJECT_TYPE_RE.lastIndex = 0;
  while ((m = OBJECT_TYPE_RE.exec(text))) {
    const [, name, body] = m;
    const idx = clauseValue(body, "INDEX");
    if (!idx) continue;
    // INDEX { dot1qVlanIndex, ifIndex } -> ["dot1qVlanIndex", "ifIndex"]. Strip IMPLIED and braces.
    const inner = idx.replace(/[{}]/g, " ").replace(/\bIMPLIED\b/gi, " ");
    const names = inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[A-Za-z][A-Za-z0-9-]*$/.test(s));
    if (names.length) out.set(name, names);
  }
  return out;
}
