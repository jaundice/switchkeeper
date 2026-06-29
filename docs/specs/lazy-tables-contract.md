# Lazy-tables refactor contract (Phase 4 perf)

A capability read currently walks every vendor table up front (≈15–18 s on a big switch and a heavy
SNMP load on the device). Refactor so the capability read only LISTS the available tables (cheap,
no SNMP walk) and the UI fetches a table's rows on demand when the user opens it. Curated sections
and the generic SCALAR sweep stay eager (they're fast and naturally inline). No behaviour change to
safety/edit — a cell write still goes through the existing plan → Phase 2 gating → apply.

## Model (model.ts)

Extend `CapabilityTable` (back-compatible):

```ts
export interface CapabilityTable {
  columns: string[];
  rows: (string | number | null)[][];
  columnMeta?: CapabilityColumnMeta[];
  rowKeys?: string[];
  index?: string;
  lazy?: boolean;   // NEW: true on a STUB section — columnMeta/columns/index are present but rows
                    // are NOT loaded (rows=[], rowKeys=[]); the client fetches rows via /api/table.
}
```

## Engine (engine agent — `packages/engine/**` only)

- `readDeviceCapabilities`: STOP walking tables. For each `selectGenericTables(...)` candidate, emit a
  STUB generic table section: `{ id: entry, title, kind:"generic", table: { columns: <column names>,
  rows: [], columnMeta, rowKeys: [], index: <note>, lazy: true } }`. No SNMP for tables here.
  Keep curated sections + the generic scalar sweep exactly as now. (Enumeration is already memoized
  + vendor-only, so listing stubs is cheap.)
- New `readTable(host, credential, mib, entry): Promise<CapabilitySection | null>`: resolve the table
  candidate by `entry` via `selectGenericTables(mib, <device enterprise>)` (probe the device for the
  enterprise, or accept it), open an SnmpClient, walk that ONE table's columns (reuse the bounded
  `sweepTableColumns` + `buildGenericTableSections` for the single candidate, with the wall-clock
  budget), and return the populated section (`lazy: false`/absent, rows filled). Return null if no
  such table. Read-only; never SET. Close the client in `finally`.
- Export `readTable`. Keep `selectGenericTables`/`buildGenericTableSections`/`sweepTableColumns`
  available (sweepTableColumns may need to be exported or wrapped).
- Tests: a stub-vs-loaded shape test of the pure builders (stub has `lazy:true`, rows empty;
  buildGenericTableSections for one candidate yields rows + columnMeta + rowKeys). Existing 140 tests
  stay green.

## Surfaces (surfaces agent — server.ts, web-bridge.js, main.cjs, preload.cjs, renderer/*)

- `POST /api/table` body `{ host, cred, entry }` → `{ ok:true, data: CapabilitySection|null }` calling
  `readTable(host, credFromWeb(cred), mibStore(), entry)` (null/`{ok:true,data:null}` if the store is
  still building). IPC `switch:table`; web-bridge `tableRows(req)`. MCP tool `switch_table`
  `{ host, entry, community? }` → `ok(section)` (read-only).
- Renderer: a `lazy:true` table section renders its header (`columns`) + an index note + a "Load rows"
  / expand affordance (and, if you like, lazy-load on first expand). Clicking calls
  `window.switchkeeper.tableRows({ host, cred, entry })`, then renders the returned rows and wires the
  EXISTING Phase 4 per-cell editor (read-write columns → the existing overlay/subrow → plan → Phase 2
  gating → apply). Show a small loading state; cache the loaded rows per table for the session so
  re-expanding doesn't re-fetch. Non-lazy tables (curated) render exactly as today.

## Hard constraints (both agents)

- ESM, explicit `.ts` extensions; `node --experimental-strip-types` (no enum/namespace/parameter-props).
- Capability reads must do NO table SNMP walks (only stub listing). `/api/table` walks one table,
  bounded, read-only. Cell writes keep going through the Phase 2 gating + verify/rollback; never
  auto-save. Engine agent edits only `packages/engine/**`; surfaces agent only the listed files.
- Match existing style; comment the "why". Neither agent commits/pushes/deploys.
