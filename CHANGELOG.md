# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
