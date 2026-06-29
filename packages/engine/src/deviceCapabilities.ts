// deviceCapabilities: build the adaptive CapabilityModel a device exposes.
//
// Two halves, deliberately separated so the pure logic is unit-testable without a live device:
//  - buildCuratedSections(state, topo?)  — hand-bound categories from the existing DeviceState
//    (System & Inventory, Ports, VLANs, PoE, LLDP/Topology). Section emitted only when populated.
//  - buildGenericSections(objects, values) — auto-built "everything the MIBs open up": one
//    section per vendor MIB module, listing the readable scalar leaves that actually returned
//    a value. This is the mechanism that gives vendor coverage without hand-coded OIDs.
//
// The live readDeviceCapabilities orchestrates SNMP (probe + readState + topology, then a
// bounded sweep of vendor scalars) and feeds the results into those two pure helpers.
// Read-only throughout: it never constructs a write community and never calls SnmpClient.set.
import { SnmpClient } from "./snmp.ts";
import { asString, asInt } from "./snmp.ts";
import { probe } from "./capabilities.ts";
import { readState } from "./readState.ts";
import { readFdb, readLldpNeighbors } from "./topology.ts";
import { profileForEnterprise } from "./profiles.ts";
import { accessFromMaxAccess, typeFromScalarType } from "./objectResolver.ts";
import { enumerateModule, rowIndexNames, type ModuleObject } from "./mibStructure.ts";
import type { MibStore } from "./mib.ts";
import type {
  CapabilityColumnMeta,
  CapabilityModel,
  CapabilitySection,
  CapabilityValue,
  Credential,
  DeviceState,
  FdbEntry,
  LldpNeighbor,
  ResolvedObject,
} from "./model.ts";

export interface Topology {
  lldp: LldpNeighbor[];
  fdb: FdbEntry[];
}

// ---- Pure section builders (no SNMP; unit-tested directly) ----

/**
 * Build the curated category sections from a DeviceState (+ optional topology). Only sections
 * that actually have content for this device are emitted, in a stable display order:
 * System & Inventory → Ports → VLANs → PoE → LLDP/Topology. This mirrors today's behaviour, so
 * a MIB-less device still produces exactly these standard sections.
 */
export function buildCuratedSections(state: DeviceState, topo?: Topology): CapabilitySection[] {
  const sections: CapabilitySection[] = [];
  const dev = state.device;

  // System & Inventory — whichever identity fields the probe could read.
  const sys: CapabilityValue[] = [];
  const sysPush = (name: string, value: string | number | null | undefined) => {
    if (value !== undefined && value !== null && value !== "") {
      sys.push({ name, oid: "", value });
    }
  };
  sysPush("sysName", dev.sysName);
  sysPush("sysDescr", dev.model);
  sysPush("firmware", dev.firmware);
  sysPush("baseMac", dev.baseMac);
  sysPush("portCount", dev.portCount);
  sysPush("vendorOid", dev.vendorOid);
  if (sys.length) {
    sections.push({ id: "system", title: "System & Inventory", kind: "curated", scalars: sys });
  }

  // Ports — one row per port. Columns chosen to be vendor-neutral and present on every read.
  if (state.ports.length) {
    sections.push({
      id: "ports",
      title: "Ports",
      kind: "curated",
      table: {
        columns: ["ifIndex", "name", "label", "admin", "oper", "speedMbps", "pvid", "tagged"],
        rows: state.ports.map((p) => [
          p.ifIndex,
          p.name,
          p.label ?? null,
          p.adminStatus,
          p.operStatus,
          p.speedMbps ?? null,
          p.pvid ?? null,
          p.taggedVlans.length ? p.taggedVlans.join(",") : null,
        ]),
      },
    });
  }

  // VLANs — one row per VLAN.
  if (state.vlans.length) {
    sections.push({
      id: "vlans",
      title: "VLANs",
      kind: "curated",
      table: {
        columns: ["vid", "name", "untagged", "tagged"],
        rows: state.vlans.map((v) => [
          v.vid,
          v.name ?? null,
          v.members.untagged.length ? v.members.untagged.join(",") : null,
          v.members.tagged.length ? v.members.tagged.join(",") : null,
        ]),
      },
    });
  }

  // PoE — only the ports the device reports as PoE-capable. Absent entirely on non-PoE switches.
  const poePorts = state.ports.filter((p) => p.poe?.capable);
  if (poePorts.length) {
    sections.push({
      id: "poe",
      title: "PoE",
      kind: "curated",
      table: {
        columns: ["ifIndex", "name", "adminOn", "status", "class", "watts"],
        rows: poePorts.map((p) => [
          p.ifIndex,
          p.name,
          p.poe!.adminOn === undefined ? null : p.poe!.adminOn ? "on" : "off",
          p.poe!.status ?? null,
          p.poe!.class ?? null,
          p.poe!.watts ?? null,
        ]),
      },
    });
  }

  // LLDP / Topology — neighbours discovered via LLDP. Reuses readTopology output. Only emitted
  // when the device actually reported neighbours (FDB alone doesn't make a useful curated view).
  if (topo && topo.lldp.length) {
    sections.push({
      id: "lldp",
      title: "LLDP / Topology",
      kind: "curated",
      table: {
        columns: ["localPort", "remoteSysName", "remotePortId", "remotePortDesc", "remoteChassisId"],
        rows: topo.lldp.map((n) => [
          n.localPort,
          n.remoteSysName ?? null,
          n.remotePortId ?? null,
          n.remotePortDesc ?? null,
          n.remoteChassisId ?? null,
        ]),
      },
    });
  }

  return sections;
}

