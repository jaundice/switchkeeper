# Phase 4 build contract (columnar / table objects — read + guarded cell edit)

Phase 4 surfaces vendor TABLE objects (per-port / per-row settings) that net-snmp's
`getProvidersForModule` doesn't expose as individual columns, and lets the read-write ones be
edited — but only through the Phase 2 SafetyEngine, which must map a cell's row back to a port/VLAN
so it can still protect the management path. Overriding rules carry over: a generic write is never
`safe`; writes that target a protected port/VLAN — or land in an IP/SNMP/credential subtree — are
`blocked`; when a cell's row index can't be decoded, classify `risky` (never safe); nothing
auto-saves.

## Shared types (model.ts additions / extensions)

Extend `CapabilityTable` (back-compatible — existing curated tables keep working):

```ts
export interface CapabilityColumnMeta {
  name: string;            // column symbol, e.g. "extremePortLoadShareGroupId"
  oid: string;             // the COLUMN base OID (no instance)
  access: ObjectAccess;    // read-write columns are editable
  base: MibBaseType;       // editor widget category (full enums/range fetched via object-meta)
}
export interface CapabilityTable {
  columns: string[];                 // header labels (existing)
  rows: (string | number | null)[][];// existing
  columnMeta?: CapabilityColumnMeta[]; // aligned to columns[]; present on generic editable tables
  rowKeys?: string[];                // instance suffix per row, aligned to rows[] (e.g. "49" or "1.20")
  index?: string;                    // human note on the index, e.g. "ifIndex" / "dot1qVlan" / "raw"
}
```

A cell (column `c`, row `r`) is editable iff `columnMeta[c].access === "read-write"`; its instance
OID is `columnMeta[c].oid + "." + rowKeys[r]`. The existing `setObject` Edit carries that OID.

## Engine (owned by the engine agent — `packages/engine/**` only)

```ts
// mibSyntax.ts (or a new mibStructure.ts)
//  Enumerate ALL objects a module defines, including table COLUMNS (which net-snmp's providers
//  omit). Parse every OBJECT-TYPE block and resolve its OID from the `::= { parent N }` chain,
//  seeding parent OIDs from net-snmp providers (entries/scalars are providers). Classify each.
export interface ModuleObject {
  name: string; oid: string; access: ObjectAccess; base: MibBaseType;
  kind: "scalar" | "table" | "row" | "column";
  table?: string;          // for columns: the owning table/entry symbol
}
export function enumerateModule(mib: MibStore, module: string): ModuleObject[];

// Decode a full instance OID to the entity its row represents, using the owning table's INDEX
// clause. Supports the common, safely-decodable cases; returns null when the index can't be mapped.
//  - single INDEX { ifIndex }      -> { port } (map ifIndex -> Port via state)
//  - INDEX starting with a VLAN id -> { vlan }
//  - anything else                 -> null (undecodable)
export function buildRowDecoder(
  mib: MibStore,
  state: DeviceState,
): (instanceOid: string) => { port?: number; vlan?: number } | null;
```

Capability model (`deviceCapabilities.ts`):
- In addition to scalar generic sections, emit generic TABLE sections for vendor tables: pick each
  table entry under the device enterprise, enumerate its columns (`enumerateModule`), SNMP-walk the
  columns (bounded), assemble `rows` keyed by the shared instance suffix, and attach `columnMeta`
  (name/oid/access/base per column) + `rowKeys` + `index`. Only emit tables that returned rows.
  Keep the existing scalar generic sections. Stay within an overall bounded GET/walk budget.

SafetyEngine (`safety.ts`) — extend `classifyEdits` with an optional row decoder:
```ts
export function classifyEdits(
  edits: Edit[], state: DeviceState, protectedSet: ProtectedSet,
  opts?: { decodeRow?: (instanceOid: string) => { port?: number; vlan?: number } | null },
): SafetyReport;
```
For a `setObject` whose OID is a table cell:
- decode the row; if it resolves to a port ∈ protectedSet.ports OR a vlan ∈ protectedSet.vlans →
  **blocked** ("targets the management port/VLAN");
- else if the OID is under a dangerous subtree (existing `DANGEROUS_OID_PREFIXES`) → **blocked**;
- else if decodable and not protected → **risky**;
- if undecodable → **risky** (never safe). Scalars keep their Phase 3 behaviour.
`planDevice`/`applyDevice` build `decodeRow = buildRowDecoder(mib, state)` and pass it in. (They
already receive the mib store via the capabilities path; thread it through, or read topology/state
as today — keep it read-only.)

Tests (`packages/engine/test/`): `enumerateModule` on fixture MIB text containing a table (entry +
≥2 columns) — columns resolve to `entryOid + ".1." + col`; INDEX parsing + suffix decode for an
`ifIndex` table and a `dot1q` (vlan-first) table; `classifyEdits` for a cell `setObject` → blocked
when the decoded port is protected, risky when not, blocked under a dangerous subtree, risky when
undecodable.

## Surfaces (owned by the surfaces agent — server.ts, web-bridge.js, main.cjs, preload.cjs, renderer/*)

- No new endpoints required: generic table sections now arrive in the CapabilityModel; `setObject`
  + `object-meta` + apply/gating already exist from Phase 3.
- Renderer: render generic TABLE sections (columns × rows) in the adaptive view (Advanced shows the
  generic sections, as today). For a cell in a column whose `columnMeta.access === "read-write"`,
  show an "Edit" affordance (Advanced mode only).
- USE A DETAIL OVERLAY *or* an EXPANDING SUBROW for editing (agent's choice — whichever keeps dense
  tables readable; both are fine). An overlay is a modal with a backdrop; a subrow is an inline
  expanding panel inserted directly beneath the clicked row. Either one shows the object (name,
  current value, units/description from
  `object-meta`), the editor widget built from `columnMeta.base` / `object-meta` (enum select,
  bounded number, toggle, text), and — once "Review" is pressed — the Phase 2 safety classification
  inline (risky confirm / blocked typed-confirm), with Apply in the overlay. The overlay stages a
  `setObject` with `oid = columnMeta.oid + "." + rowKeys[row]`, `name = columnMeta.name + "." +
  rowKeys[row]`, runs the EXISTING dry-run plan → Phase 2 gating (SafetyEngine marks it risky, or
  blocked if it targets a protected row) → apply. (This is the real app renderer, not a sandboxed
  widget, so a normal in-flow modal/overlay with a backdrop is fine — no position:fixed concerns.)
  An overlay may also be used to show full read-only object/row detail. Read-only columns / tables
  without `columnMeta` stay display-only. Reuse the Phase 3 editor widgets + the Phase 2
  review/gating logic (factor it so the overlay and the existing review bar share the gating code).
- Keep the existing scalar editors working unchanged.

## Hard constraints (both agents)

- ESM, explicit `.ts` import extensions; `node --experimental-strip-types` (no enum/namespace/
  parameter-properties).
- All cell writes go through the SafetyEngine + existing verify/rollback; a write to a protected
  row must be refused without `allowBlocked`. Never auto-save. Reads (column walks) are read-only.
- Engine agent edits only `packages/engine/**`; surfaces agent only the listed surface files.
- Default to the safe side: if a row can't be decoded, it is `risky` (gated), never `safe`. Match
  existing style; comment the "why". Neither agent commits/pushes/deploys.
