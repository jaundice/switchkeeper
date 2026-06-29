# Phase 2 build contract (SafetyEngine + write gating)

Phase 2 makes writes safe: detect the management path, classify every planned edit, and make it
impossible to *accidentally* sever connectivity. It wraps the EXISTING edit/apply path
(`apply.ts`) — it does not add new edit kinds (that's Phase 3). Overriding principle:
**default to the safe side.** When the management path or an edit's effect is uncertain, classify
*up* (risky/blocked), never down. Never auto-persist to startup.

## Shared types (added to `model.ts`, exported via engine index)

```ts
export type SafetyClass = "safe" | "risky" | "blocked";

// Ports/VLANs the app must not strand. Derived per device at plan time.
export interface ProtectedSet {
  ports: number[];                 // bridge ports carrying (or likely carrying) management
  vlans: number[];                 // management VLAN id(s)
  reason: string;                  // how it was derived (for display + audit)
  confidence: "high" | "medium" | "low";
}

export interface EditClassification {
  edit: Edit;
  cls: SafetyClass;
  reason: string;                  // human explanation, e.g. "disables the uplink (port 49)"
}

export interface SafetyReport {
  protectedSet: ProtectedSet;
  classifications: EditClassification[];
  worst: SafetyClass;              // max severity across all edits ("safe" if none)
}
```

`ChangeSet` gains an optional `safety?: SafetyReport` (populated by the plan path). Do not remove
or repurpose the existing `DiffEntry.warning` field.

## Engine functions (owned by the engine agent — `packages/engine/**` only)

```ts
// safety.ts
//  Derive the protected set from a device read + topology. sourceMac (the station the app talks
//  from, if known) lets us pin the exact mgmt access port via the FDB; otherwise fall back
//  conservatively (see rules). NEVER returns an empty protected set with high confidence.
export function detectProtectedSet(
  state: DeviceState,
  topo: { fdb: FdbEntry[]; lldp: LldpNeighbor[] },
  opts?: { sourceMac?: string; mgmtVlan?: number },
): ProtectedSet;

//  Pure classifier. No I/O. Exhaustively unit-tested.
export function classifyEdits(
  edits: Edit[],
  state: DeviceState,
  protectedSet: ProtectedSet,
): SafetyReport;
```

### Protected-set derivation (detectProtectedSet)

- ports:
  - if `sourceMac` is given and present in the FDB → the bridge port behind it is the mgmt access
    port (confidence high).
  - PLUS uplink ports: a bridge port with many distinct FDB MACs, or one with an LLDP neighbour
    that is a switch/router, is treated as carrying management (the path likely traverses it).
  - if nothing can be pinned → conservative fallback: ALL uplink-looking ports (confidence low).
- vlans:
  - the mgmt VLAN: the PVID/untagged VLAN of the mgmt access port, or `opts.mgmtVlan`, else the
    most common PVID, else VLAN 1 (confidence drops accordingly).
- `reason` must state exactly how it was derived; set `confidence` honestly.

### Classification rules (classifyEdits) — map bridge ports ⇄ ifIndex via DeviceState

With protected ports `P` and protected vlans `V`:

| Edit | blocked | risky | else |
|---|---|---|---|
| `setPortAdmin {up:false}` | port ∈ P | — | safe |
| `setPvid {bridgePort,vid}` | bridgePort ∈ P **and** vid ∉ V | — | safe |
| `setVlanMembership {vid,tagged,untagged}` | vid ∈ V **and** a port in P is dropped from egress (not in tagged∪untagged) | vid ∉ V but a port in P changes tagging | safe |
| `deleteVlan {vid}` | vid ∈ V | vid ∉ V (ports lose it) | — |
| `setLag {bridgePort}` | — | bridgePort ∈ P | safe |
| `setPoe {bridgePort,on:false}` | — | bridgePort ∈ P | safe |
| `setPoe {on:true}` / `createVlan` / `setPortLabel` | — | — | safe |
| `setPortAdmin {up:true}` | — | — | safe |

If an edit's target port/VLAN can't be resolved in the state → classify **risky** (uncertain).
`worst` = the max severity present (blocked > risky > safe).

### Commit-confirm / no-auto-save (apply path)

- `applyDevice` (and `applyChangeSet`) MUST NOT persist to startup automatically. Saving only
  happens when the caller explicitly asks AND a post-apply reachability check passes.
- Add an acknowledgement gate: `applyDevice(host, cred, edits, opts)` where
  `opts.acknowledge?: { allowRisky?: boolean; allowBlocked?: boolean }`. Before writing, classify;
  if any edit is `blocked` and `!allowBlocked` → refuse (return a failed ChangeSet, no SETs sent);
  if any is `risky` and `!allowRisky` → refuse likewise. Plain `safe` edits apply with no ack.
- After applying (running config), re-check reachability (re-read a trivial OID e.g. sysName).
  Surface `reachableAfter: boolean` on the result. Only if `reachableAfter` AND `opts.save` do we
  call the existing save path; otherwise skip save and report why.
- Keep the existing per-edit read-back verify + rollback-on-SET-error behaviour intact.

### Plan path

`planDevice` additionally reads topology (FDB+LLDP — read-only), derives the ProtectedSet, runs
`classifyEdits`, and attaches the `SafetyReport` to the returned `ChangeSet.safety`.

## Surfaces (owned by the surfaces agent — server.ts, web-bridge.js, main.cjs, preload.cjs, renderer/*)

- `/api/plan`, `switch:plan` IPC, `switch_plan` MCP tool: return the `ChangeSet` including
  `safety`. (Shapes already flow through; just surface the new field.)
- `/api/apply`, `switch:apply`, `switch_apply`: accept an `acknowledge` object and forward it to
  `applyDevice`. The MCP `switch_apply` description must state that risky/blocked edits require
  explicit acknowledgement.
- Save is a SEPARATE deliberate action (`/api/save` etc.) and must be disabled in the UI until an
  apply has succeeded and `reachableAfter` was true; label it "save to startup".
- Renderer (consumes `ChangeSet.safety`):
  - show each edit's class with a clear colour (safe=neutral/green, risky=amber, blocked=red) and
    its reason; show a one-line protected-set summary ("Management path: port 5, VLAN 1").
  - SIMPLE mode (Advanced off): the Apply button only applies when `worst === "safe"`; risky/blocked
    edits are shown but Apply is disabled with "Enable Advanced mode to apply".
  - ADVANCED mode: risky edits require a confirm checkbox ("this may disrupt the switch"); blocked
    edits require a typed confirmation (e.g. type the port name / "DISCONNECT") before Apply enables.
  - After a successful apply, surface a "Keep changes (save to startup)" action that is only
    enabled when the apply reported `reachableAfter: true`.
  - Reuse the existing Advanced-mode toggle from Phase 1.

While the engine lands in parallel, the surfaces agent develops the safety UI against a MOCK
`SafetyReport` fixture (one safe, one risky, one blocked edit) behind a clearly-commented flag,
and wires the real `safety` field + `acknowledge` plumbing so integration is flipping the flag.

## Hard constraints (both agents)

- ESM, explicit `.ts` import extensions; runs under `node --experimental-strip-types` → NO TS
  `enum`/`namespace`/parameter-properties.
- The classifier (`classifyEdits`) is PURE (no I/O) and must have thorough `node:test` coverage:
  every edit kind × protected/unprotected, the default-to-risky-on-unknown path, and `worst`.
  Add a test that a `blocked` edit set is refused by the apply gate without `allowBlocked` (can be
  tested by classification + gate logic without a live device).
- Do not weaken or bypass the existing verify/rollback. Do not auto-save. No new edit kinds.
- Engine agent edits only `packages/engine/**`; surfaces agent edits only the surface files listed
  above. Neither commits, pushes, or deploys.
