# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.2] - 2026-06-29

Stability hotfix plus browser-side credential convenience.

### Fixed

- **GETBULK walk crash**: a bulk PDU could carry a varbind with no/undefined OID; treating it as a
  string threw from inside net-snmp's socket callback (outside the Promise scope), crashing the
  whole MCP/web process and crash-looping the service — surfacing in the browser as
  "Unexpected end of JSON input" (an empty body from the cut request). The walk now type-checks the
  OID, wraps the callback in try/catch (falling back to the GETNEXT walk on failure), and the server
  installs `uncaughtException`/`unhandledRejection` guards so a stray transport error logs instead
  of killing the host.
- **Resilient bridge parsing**: the web UI reads the response body as text and parses defensively, so
  an empty/timed-out/non-JSON response shows a clear "server may be busy/unreachable" message rather
  than a raw JSON-parse exception.

### Added

- **Remembered credentials (browser)**: the web/desktop UI caches SNMP credentials per host in
  `localStorage` and prefills them when you return to a host, with a "Remember credentials" opt-out
  (default on) that clears a host's stored entry when unchecked. Community strings/v3 keys are stored
  in plaintext as a convenience for a trusted-LAN tool; the opt-out is there for shared machines.

## [0.4.1] - 2026-06-29

Polish on the MIB-driven feature set.

### Added

- **BITS editing**: BITS objects parse into named-bit checkboxes (one per bit position); selections
  encode to the SNMP octet string and go through the normal safety-gated write path.
- **Change history**: an in-session log of applied change-sets (edit, old→new, classification, result).
- **Snapshot/export**: download the current capability model (curated + scalars + loaded tables) as JSON.
- **Tooltips + search**: MIB description/units surface as tooltips on read-only displays, and a
  filter box narrows the generic sections on a busy device.
- **Rollback-timer hook**: an optional, inert `VendorProfile.commitConfirm` extension point (no
  vendor values ship) for hardware that supports an SNMP arm/confirm rollback.
- **Mock-device integration test** covering the live capability/plan path without hardware.

### Changed

- **Faster table loads**: on-demand table reads use SNMP GETBULK (with a GETNEXT fallback), cutting
  round-trips on big per-port tables.
- **Wider safe cell editing**: the row decoder maps more INDEX shapes (bridge-port, leading
  ifIndex/VLAN with trailing parts) back to a port/VLAN, so more per-row writes are precisely
  classified by the SafetyEngine.

## [0.4.0] - 2026-06-29

MIB-driven device model and adaptive UI — read and (safely) manage whatever a switch's own
MIBs expose, on top of the standard core, across both the web/MCP server and the desktop app.

### Added

- **Adaptive capability model** (`readDeviceCapabilities`): curated sections (System/Ports/VLANs/
  PoE/LLDP) plus generic sections built from the device's loaded vendor MIBs, so each switch shows
  exactly the objects its MIBs describe — no hand-coded per-vendor OIDs. Exposed at
  `POST /api/capabilities`, `switch:capabilities` (IPC), and the `switch_capabilities` MCP tool.
- **Object resolver** (`createObjectResolver`): resolves a symbol to its OID/type/access via
  device MIBs → standard `oids.ts` → vendor profile, falling back cleanly when no MIBs are loaded.
- **SafetyEngine** (`detectProtectedSet` + `classifyEdits`): detects the management path (FDB-pinned
  via the local source MAC when L2-adjacent, else uplink heuristic) and classifies every edit
  safe/risky/blocked. Writes never auto-persist to startup; `applyDevice` re-checks reachability and
  refuses risky/blocked edits without explicit acknowledgement.
- **Generic writes with type-aware editors** (`describeObject` + `setObject`): parses an object's MIB
  SYNTAX (enums, ranges, SIZE, TEXTUAL-CONVENTIONs, MAX-ACCESS, DESCRIPTION) to drive the right editor
  widget; `POST /api/object-meta` + `switch_set_object`. Generic writes are never classified safe and
  are blocked in IP/SNMP/credential subtrees.
- **Columnar / table objects** (`enumerateModule` + `buildRowDecoder`): surfaces table columns that
  net-snmp's providers omit; per-cell editing is gated by mapping a row's index back to a port/VLAN so
  a cell write to the management row is blocked. Tables load lazily — `readDeviceCapabilities` lists
  table stubs and `readTable` / `POST /api/table` / `switch_table` fetch a table's rows on demand.
- **Type-aware editor UI + Advanced mode**: an off-by-default, visually-flagged Advanced mode gates
  risky/generic writes; per-object and per-cell editors with dry-run plan → safety review → apply.