/**
 * Build the generic ("everything the MIBs open up") sections: one section per defining vendor
 * MIB module, listing the readable scalar leaves that returned a value. `objects` are the
 * candidate scalar leaves (already resolved + filtered to readable); `values` maps the
 * fully-qualified OID that was read (object OID + ".0") to the value GET returned. An object
 * with no value in the map is dropped (the device doesn't implement it), and a module with no
 * surviving objects produces no section. Sections are sorted by module for stable output.
 */
export function buildGenericSections(
  objects: ResolvedObject[],
  values: Map<string, string | number | null>,
): CapabilitySection[] {
  const byModule = new Map<string, CapabilityValue[]>();
  for (const obj of objects) {
    const instOid = scalarInstanceOid(obj.oid);
    if (!values.has(instOid)) continue; // device didn't return a value -> not implemented here
    const value = values.get(instOid) ?? null;
    if (!byModule.has(obj.module)) byModule.set(obj.module, []);
    byModule.get(obj.module)!.push({ name: obj.name, oid: instOid, value, type: obj.type });
  }

  const sections: CapabilitySection[] = [];
  for (const moduleName of [...byModule.keys()].sort()) {
    const scalars = byModule.get(moduleName)!.sort((a, b) => a.name.localeCompare(b.name));
    sections.push({ id: moduleName, title: moduleName, kind: "generic", scalars });
  }
  return sections;
}

/** A scalar's instance OID is the object OID with the ".0" instance suffix (idempotent). */
export function scalarInstanceOid(oid: string): string {
  return oid.endsWith(".0") ? oid : oid + ".0";
}

// ---- Candidate selection (pure; drives the bounded live sweep) ----

// How many scalar GETs we are willing to issue in total. Vendor MIB sets can define thousands
// of objects; we cap the sweep so a capability read stays fast and gentle on the switch.
const MAX_GENERIC_GETS = 400;
// Batch size per SNMP GET. Kept modest so an oversized PDU never trips a device's response cap.
const GET_BATCH = 24;

/**
 * From the loaded vendor MIB modules, pick the readable scalar-leaf objects worth probing.
 * "Scalar leaf" is approximated as a readable object that is not itself a prefix of another
 * object in the same module — table columns/entries have children, true scalars don't. We then
 * cap the list to MAX_GENERIC_GETS so the live sweep is bounded. Standard modules are excluded
 * (their content is already surfaced in curated sections); only the device's own vendor MIBs
 * feed the generic view, which is the whole point of "coverage bounded by the device's MIBs".
 */
