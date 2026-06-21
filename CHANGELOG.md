# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