### Changed

- MIB loading is robust to parser-poisoning vendor MIBs, runs the cold parse in a background process,
  caches the distilled symbol→OID map (and module→file map) to disk, and uses true topological load
  order — a large vendor set goes from a multi-minute, server-blocking parse to instant warm loads.

## [0.3.0] - 2026-06-29

### Added

- **Server-side MIB management**: upload vendor MIBs to the running server (`POST /api/mib-import`),
  query load state (`GET /api/mib-status`, now reporting `{ready, building}`), with uploads
  persisted in `MIB_DIR`. MIBs are indexed by their module header, so files without `.mib`/`.my`
  extensions load fine.
- **Bundled standard MIBs**: 16 redistributable IETF/IEEE MIBs ship as the resolution base so a
  single-file vendor upload resolves its standard imports; bundled into the desktop build too.

### Changed

- **Robust MIB loading**: a directory load now quarantines the MIBs that poison net-snmp's
  ModuleStore parser (which previously let one bad file zero out the entire set) and loads the
  maximum healthy set instead. Poison discovery walks the modules in true topological order
  (dependencies first) to avoid false-positive cascades, the parse runs in a separate process so
  the server never blocks, and the distilled symbol→OID map is cached to disk (keyed on a file
  signature) so restarts load in ~seconds with no re-parsing. The quarantine list is written
  incrementally so an interrupted build resumes.

### Fixed

- **Apply verify/rollback**: `createVlan`/`deleteVlan` are now verified against the Q-BRIDGE
  *static* table (the old code compared the RowStatus read-back to `createAndGo`, which never
  matched and made every create/delete falsely "fail"). A SET the device accepts is never
  rolled back, and a batch is no longer aborted by a read-back miss (e.g. an empty VLAN absent
  from the *current* table). Rollback fires only on a genuine SNMP SET error, with correct
  semantic inverses for create/delete.

### Added

- **Save running config** for Netgear/Marvell smart switches via the RADLAN-COPY-MIB `rlCopy`
  table (running → startup). `switch_save` now attempts it (was previously unsupported).
- **Topology reads**: LLDP neighbours and the forwarding database (MAC → port) via
  `readTopology`, the `switch_topology` MCP tool, and `POST /api/topology` — for uplink/trunk
  discovery.
- **Extreme Networks (EXOS, enterprise 1916)** vendor profile (VLAN create/membership writes).
- **LAG-read fallback** using `dot3adAggPortAttachedAggID` for switches that don't populate the
  aggregator PortList.

## [0.2.0] - 2026-06-23

### Added

- **MIB loader**: import vendor MIB files (net-snmp ModuleStore with topological
  import-closure resolution) so Switchkeeper can resolve a device's OID names without
  bundling vendor MIBs. New engine API: `createMibStore()`, `mibPointersFor()`.
- **MIB download pointers**: the device header now shows where to download the vendor
  MIB for the connected switch (curated official links keyed on SNMP enterprise number,
  with a universal search fallback). Exposed over the web API (`/api/mib-pointers`) and
  as the `switch_mib_pointers` MCP tool.

## [0.1.0] - 2026-06-21

First public release.

### Added

- **Engine** (`@switchkeeper/engine`): switch-agnostic SNMP core — data model, IETF PortList
  codec (verified against real Netgear GS748TP bytes), vendor quirk profiles keyed on SNMP
  enterprise number, SNMPv2c + SNMPv3 transport, and `readState` device assembly.
- **Read path**: interfaces, VLANs, per-port PVID, 802.1Q tagged/untagged membership matrix,
  PoE status (RFC 3621), and link-aggregation groups (IEEE 802.3ad).
- **Transactional write path**: `planDevice` → `applyDevice` → verify with rollback on
  membership mismatch, plus lockout/up-port/capability guard rails.
- **Discovery**: subnet/range SNMP sweep with a `scan` CLI.
- **Desktop app** (Electron): self-contained, engine bundled in-process; inline editing of
  PVID, VLAN membership, PoE, port labels, and LAG assignment with sticky-header grids.
- **Server**: headless host serving the web UI (installable PWA), a REST API (`/api/*`), and
  an **MCP** endpoint (`/mcp`) so AI agents can manage switches.
- **CI**: multi-arch Docker image published to GHCR; Electron installers built for Windows,
  macOS, and Linux on tagged releases.

### Notes

- Reference hardware: Netgear GS748TP. Vendor save-config and LAG-edit OIDs for that device
  are not yet confirmed and are gated off by its profile.