export function selectGenericCandidates(mib: MibStore, enterprise?: number): ResolvedObject[] {
  const standardModules = new Set(STANDARD_MODULES);
  // The generic catch-all is for VENDOR objects only: restrict to the enterprises subtree
  // (1.3.6.1.4.1.*) so standard MIBs that get pulled in as imports (SNMP-TARGET-MIB under
  // snmpModules, DIFFSERV-MIB under mib-2, etc.) don't leak in. When the device's enterprise is
  // known, narrow further to its own subtree so we don't sweep other vendors' objects.
  const wantPrefix = enterprise ? `1.3.6.1.4.1.${enterprise}.` : "1.3.6.1.4.1.";
  const out: ResolvedObject[] = [];

  for (const moduleName of mib.loadedModules()) {
    if (standardModules.has(moduleName)) continue;
    const objects = mib.providers(moduleName);
    // Sort OIDs so we can cheaply detect "has a child" (an object whose OID starts with this
    // one + "."): a parent immediately precedes its descendants in OID order.
    const sorted = [...objects].sort((a, b) => compareOid(a.oid, b.oid));
    for (let i = 0; i < sorted.length; i++) {
      const obj = sorted[i];
      if (!obj.oid.startsWith(wantPrefix)) continue; // not a vendor object -> not generic
      const access = accessFromMaxAccess(obj.maxAccess);
      if (access !== "read-only" && access !== "read-write") continue; // skip not-accessible
      const next = sorted[i + 1];
      if (next && next.oid.startsWith(obj.oid + ".")) continue; // has children -> not a scalar leaf
      out.push({
        name: obj.name,
        oid: obj.oid,
        module: moduleName,
        source: "device-mib",
        type: typeFromScalarType(obj.scalarType),
        access,
      });
      if (out.length >= MAX_GENERIC_GETS) return out;
    }
  }
  return out;
}

// Modules whose objects are already presented in curated sections; excluded from the generic
// catch-all to avoid duplicating the standard slice. (net-snmp's base set + the IETF/IEEE MIBs
// the loader ships as the resolution baseline.)
const STANDARD_MODULES = [
  "SNMPv2-MIB", "SNMPv2-SMI", "SNMPv2-TC", "SNMPv2-CONF", "SNMP-FRAMEWORK-MIB",
  "IF-MIB", "IANAifType-MIB", "BRIDGE-MIB", "Q-BRIDGE-MIB", "P-BRIDGE-MIB",
  "POWER-ETHERNET-MIB", "LLDP-MIB", "IEEE8023-LAG-MIB", "RFC1213-MIB", "IP-MIB",
  "ENTITY-MIB", "HOST-RESOURCES-MIB", "RMON-MIB", "TCP-MIB", "UDP-MIB",
];

// ---- Phase 4: generic TABLE candidate selection + pure section builder ----

// How many table COLUMNS we are willing to walk in total (across all vendor tables). Each column is
// one subtree walk (many GETNEXTs); on a big switch hundreds of walks block the event loop and can
// trip SNMP timeouts, so we cap the count AND enforce a wall-clock budget (TABLE_SWEEP_BUDGET_MS).
const MAX_TABLE_COLUMNS = 80;
// Hard wall-clock budget for the whole table sweep. When exceeded we stop walking and return what
// we have — capability reads must stay responsive even on a device with many/large vendor tables.
const TABLE_SWEEP_BUDGET_MS = 15000;

/** One vendor table to walk: its entry symbol + its columns (resolved OID + access + base). */
export interface GenericTableCandidate {
  module: string;
  entry: string;       // the table ENTRY (row) symbol, e.g. "extremePortConfigEntry"
  title: string;       // section title (the entry symbol)
  columns: ModuleObject[]; // accessible columns of this table (kind === "column")
}

/**
 * From the loaded vendor MIBs, pick the TABLE entries under the device enterprise and enumerate
 * their accessible columns. Mirrors selectGenericCandidates' scoping (vendor enterprise subtree,
 * standard modules excluded) but for tables: enumerateModule surfaces the columns that net-snmp's
 * providers omit. Bounded by MAX_TABLE_COLUMNS columns total. Pure (no SNMP).
 */
