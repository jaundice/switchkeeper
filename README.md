# Switchkeeper

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Docker image](https://img.shields.io/badge/ghcr.io-jaundice%2Fswitchkeeper-2496ED?logo=docker&logoColor=white)](https://github.com/jaundice/switchkeeper/pkgs/container/switchkeeper)
[![CI](https://github.com/jaundice/switchkeeper/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/jaundice/switchkeeper/actions/workflows/docker-publish.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-339933?logo=node.js&logoColor=white)](https://nodejs.org)

**Switch-agnostic management for smart/managed switches over SNMP** — built to keep
perfectly good hardware out of landfill when its original (often Internet-Explorer-only)
web UI stops working in modern browsers.

Switchkeeper reads and edits the things you actually open a switch's web UI for — VLANs,
port VLAN membership, PVIDs, PoE, link aggregation, port labels — and writes them back
**transactionally** (plan → apply → verify, with rollback on mismatch). One codebase ships
as a desktop app, a self-hosted web app, and an MCP server for AI agents.

> ⚠️ **Project status: early (v0.1).** The engine, read path, and the standard 802.1Q write
> path are validated against a real Netgear GS748TP. Some write operations (save-config, LAG
> editing) are vendor-specific and not yet confirmed on all hardware — see
> [Supported hardware](#supported-hardware). Treat writes to production switches with care.

## Why

A managed switch can last 15+ years, but its management UI often can't. ActiveX controls,
`MSXML.selectNodes`, Java applets and Flash-era widgets simply don't run in current browsers,
which can leave a fully working switch effectively unconfigurable. Almost everything those
UIs did is also exposed over **SNMP** (the Q-BRIDGE, IF, BRIDGE, POWER-ETHERNET and LAG
MIBs). Switchkeeper talks to those standard MIBs, so one tool works across vendors instead of
one dead UI per box.

## Features

- **Read** a switch's full state: interfaces, VLANs, per-port PVID, 802.1Q tagged/untagged
  membership, PoE status, and link-aggregation groups.
- **Edit** safely: set PVID, toggle port admin up/down, enable/disable PoE, rename ports
  (ifAlias), and edit the full VLAN membership matrix — all staged as pending changes you
  review before applying.
- **Transactional writes**: every change set is planned, applied, then re-read and verified;
  membership writes roll back on mismatch. Guard rails refuse edits that would lock you out.
- **Discovery**: SNMP-sweep a subnet or range to find manageable switches.
- **SNMPv2c and SNMPv3** (auth/priv) throughout.
- **Vendor quirk profiles** keyed on SNMP enterprise number, so per-device behaviour
  (what's writable, how to save config) is data, not forks.
- **Three hosts, one engine**: Electron desktop app, a headless server that also serves a
  PWA web UI + REST API, and an **MCP server** so agents can manage switches.

## MIB-driven management

Beyond the standard slice (interfaces, VLANs, PoE, LAGs), Switchkeeper builds an
**adaptive capability model** of each switch: curated System/Ports/VLANs/PoE/LLDP
sections plus generic vendor sections assembled automatically from the device's **own
loaded MIBs**. Import your vendor's MIBs and anything those MIBs describe becomes
readable by name — and, in Advanced mode, editable with type-aware editors (enum
dropdowns, ranged numbers, BITS checkboxes, booleans) — without a hand-coded driver for
that vendor. A switch with no vendor MIBs loaded reads exactly as before.

Generic writes run through a **SafetyEngine** that detects your management path, refuses
edits that would lock you out (blocked) or risk disruption (risky) unless you explicitly
acknowledge them, applies to **running config only**, and never auto-persists to startup —
so a reboot recovers from a bad change. The same gate covers the MCP tools.

See **[docs/mib-driven-management.md](./docs/mib-driven-management.md)** for the full guide.

## Install

### Docker (server + web UI + MCP)

```bash
docker run -d --name switchkeeper -p 7341:7341 ghcr.io/jaundice/switchkeeper:latest
```

Then open <http://localhost:7341>. The same container serves the web UI, a REST API under
`/api/*`, and the MCP endpoint at `/mcp`. To install the UI as a PWA, front it with HTTPS
(see [`deploy/caddy-snmp.conf`](./deploy/caddy-snmp.conf) for an example reverse proxy).

> SNMP uses UDP/161. The container needs network reachability to your switches; on a
> segmented network run it where it can reach the management VLAN.

### Desktop app

Download the installer for your OS from the [Releases](https://github.com/jaundice/switchkeeper/releases)
page (`.exe` for Windows, `.dmg` for macOS, `.AppImage`/`.deb` for Linux). The desktop app is
fully self-contained — the engine is bundled in-process, so no separate Node install is needed.

### From source (development)

Requires **Node ≥ 22.18** (Switchkeeper runs `.ts` directly via Node's native type
stripping — no build step for tests or the server).

```bash
git clone https://github.com/jaundice/switchkeeper.git
cd switchkeeper
npm install
npm test                               # engine unit tests

# read-only probe of a live switch:
node packages/engine/src/cli.ts --host 192.168.1.10 --community public

# run the server (web UI + API + MCP) on :7341:
node packages/mcp/src/server.ts --http 7341

# launch the desktop app:
npm run start --workspace @switchkeeper/desktop
```

## Usage

1. Enter the switch IP and SNMP credentials (v2c community, or v3 user + auth/priv).
2. Click **Read switch** to load ports, VLANs, PoE and LAGs.
3. Edit inline — change a port's PVID, tick/untick VLAN membership cells (untagged vs
   tagged), assign a port to a LAG, toggle PoE. Changes stack up as **pending**.
4. Review the pending list and **Apply**. Switchkeeper writes, re-reads, and verifies.
5. If the device supports it, **Save config** persists the running config to startup.

To apply changes you must supply a **write community** (v2c) or a v3 user with write
access. Many switches also restrict SNMP writes to specific source IPs — run Switchkeeper
from an allowed host.

## MCP (AI agents)

The server exposes the engine as MCP tools (read, plan, apply, save, scan, interfaces) at
`/mcp` using the streamable-HTTP transport. Point an MCP-capable client at
`http://<host>:7341/mcp` to let an agent inspect and manage switches. Apply operations go
through the same plan→verify path as the UI.

## Supported hardware

Switchkeeper speaks **standard MIBs** (RFC 2674/4363 Q-BRIDGE, IF-MIB, BRIDGE-MIB,
RFC 3621 POWER-ETHERNET, IEEE 802.3ad LAG), so read and standard 802.1Q/PVID writes should
work on many SNMP-managed switches. Device-specific behaviour lives in
[`packages/engine/src/profiles.ts`](./packages/engine/src/profiles.ts).

| Device | Read | VLAN/PVID write | PoE | LAG read | Save config |
|---|---|---|---|---|---|
| Netgear GS748TP (reference) | ✅ | ✅ | ✅ | ✅ | ⚠️ vendor OID unconfirmed |

Adding a profile for your switch is the main way to contribute — see
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Architecture

```
packages/
  engine/    @switchkeeper/engine — pure TS core: data model, PortList codec,
             vendor profiles, SNMP transport, readState, transactional apply
  mcp/       headless server: web UI (PWA) + REST API + MCP endpoint
  desktop/   Electron host (engine bundled in-process; self-contained)
```

One engine, three thin hosts. The engine has no host dependencies; each host is a small
adapter over the same `readDevice` / `planDevice` / `applyDevice` / `saveDevice` API.

## Safety

Switchkeeper changes live network gear. It defaults to read-only, requires explicit write
credentials to apply anything, shows a plan before writing, verifies after writing, and
refuses changes that would remove the management path. Even so: test against a non-production
switch first, and keep a console/serial fallback.

## Contributing

Contributions — especially vendor profiles and hardware reports — are very welcome. See
[CONTRIBUTING.md](./CONTRIBUTING.md) and our [Code of Conduct](./CODE_OF_CONDUCT.md). For
security issues, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 jaundice and the Switchkeeper contributors.
