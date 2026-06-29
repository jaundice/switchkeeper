# Spec: MIB-driven device model & adaptive UI

Status: draft · Target: v0.4 → v0.5 · Author: jaundice (with Claude)

## Problem statement

Switchkeeper reads and writes a fixed set of standard objects (`oids.ts`) plus a
handful of hand-coded vendor quirk profiles (`profiles.ts`). Everything vendor-specific —
PoE detail, environmental sensors, stacking, inventory, vendor QoS, ACLs — is invisible to
the app, and supporting a new vendor means a developer hand-coding OIDs. The MIB loader now
resolves a device's own vendor MIBs to a symbol→OID map (`findOid`/`providers`), but nothing
consumes it yet. The result: users (including non-sysadmins) can only see and manage a thin
standard slice of their switch, and the write path has no guard against the classic foot-gun —
changing the wrong port/VLAN and cutting your own management connection.

## Goals

1. **Vendor coverage without code.** Anything a connected switch's loaded MIBs describe is
   readable and displayable by name — coverage is bounded by what the device's MIBs define,
   not by Switchkeeper's profile table.
2. **Graceful degradation.** A switch with no MIBs loaded behaves exactly as today (standard
   MIB experience). No regression for unprofiled/unknown vendors.
3. **Approachable by default.** A non-sysadmin can see status and do common tasks (rename a
   port, set a port's VLAN/PoE) without ever seeing advanced controls. Advanced and generic
   writes live behind a deliberate "Advanced mode".
4. **Hard to lock yourself out.** Every write that could sever the management path is detected,
   flagged, and blocked by default; risky changes never persist to startup until the user
   confirms the switch is still reachable.
5. **One engine, both surfaces.** The same resolver + capability model + safety engine drives
   the web/MCP server and the desktop app.

## Non-goals

- **Raw OID walker for objects with no MIB loaded.** We surface only what loaded MIBs describe;
  we are not building a generic SNMP browser over numeric OIDs. (Possible v2.)
- **Modeling arbitrary multi-row table creation.** v1 generic writes target scalar SETs and
  simple table-cell SETs (e.g. set one column of an existing row). Complex row creation beyond
  the existing VLAN path is out of scope.
- **Editing IP / SNMP-engine / credential config from the simple UI.** Always advanced, heavily
  guarded, and possibly never auto-applied — these are the highest lockout risk.
- **Multi-switch orchestration / config templates across devices.** Separate initiative.
- **Auto-downloading vendor MIBs.** We already provide download pointers; the user uploads files.

## Users & stories

### Operator (non-sysadmin — the default audience)

- As an operator, I want to open a switch and see its real status — ports, VLANs, PoE draw,
  temperature, model/serial/firmware — laid out in plain sections, so I understand the device
  without knowing SNMP.
- As an operator, I want to rename a port and turn PoE on/off for a non-uplink port, so I can do
  routine changes safely without touching anything that could break the network.
- As an operator, I want the app to stop me (not just warn) before I change the port or VLAN that
  I'm connected through, so I can't accidentally disconnect the switch.

### Power user / network admin (Advanced mode)

- As an admin, I want to enable Advanced mode to see every object the switch's MIBs expose,
  grouped sensibly, so I can inspect and tune vendor features.
- As an admin, I want to set any writable vendor object with a type-aware editor (enum dropdown,
  range-checked number), preview the change as a dry-run, and have it read-back verified, so
  edits are correct and reversible.
- As an admin, I want changes to stay in running config until I explicitly confirm connectivity,
  so a bad change is undone by a reboot rather than persisted.

### Agent (MCP)

- As an agent, I want to query a device's capability model (which categories/objects it supports)
  and read any named object, so I can answer questions without pre-mapped OIDs.
- As an agent, I want generic writes to be gated behind the same safety checks as the UI, so I
  can't be tricked into severing management connectivity.

## Design overview

Three new engine concerns, then UI binding.

```
device MIBs (loaded)  ─┐
standard OIDs (oids.ts)├─►  ObjectResolver  ─►  CapabilityModel  ─►  UI section registry
vendor profiles ───────┘     (name→OID,            (what this          (curated renderers
                              type, access)         device exposes)      + generic catch-all)
                                                          │
                                                   SafetyEngine (mgmt-path guard, commit-confirm)
```

### 1. ObjectResolver (engine)

A single place that answers "what is the OID, type, and access for this object on this device?"
Resolution order:

1. **Device MIBs** — `mibStore.findOid(name)` against the device's loaded vendor MIBs.
2. **Standard** — `oids.ts` (the generic baseline that works on any compliant switch).
3. **Vendor profile** — `profiles.ts` overrides (write paths, save method) still win where set.

Each resolved object carries metadata from the MIB: `oid`, `scalarType` (SYNTAX), `maxAccess`
(read-only vs read-write — already exposed by net-snmp's providers), enum value→label and
numeric ranges where the MIB defines them, and the textual description if available. This
metadata is what makes type-aware editors and read/write gating possible.

### 2. CapabilityModel (engine)

Built per device at read time: probe which logical categories are actually populated and which
extra vendor objects exist. Output is a structured manifest the UI consumes — e.g. `{ system,
ports, vlans, poe?, sensors?, stacking?, lldp?, lag?, vendorExtras: [...] }`. A category appears
only if the device returns data for it. This is the "dynamically build UI sections from the
possibilities the MIBs open" mechanism.

### 3. SafetyEngine (engine) — connectivity guard

The heart of "don't let users lock themselves out". On every plan/apply:

- **Management-path detection.** Derive the path the app uses to reach the switch: the source
  station's MAC → which bridge port it's behind (forwarding DB, already read by `readTopology`),
  the management VLAN, the switch's management IP interface, and the SNMP transport itself.
  Cache it as the device's "protected set" (ports, VLANs, the SNMP/IP config objects).
- **Pre-flight classification.** Every edit is tagged `safe` / `risky` / `blocked`:
  - `blocked` (refuse unless Advanced + explicit typed confirmation): admin-down of the
    management/uplink port; removing the management VLAN's egress/untagged on the uplink;
    changing PVID of the management port; any SET to IP / SNMP / credential objects; disabling SNMP.
  - `risky` (extra "this may disconnect you" confirm + connectivity re-check after): changes to
    uplink ports, trunk VLAN membership, speed/duplex on the uplink, LAG membership carrying the
    mgmt path.
  - `safe`: everything not touching the protected set (port descriptions, PoE on non-uplink
    ports, VLAN membership on access ports, etc.).
- **Commit-confirm + no-auto-save.** Writes apply to *running* config only. After a `risky`
  apply, the engine re-checks reachability within N seconds; nothing is written to *startup*
  until the user clicks "keep changes" (and, where the vendor supports a rollback/commit timer,
  arm it). If connectivity is lost, the change was never persisted, so a power-cycle recovers.
- **Always dry-run first.** The existing plan→apply→read-back-verify→rollback flow stays; the
  safety classification is layered on top of the plan.

### 4. UI: hybrid adaptive sections + Advanced mode

- **Curated category renderers** bind known categories to a clean, labelled view: System &
  Inventory, Ports, VLANs, PoE, Sensors/Environment, LLDP/Topology, Stacking/LAG. Each renders
  only if the CapabilityModel says the device has it.
- **Generic catch-all** ("All objects", Advanced only): auto-renders remaining readable scalars
  and tables, grouped by MIB module, using the MIB metadata for labels/types. This is where
  "everything the MIBs open up" shows through without bespoke code.
- **Advanced mode** is an explicit, off-by-default toggle. Simple mode = read everything in
  curated sections + a small allowlist of `safe` edits. Advanced mode = the generic object
  browser + generic writes (still subject to the SafetyEngine). The mode is visually obvious
  (banner/badge) and per-session.
- **Type-aware editors** generated from MIB SYNTAX: enums → dropdown, integer with range →
  bounded number, truth-value → toggle, string → text. Read-only objects render as values, never
  inputs.

## Requirements

### Must-have (P0)

1. **ObjectResolver with fallback.** Resolve name→{oid,type,access} via device MIBs → standard →
   profile.
   - Given a device with MIBs loaded, when the engine needs an object by name, then it returns the
     device-MIB OID + metadata.
   - Given a device with no MIBs, when the engine needs a standard object, then it returns the
     `oids.ts` OID and the app behaves exactly as v0.3.
2. **CapabilityModel drives sections.** UI shows a category only when the device returns data for it.
   - Given a switch with no PoE objects, then no PoE section renders.
   - Given a switch exposing vendor sensor objects, then a Sensors section renders with those values.
3. **Read-only display of resolved objects** in curated sections + a generic catch-all, with
   human-readable labels from the MIBs.
4. **Management-path detection + write classification.** Every planned edit is tagged
   safe/risky/blocked relative to the protected set.
   - Given the app reaches the switch via port 5 / VLAN 1, when a plan would admin-down port 5 or
     strip VLAN 1 from the uplink, then it is `blocked` and not applied without advanced + typed ack.
5. **No auto-save-to-startup; commit-confirm on risky writes.**
   - Given a `risky` change is applied, when the user does not confirm within the timeout, then
     running-config holds but startup is untouched (reboot recovers).
6. **Advanced-mode gate.** Generic writes and the generic object browser are unavailable until the
   user turns on Advanced mode; simple mode exposes only the `safe` edit allowlist.
7. **Type-aware, dry-run, read-back-verified writes** for generic objects (scalars + simple
   table cells), reusing the existing plan/apply/verify/rollback path.
8. **Parity across web/MCP and desktop** — shared engine; MCP generic read/write tools honor the
   same SafetyEngine.

### Nice-to-have (P1)

- Per-object description tooltips from the MIB.
- "What changed" diff view across a session.
- Search/filter in the generic object browser.
- Remember Advanced-mode preference per device.
- Snapshot/export the full read model (JSON) for backup/diffing.

### Future considerations (P2)

- Vendor rollback/commit-timer integration where the hardware supports it.
- Numeric-OID browser for objects with no MIB loaded.
- Cross-device config templates and bulk apply.
- Write modeling for complex multi-row tables.

## Connectivity-safety suggestions (answering "any suggestions?")

These are the specific guardrails I'd build, in priority order:

1. **Detect and pin the management path before any write** (FDB lookup of our own MAC + mgmt
   VLAN + mgmt IP interface). Everything else keys off this "protected set".
2. **Block, don't just warn**, on edits to the protected set; require Advanced mode *and* a typed
   confirmation (e.g. type the port name) for those.
3. **Running-config-only by default; never auto-save to startup.** Make "save to startup" a
   separate, deliberate action that's disabled until a post-change connectivity check passes.
4. **Post-apply connectivity canary** with auto-revert of unsaved changes if the switch goes
   unreachable (and arm a vendor rollback timer when available).
5. **Default to read-only / simple mode**; advanced writes are opt-in per session and visually
   flagged, so a casual user can't stumble into a risky SET.
6. **Always dry-run** (already the default) and show the safety classification inline in the plan.

## Success metrics

- **Read coverage**: objects displayed ÷ objects the device's MIBs expose (target: ~100% of
  readable objects appear somewhere — curated or generic).
- **Vendors usable without a hand-coded profile** (target: any switch whose MIBs load is fully
  *readable*; writes work wherever standard/MIB SYNTAX allows).
- **Accidental-lockout incidents: 0** (no change that severs the mgmt path is ever persisted
  without explicit, informed confirmation).
- **Non-admin task completion**: a non-sysadmin can complete "see status" and "rename a port /
  set access-port VLAN" without entering Advanced mode.
- **No regression**: a MIB-less switch reads identically to v0.3.

## Open questions

- **Descriptions/enums from the store** (engineering): does net-snmp's ModuleStore expose
  DESCRIPTION and enum/range constraints via `getProvidersForModule`, or do we need light MIB
  text parsing to populate editor metadata? Spike needed.
- **Reliable mgmt-path detection** (engineering): FDB-of-our-MAC is the strongest signal, but
  confirm it works when the app talks to the switch through an uplink/L3 hop; fall back to mgmt
  IP interface + VLAN when the MAC isn't local.
- **Commit-confirm without vendor rollback timers** (engineering): most smart switches lack a
  native rollback timer; is "running-only + don't save + reboot recovers" sufficient as the
  baseline guarantee? (Proposed: yes for v1.)
- **MCP generic-write surface** (design): how to expose generic writes to agents while keeping the
  SafetyEngine authoritative — likely a single `switch_set_object` tool that always plans + checks.
- **Generic table writes** (engineering): scope of "simple table-cell SET" — which tables, how to
  address the row/index safely.

## Timeline / phasing

The chosen v1 scope is read + generic writes, hybrid UI, both surfaces — delivered in phases so
the safe foundation ships first:

- **Phase 1 — Read & adapt (no writes).** ObjectResolver + fallback, CapabilityModel, curated
  sections + generic read-only catch-all, both surfaces. Ships value immediately, zero write risk.
- **Phase 2 — Safety + Advanced gate.** Management-path detection, write classification,
  commit-confirm/no-auto-save, Advanced-mode toggle, the `safe` edit allowlist for simple mode.
- **Phase 3 — Generic writes.** Type-aware editors from MIB SYNTAX, generic object SET through
  plan/verify/rollback under the SafetyEngine; MCP `switch_set_object`.
- **Phase 4 — Polish.** Descriptions/tooltips, diff view, search, snapshot/export, vendor
  rollback-timer integration where available.

Dependency: Phases 2 and 3 depend on Phase 1's resolver + capability model. Safety (Phase 2)
must land before generic writes (Phase 3) are exposed.