export function selectGenericTables(mib: MibStore, enterprise?: number): GenericTableCandidate[] {
  const standardModules = new Set(STANDARD_MODULES);
  const wantPrefix = enterprise ? `1.3.6.1.4.1.${enterprise}.` : "1.3.6.1.4.1.";
  const out: GenericTableCandidate[] = [];
  let budget = MAX_TABLE_COLUMNS;

  for (const moduleName of mib.loadedModules()) {
    if (standardModules.has(moduleName)) continue;
    if (budget <= 0) break;
    // Cheap pre-filter (providers come from the cache, no parse): only the device-vendor's own
    // modules have objects under wantPrefix, so skip parsing the dozens of other-vendor/standard
    // modules. This keeps the request-path enumeration to ~the vendor's modules, not all of them.
    if (!mib.providers(moduleName).some((p) => p.oid.startsWith(wantPrefix))) continue;
    const objs = enumerateModule(mib, moduleName);
    if (!objs.length) continue;
    // Group columns by their owning entry (row) symbol.
    const colsByEntry = new Map<string, ModuleObject[]>();
    for (const o of objs) {
      if (o.kind !== "column" || !o.table) continue;
      if (!o.oid.startsWith(wantPrefix)) continue; // vendor-subtree only
      if (o.access !== "read-only" && o.access !== "read-write") continue; // accessible columns only
      if (!colsByEntry.has(o.table)) colsByEntry.set(o.table, []);
      colsByEntry.get(o.table)!.push(o);
    }
    for (const [entry, columns] of colsByEntry) {
      if (!columns.length) continue;
      // Stable column order by OID so the table reads left-to-right by column sub-id.
      columns.sort((a, b) => compareOid(a.oid, b.oid));
      const take = columns.slice(0, Math.max(0, budget));
      if (!take.length) break;
      budget -= take.length;
      out.push({ module: moduleName, entry, title: entry, columns: take });
      if (budget <= 0) break;
    }
  }
  return out;
}

/**
 * Build the generic TABLE sections (pure; the live walk feeds it). For each table candidate,
 * `columnValues` maps a column's base OID to (rowKey -> cell value) gathered from the column walk.
 * Rows are keyed by the shared instance suffix (rowKey) seen across the table's columns; a row is
 * emitted for every rowKey any column returned. Only tables that returned at least one row produce
 * a section. columnMeta/rowKeys/index are attached so the UI can build per-cell editors and the
 * SafetyEngine can decode each cell. Sorted by module then entry for stable output.
 */
