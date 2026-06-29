# v0.4.x polish contract (3 parallel streams)

Three disjoint workstreams. File ownership is exclusive so they run in parallel without conflict:
- ENGINE agent: `packages/engine/**` only.
- UI agent: `packages/desktop/renderer/{app.js,index.html}`, `packages/mcp/src/server.ts`,
  `packages/mcp/web/web-bridge.js`, `packages/desktop/main.cjs`, `packages/desktop/preload.cjs`.
- DOCS agent: `docs/**` and `README.md` only.
- NOBODY edits `CHANGELOG.md` or any `package.json` version (the orchestrator handles release).

Carry-over invariants: read paths stay read-only; writes go through the existing plan → Phase 2
safety gating → verify/rollback; never auto-save. ESM + explicit `.ts` import extensions; runs under
`node --experimental-strip-types` (no TS `enum`/`namespace`/parameter-properties). Match existing
style; comment the "why". No agent commits/pushes/deploys.

## Cross-cutting contract: BITS

`describeObject` (engine) sets `base: "bits"` for a BITS object and populates `enums` with one entry
per named bit: `{ label, value }` where **`value` is the bit position** (0-based, per SMI). The UI
renders one checkbox per `enums` entry; on apply it encodes the selected bit positions into the
SNMP OCTET STRING (big-endian bit string: bit position p → byte `p>>3`, mask `0x80 >> (p & 7)`).
The engine's `editToVarbinds`/`coerceSetValue` for a `setObject` whose resolved base is `bits` must
accept that encoded value (a hex/byte string) and build an OctetString varbind.

## ENGINE stream (task #57)

1. GETBULK table walks: make the column walk used by `sweepTableColumns` use SNMP GETBULK (v2c) for
   far fewer round-trips, falling back to GETNEXT if a device rejects bulk. Add/extend a bulk walk on
   `SnmpClient` (e.g. `walkBulk(baseOid)` / `column(oid, {bulk})`), keep the existing per-row keying
   and the read-only contract. Goal: a per-table on-demand load is materially faster than the current
   serial GETNEXT walk. Keep the wall-clock budget.
2. Extend `buildRowDecoder` (mibStructure.ts) to more INDEX shapes so more per-row writes are precisely
   classified: in addition to single `ifIndex` and leading-VLAN, handle (a) a single port/bridge-port
   index, (b) INDEX whose decodable leading element maps to a port or VLAN even with trailing index
   parts, returning `{port}`/`{vlan}` when confident. Anything still ambiguous → `null` (stays risky).
   Keep it conservative (never claim a mapping you're unsure of). Add tests.
3. BITS parsing: in `describeObject`/the SYNTAX parser, parse `BITS { name(0), name(1), ... }` into
   `MibSyntax.enums` per the cross-cutting contract (value = bit position), `base: "bits"`. Handle the
   `setObject` write coercion for bits (accept the UI's encoded octet-string value). Add tests.
4. Rollback-timer hook (SAFE FRAMEWORK ONLY): add an optional `VendorProfile.commitConfirm?` shape
   (e.g. `{ armOid, confirmOid, timeoutSec }`) and, in `applyDevice`, IF a profile defines it AND the
   caller opts in, arm it before writes and confirm after the reachability check. Do NOT add values
   for any vendor (none are known to support a standard SNMP rollback timer here) — ship the hook +
   types as a no-op extension point, documented. Never change the default no-auto-save behaviour.
5. Mock-device integration test: a fake `SnmpClient` (recorded GET/GETNEXT/GETBULK responses for a
   small synthetic device) driving `readDeviceCapabilities` (curated + scalar + table-stub) and a
   `planDevice` setObject classification end-to-end — so the live path has CI coverage without
   hardware. Keep all existing engine tests green.

Export any new public functions/types. Report new signatures so the UI side can rely on them.

## UI stream (task #58)

All in the renderer (+ a `/api/export` only if you truly need server help — you shouldn't; the model
is already in the client). Reuse existing components; don't duplicate the gating/editor logic.
1. BITS editor: when `object-meta.base === "bits"`, render a checkbox group from `enums` (one per
   named bit), encode selected bits to the octet-string value per the cross-cutting contract, and feed
   it through the existing `setObject` → plan → gating → apply path.
2. Diff / change history: keep an in-session log of applied change-sets (what was set, old→new,
   classification, result, timestamp) and show it in a panel; no persistence required.
3. Snapshot / export: a button to download the current capability model (curated + scalars + any
   loaded tables) as a JSON file (client-side `Blob`/anchor download); include host + timestamp.
4. Descriptions/units tooltips: on read-only capability displays (scalars + table headers), surface the
   MIB `description`/`units` (lazy-fetch via `object-meta` on hover/expand, or show what's already
   present) as a tooltip/expandable note. Keep it unobtrusive.
5. Search/filter: a filter box for the generic sections (filter objects/rows by name/oid/value) so a
   big device is navigable.

## DOCS stream (task #59)

- A `docs/` user guide (e.g. `docs/mib-driven-management.md`) covering: discovery/read, the adaptive
  capability model + Advanced mode, the SafetyEngine (what safe/risky/blocked mean, the management-path
  protection, no-auto-save), generic object editing + type-aware editors, lazy table editing, and the
  MCP tools. Operational notes: SNMP write community + device source-permit, and rollback-timer
  operational guidance (running-only + reboot-recovers is the baseline guarantee).
- A concise section in `README.md` linking to it and summarizing the MIB-driven capability.
- Accurate to the shipped behaviour; do not document features that don't exist.