export function buildGenericTableSections(
  candidates: GenericTableCandidate[],
  columnValues: Map<string, Map<string, string | number | null>>,
  indexNote?: (entry: string) => string | undefined,
): CapabilitySection[] {
  const sections: CapabilitySection[] = [];
  for (const cand of candidates) {
    // Collect the union of row keys across this table's columns.
    const rowKeySet = new Set<string>();
    for (const col of cand.columns) {
      const m = columnValues.get(col.oid);
      if (m) for (const k of m.keys()) rowKeySet.add(k);
    }
    if (!rowKeySet.size) continue; // table returned nothing -> don't emit it

    const rowKeys = [...rowKeySet].sort(compareOid);
    const columnMeta: CapabilityColumnMeta[] = cand.columns.map((c) => ({
      name: c.name,
      oid: c.oid,
      access: c.access,
      base: c.base,
    }));
    const columns = cand.columns.map((c) => c.name);
    const rows = rowKeys.map((rk) =>
      cand.columns.map((c) => {
        const m = columnValues.get(c.oid);
        const v = m?.get(rk);
        return v === undefined ? null : v;
      }),
    );

    sections.push({
      id: cand.entry,
      title: cand.title,
      kind: "generic",
      table: {
        columns,
        rows,
        columnMeta,
        rowKeys,
        index: indexNote ? indexNote(cand.entry) : undefined,
      },
    });
  }
  // Stable order: by section title (entry symbol).
  return sections.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Build a STUB generic table section (lazy-tables; no SNMP). Same column-meta/index logic as
 * buildGenericTableSections, but with NO rows: the capability read only LISTS the table (its columns,
 * per-column meta, index note) and the client fetches rows on demand via readTable(). `lazy: true`
 * marks it as not-yet-loaded so the UI shows a "Load rows" affordance. rows/rowKeys are empty.
 */
export function buildTableStub(
  cand: GenericTableCandidate,
  indexNote?: (entry: string) => string | undefined,
): CapabilitySection {
  const columnMeta: CapabilityColumnMeta[] = cand.columns.map((c) => ({
    name: c.name,
    oid: c.oid,
    access: c.access,
    base: c.base,
  }));
  return {
    id: cand.entry,
    title: cand.title,
    kind: "generic",
    table: {
      columns: cand.columns.map((c) => c.name),
      rows: [],
      columnMeta,
      rowKeys: [],
      index: indexNote ? indexNote(cand.entry) : undefined,
      lazy: true,
    },
  };
}

/** Numeric, dot-separated OID comparison (so "1.3.6.1.4.1.9.10" sorts after "1.3.6.1.4.1.9.2"). */
function compareOid(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

// ---- Live orchestration ----

/**
 * Read a live device and return the adaptive CapabilityModel. Curated sections come from the
 * existing DeviceState read (probe + readState) + topology (readTopology); generic SCALAR sections
 * come from a bounded GET sweep of the device's vendor-MIB scalar leaves. Generic TABLE sections are
 * listed as STUBS only (lazy-tables) — NO table SNMP walk happens here; the client fetches a table's
 * rows on demand via readTable(). Falls back gracefully: with no vendor MIBs loaded,
 * selectGenericCandidates/selectGenericTables are empty and only the standard curated sections
 * appear, matching today's behaviour. MUST NOT perform any SNMP SET.
 */
export async function readDeviceCapabilities(
  host: string,
  credential: Credential,
  mib: MibStore,
): Promise<CapabilityModel> {
  const client = new SnmpClient(host, credential);
  try {
    const { device, capabilities } = await probe(client, host);
    const state = await readState(client, device, capabilities);

    // Topology is best-effort: a device without LLDP/FDB still produces the other sections.
    let topo: Topology | undefined;
    try {
      const [lldp, fdb] = await Promise.all([readLldpNeighbors(client), readFdb(client)]);
      topo = { lldp, fdb };
    } catch {
      topo = undefined;
    }

    const curated = buildCuratedSections(state, topo);

    // Generic sweep: GET each candidate scalar instance in bounded batches, keeping only the
    // ones that came back with a usable value. Per-batch failures are swallowed so one bad PDU
    // doesn't sink the whole capability read.
    const candidates = selectGenericCandidates(mib, device.vendorEnterprise);
    const values = await sweepScalars(client, candidates);
    const generic = buildGenericSections(candidates, values);

    // Lazy-tables (Phase 4 perf): the capability read no longer WALKS vendor tables (that cost
    // ≈15–18 s and a heavy SNMP load on big switches). It only LISTS them as STUB sections — columns,
    // per-column meta and an index note, but rows=[] — and the client fetches a table's rows on demand
    // via readTable()/POST /api/table when the user opens it. Enumeration is memoized + vendor-only, so
    // listing stubs is cheap and does NO SNMP. Guarded: if enumeration somehow throws, degrade to no
    // tables rather than sinking the read.
    let genericTables: CapabilitySection[] = [];
    try {
      const tableCands = selectGenericTables(mib, device.vendorEnterprise);
      const indexNote = indexNoteFor(mib, tableCands);
      genericTables = tableCands.map((cand) => buildTableStub(cand, indexNote));
    } catch {
      genericTables = [];
    }

    const vendor = profileForEnterprise(device.vendorEnterprise).name || "Unknown";

    return {
      host,
      vendor,
      mibs: { loaded: mib.loadedModules().length, indexed: mib.indexedModules().length },
      // curated first, then generic scalars, then generic tables, per the contract ordering.
      sections: [...curated, ...generic, ...genericTables],
    };
  } finally {
    client.close();
  }
}

/**
 * Build the index-note closure shared by the stub-listing path and the loaded readTable path: for a
 * table entry, the human note is its INDEX element names (e.g. "ifIndex" / "dot1qVlanIndex"), or
 * "raw" when the entry has no parseable INDEX clause. Pure (rowIndexNames just scans module text).
 */
function indexNoteFor(
  mib: MibStore,
  cands: GenericTableCandidate[],
): (entry: string) => string | undefined {
  return (entry: string): string | undefined => {
    const cand = cands.find((c) => c.entry === entry);
    if (!cand) return undefined;
    const names = rowIndexNames(mib, cand.module, entry);
    return names.length ? names.join(", ") : "raw";
  };
}

/**
 * Lazy-tables on-demand walk: resolve ONE vendor table by its entry symbol and return its populated
 * (non-lazy) CapabilitySection, or null if the device exposes no such table. Probes the device for
 * its vendorEnterprise, selects the matching candidate, opens a read-only SnmpClient, walks just that
 * table's columns (bounded by the TABLE_SWEEP_BUDGET_MS wall-clock budget), and builds the single
 * section via the same buildGenericTableSections used by the eager path (so rows/columnMeta/rowKeys/
 * index match exactly). Read-only — never SETs; closes the client in finally.
 */
export async function readTable(
  host: string,
  credential: Credential,
  mib: MibStore,
  entry: string,
): Promise<CapabilitySection | null> {
  const client = new SnmpClient(host, credential);
  try {
    // Probe for the enterprise so we scope to the device's own table candidates (same scoping the
    // stub listing used), then find the one the caller asked for.
    const { device } = await probe(client, host);
    const cands = selectGenericTables(mib, device.vendorEnterprise);
    const cand = cands.find((c) => c.entry === entry);
    if (!cand) return null; // device doesn't expose this table -> nothing to load

    const columnValues = await sweepTableColumns(client, [cand], Date.now() + TABLE_SWEEP_BUDGET_MS);
    const indexNote = indexNoteFor(mib, cands);
    // buildGenericTableSections drops a table that returned no rows; for a stub the caller still
    // opened, return that empty-but-loaded shape rather than null so the UI shows "no rows" (not
    // "table absent"). Rows filled, no lazy flag.
    const [section] = buildGenericTableSections([cand], columnValues, indexNote);
    return section ?? buildEmptyLoadedTable(cand, indexNote);
  } finally {
    client.close();
  }
}

/** A loaded-but-empty table section: same shape as buildGenericTableSections output but with zero
 *  rows (the table exists, the device just returned no entries). Not lazy — the rows ARE loaded. */
function buildEmptyLoadedTable(
  cand: GenericTableCandidate,
  indexNote?: (entry: string) => string | undefined,
): CapabilitySection {
  const columnMeta: CapabilityColumnMeta[] = cand.columns.map((c) => ({
    name: c.name,
    oid: c.oid,
    access: c.access,
    base: c.base,
  }));
  return {
    id: cand.entry,
    title: cand.title,
    kind: "generic",
    table: {
      columns: cand.columns.map((c) => c.name),
      rows: [],
      columnMeta,
      rowKeys: [],
      index: indexNote ? indexNote(cand.entry) : undefined,
      // No `lazy` flag: the rows were walked, the table is simply empty on this device.
    },
  };
}

/** GET each candidate's scalar instance OID in bounded batches; return oid -> value for the
 *  ones that returned a usable (non-error, non-null) value. */
async function sweepScalars(
  client: SnmpClient,
  candidates: ResolvedObject[],
): Promise<Map<string, string | number | null>> {
  const out = new Map<string, string | number | null>();
  const oids = candidates.map((c) => scalarInstanceOid(c.oid));
  for (let i = 0; i < oids.length; i += GET_BATCH) {
    const batch = oids.slice(i, i + GET_BATCH);
    try {
      const vbs = await client.get(batch);
      for (const vb of vbs) {
        const v = normalizeValue(vb.type, vb.value);
        if (v !== undefined) out.set(vb.oid, v);
      }
    } catch {
      // transport error on this batch; skip it and keep going.
    }
  }
  return out;
}

/**
 * Walk each candidate table column (read-only) and return columnOid -> (rowKey -> value). rowKey is
 * the instance suffix after the column base (what SnmpClient.column already keys by). Per-column
 * walk failures are swallowed so one bad column doesn't sink the whole table.
 */
export async function sweepTableColumns(
  client: SnmpClient,
  candidates: GenericTableCandidate[],
  deadline: number,
): Promise<Map<string, Map<string, string | number | null>>> {
  const out = new Map<string, Map<string, string | number | null>>();
  for (const cand of candidates) {
    if (Date.now() > deadline) break; // out of budget -> return what we have so far
    for (const col of cand.columns) {
      if (Date.now() > deadline) break;
      try {
        const cells = await client.column(col.oid);
        const m = new Map<string, string | number | null>();
        for (const [rowKey, vb] of cells) {
          const v = normalizeValue(vb.type, vb.value);
          if (v !== undefined) m.set(rowKey, v);
        }
        if (m.size) out.set(col.oid, m);
      } catch {
        // transport/walk error on this column; skip it and keep going.
      }
    }
  }
  return out;
}

// net-snmp uses type codes 128/129/130 for noSuchObject / noSuchInstance / endOfMibView; those
// mean "not implemented here", so they yield undefined (dropped). Everything else is rendered as
// a number (integers/counters/gauges) or a string.
function normalizeValue(type: number, value: unknown): string | number | null | undefined {
  if (type === 128 || type === 129 || type === 130) return undefined;
  if (value === null || value === undefined) return undefined;
  if (type === 2 || type === 65 || type === 66 || type === 67 || type === 70) {
    return asInt(value); // Integer / Counter32 / Gauge32 / TimeTicks / Counter64
  }
  const s = asString(value);
  return s === "" ? null : s;
}
