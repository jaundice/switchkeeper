# MIB-driven management

Switchkeeper reads and edits a switch through its **own MIBs**. Beyond the standard
slice it has always supported (interfaces, VLANs, PoE, LAGs), it now builds an
**adaptive capability model** of each device: the curated sections you expect, plus
generic vendor sections assembled automatically from whatever MIBs the device's own
vendor MIBs describe. Anything those MIBs define is readable by name — and, in
Advanced mode, editable — without a hand-coded driver for that vendor.

This guide covers reading a switch, importing vendor MIBs, Advanced mode, the
SafetyEngine that keeps you from locking yourself out, generic and per-cell editing,
the MCP tools, and the operational notes that matter when you write.

> Switchkeeper changes live network gear. It defaults to read-only, shows a plan
> before writing, verifies after writing, and refuses changes that would remove the
> management path. Test against a non-production switch first and keep a console or
> serial fallback.

## Discovering and reading a switch

1. **Discover** (optional). SNMP-sweep a subnet or range to find answering devices;
   each result reports its SNMP enterprise number and model. In the UI this is the
   scan box; over MCP it is `switch_discover`.
2. **Read.** Enter the switch IP and SNMP credentials (a v2c community, or a v3 user
   with auth/priv) and read the device. Switchkeeper probes it, reads its state
   (ports, VLANs, per-port PVID, 802.1Q tagged/untagged membership, PoE, LAGs) and —
   when you open the adaptive view — builds the full capability model below.

Reading is always read-only. No SNMP SET is ever sent on the read or capability path.

## The adaptive capability model

When you open the device's capability view, Switchkeeper returns a `CapabilityModel`:
the host, the matched vendor profile name (or `Unknown`), a count of loaded/indexed
MIBs, and an ordered list of **sections**. Sections come in two kinds.

### Curated sections

Hand-bound, cleanly-labelled views of the standard objects every compliant switch
exposes. A section is emitted **only if the device actually returns data for it**, so
a non-PoE switch simply has no PoE section. In display order:

- **System & Inventory** — sysName, model/description, firmware, base MAC, port count,
  vendor OID (whichever the device reports).
- **Ports** — one row per port: ifIndex, name, label, admin/oper status, speed, PVID,
  tagged VLANs.
- **VLANs** — one row per VLAN: VID, name, untagged and tagged member ports.
- **PoE** — only the ports the device reports as PoE-capable: admin on/off, status,
  class, watts.
- **LLDP / Topology** — discovered neighbours (local port, remote system name, port id,
  port description, chassis id), emitted only when the device reports neighbours.

A switch with **no vendor MIBs loaded** produces exactly these curated sections and
behaves just like earlier versions — there is no regression for unprofiled hardware.

### Generic vendor sections

Everything the device's **own loaded vendor MIBs** open up, with no per-vendor code:

- **Generic scalars** — one section per vendor MIB module, listing the readable scalar
  leaves of that module that actually returned a value. Objects the device doesn't
  implement are dropped; a module with nothing left produces no section. The sweep is
  bounded (a capped number of GETs in small batches) so a read stays fast and gentle
  on the switch.
- **Generic tables** — vendor table objects (per-port / per-row settings) that the
  standard provider list doesn't expose as individual columns. These are listed as
  **lazy stubs**: the capability read sends *no* SNMP for tables — it only lists each
  table's columns, per-column metadata, and an index note (e.g. `ifIndex`,
  `dot1qVlanIndex`, or `raw`). Rows load on demand when you open the table (see
  [Lazy table editing](#lazy-table-editing)). This keeps a capability read responsive
  even on a big switch with many large vendor tables.

Generic sections are scoped to the **device's own enterprise subtree** (and standard
modules are excluded), so they show that vendor's features rather than leaking unrelated
imported MIBs.

## Importing vendor MIBs

The generic sections are bounded by what the device's loaded MIBs describe. To get
named, type-aware objects for your vendor, import its MIBs:

1. **Find the MIBs.** Switchkeeper gives you download pointers for the vendor based on
   the switch's SNMP enterprise number (and optionally its sysDescr) — official links
   plus a search fallback. In the UI this is built into the MIB import flow; over MCP
   it is `switch_mib_pointers`. Switchkeeper does **not** auto-download MIBs; you upload
   the files.
2. **Import the files.** Upload the vendor's `.mib`/`.txt` files. They are saved to the
   server's MIB directory.
3. **Indexing happens in the background.** Parsing a large vendor MIB set is CPU-heavy,
   so Switchkeeper never parses on the request path. After an import it rebuilds the MIB
   cache in a separate process while the server stays responsive. Poll the MIB status to
   see when indexing is `ready`. Until then, capability reads still work — they return
   the curated/standard view with an "indexing" hint and pick up the new vendor sections
   once the cache is built.

The bundled standard IETF/IEEE MIBs (IF-MIB, BRIDGE-MIB, Q-BRIDGE-MIB, POWER-ETHERNET,
LLDP, LAG, etc.) are always available as the resolution baseline; vendor MIBs add
coverage on top.

## Advanced mode

Switchkeeper is **approachable by default**. Simple mode (Advanced **off**) shows
everything in read-only curated sections plus a small allowlist of `safe` edits — a
non-sysadmin can see status and do routine tasks (rename a port, set an access-port's
VLAN/PoE) without ever seeing a risky control.

**Advanced mode** is an explicit, off-by-default, per-session toggle that is visually
flagged when on. It gates the things that can hurt you:

- the **generic object browser** (the generic scalar/table sections);
- **generic writes** — setting arbitrary vendor objects and editing table cells.

The gate exists because generic writes are inherently less constrained than curated
edits — Switchkeeper can't reason about an arbitrary vendor object's effect the way it
can about "set this port's PVID". Advanced mode makes opting into that explicit, and
the SafetyEngine still applies on top (a generic write is never treated as `safe`).

## The SafetyEngine

The SafetyEngine exists to make it **hard to lock yourself out**. On every plan and
apply it does two things, both read-only and auditable.

### Management-path detection (the protected set)

Before any write, Switchkeeper derives the path it uses to reach the switch and pins it
as a **protected set** of bridge ports and management VLAN(s):

- **FDB pin (strongest signal).** If the management station's MAC is known and present
  in the forwarding database, the bridge port behind it is the management access port —
  confidence `high`.
- **Uplink ports.** A bridge port with many distinct learned MACs (the default
  threshold is 4), or one whose LLDP neighbour looks like a switch/router, is treated as
  carrying management.
- **Conservative fallback.** If nothing can be pinned, Switchkeeper protects every
  multi-MAC port — or, failing that, every bridge port — at confidence `low`. It would
  rather over-protect than strand you.
- **Management VLAN.** The PVID/untagged VLAN of the pinned management port, an operator
  override, the most common PVID, or VLAN 1 as the last resort — confidence drops as it
  falls down that list.

The overriding principle is **default to the safe side**: when the path or an edit's
effect is uncertain, classify *up*, never down. The protected set is never returned
empty with high confidence.

### Write classification: safe, risky, blocked

Every planned edit is tagged against the protected set:

- **`safe`** — does not touch the protected set. Examples: relabelling a port, enabling
  PoE, bringing a port up, editing a non-management VLAN, setting an access port's PVID.
  Safe edits apply with no acknowledgement.
- **`risky`** — may disrupt the switch but isn't a clear lockout. Examples: changing the
  tagging of a protected port on a non-management VLAN, LAG changes on a management port,
  disabling PoE on a management port, deleting a non-management VLAN, or any edit whose
  target can't be resolved in the read state (uncertain → risky). **Every generic
  `setObject` write is at least `risky`** — it is never `safe`. Risky edits are refused
  unless you acknowledge them (`allowRisky`).
- **`blocked`** — would sever or re-administer the management path. Examples: disabling
  the management port, moving the management port's PVID off a management VLAN, dropping
  a management port from the management VLAN's egress, deleting the management VLAN, or a
  generic write that lands on a protected row/port/VLAN or in a dangerous subtree (see
  below). Blocked edits are refused unless you explicitly acknowledge them
  (`allowBlocked`), and in Simple mode they cannot be applied at all.

For generic writes, an auditable list of **dangerous OID subtrees** is always `blocked`:
IP configuration (addresses, routing, ARP), the SNMP protocol group, the whole SNMP
modules subtree (engine/framework and the credential/admin tables — USM users/keys,
VACM access control, v1/v2c communities, target/notification tables), and `ifAdminStatus`
(disabling an interface out from under you). When a generic write targets a table cell,
Switchkeeper decodes the cell's row back to a port/VLAN and protects the management path
exactly as it does for curated per-port/per-VLAN edits — a write to a protected row is
blocked; an undecodable row stays risky.

### How writes apply: running-only, no auto-save

- **Always dry-run first.** Plan shows the full diff and each edit's classification before
  anything is written.
- **Acknowledgement gate.** The apply path classifies first and refuses to send any SET if
  a `blocked` edit lacks `allowBlocked`, or a `risky` edit lacks `allowRisky`. Plain `safe`
  edits need no acknowledgement.
- **Read-back verify + rollback.** Each write is re-read and verified; membership writes
  roll back on mismatch. This existing behaviour is unchanged.
- **Reachability re-check.** After applying to running config, Switchkeeper re-reads a
  trivial OID (e.g. sysName) and reports `reachableAfter`.
- **Nothing auto-persists to startup.** Writes apply to **running config only**. Saving to
  startup is a separate, deliberate action ("save to startup") that is disabled until an
  apply has succeeded *and* `reachableAfter` was true. So if a change does sever
  connectivity, it was never persisted — **a reboot recovers the switch.**

In Simple mode the Apply button only applies when the whole change set is `safe`; risky and
blocked edits are shown but Apply stays disabled with a prompt to enable Advanced mode. In
Advanced mode, risky edits require a confirm checkbox and blocked edits require a typed
confirmation before Apply enables.

## Generic object editing (type-aware editors)

In Advanced mode, every `read-write` object in a generic section gets an **Edit**
affordance. Switchkeeper fetches that object's MIB SYNTAX and builds the right widget:

- **enum** (e.g. `INTEGER { up(1), down(2) }`) → a dropdown of the named values;
- **boolean** (`TruthValue`) → a toggle;
- **integer with a range** → a number input bounded to min/max; plain integer/unsigned →
  a number input;
- **BITS** → one checkbox per named bit; the selected bit positions are encoded into the
  SNMP octet string on apply;
- **string** → a text input (respecting the OCTET STRING size range where defined);
- units and the MIB description are shown as helper text.

Read-only objects render as values, never inputs. If the MIB SYNTAX can't be parsed,
the editor falls back to free text. **Review** runs a dry-run plan so the SafetyEngine
classifies the write (a generic write is risky, or blocked if it targets a protected
row or dangerous subtree), then routes into the same gating UI as every other edit, and
Apply sends the change through the standard plan → verify → rollback path. Nothing
auto-saves.

## Lazy table editing

Generic vendor tables arrive as lazy stubs (header columns + an index note, no rows).
When you expand a table, Switchkeeper walks **just that one table's** columns on demand
(bounded by a wall-clock budget, read-only) and renders the rows. Loaded rows are cached
for the session so re-expanding doesn't re-fetch.

A cell is editable only when its column's metadata says `read-write`. Editing a cell
opens the per-cell editor (the same type-aware widgets above), stages a `setObject` whose
OID is the column base plus the row's instance suffix, and runs the standard dry-run →
gating → apply flow. Because the SafetyEngine decodes the row back to its port/VLAN, a
cell write on the management path is blocked just like a curated edit.

## MCP tools

The server exposes the engine as MCP tools (streamable-HTTP at `/mcp`, or stdio for a
local agent). All writes go through the **same SafetyEngine gate** as the UI — an agent
cannot be tricked into severing management connectivity.

| Tool | What it does |
|---|---|
| `switch_list_interfaces` | List this host's network interfaces/subnets (to pick a scan range). |
| `switch_discover` | SNMP-sweep a subnet/CIDR; returns answering devices with vendor enterprise no. + model. |
| `switch_read` | Read a switch's full state: ports, VLANs, PVIDs, PoE, LAGs, capabilities. |
| `switch_capabilities` | Read the adaptive capability model (curated sections + generic vendor sections). Read-only; no SETs. |
| `switch_table` | Load the rows of one generic vendor table on demand (capability model lists tables as lazy stubs). Read-only; no SETs. |
| `switch_plan` | Dry-run: diff edits against the live switch with safety classification (`changeSet.safety`). No writes. |
| `switch_apply` | Apply edits with read-back verify + rollback. Requires a write community. Risky/blocked edits require `acknowledge:{allowRisky}` / `acknowledge:{allowBlocked}`; `save=true` persists after a reachable apply. |
| `switch_set_object` | Set one writable vendor object by instance OID. Safety-gated like any write — never `safe`, IP/SNMP/admin subtrees `blocked` — risky/blocked require `acknowledge`. Nothing auto-saves. |
| `switch_save` | Persist running config to startup (vendor-specific; may be unsupported on some models). |
| `switch_mib_pointers` | Where to download a vendor's MIB, given its SNMP enterprise number (and optionally sysDescr). |
| `switch_topology` | Read LLDP neighbours and the forwarding database (MAC → port), for uplink/trunk discovery. |

The usual agent flow is: `switch_capabilities` to see what the device exposes,
`switch_table` to load a table's rows, `switch_plan` to see each edit's safety class,
then `switch_apply` / `switch_set_object` with the appropriate `acknowledge`.

## Operational notes

- **Writes need two things.** A **write community** (v2c) or a v3 user with write access,
  **and** the switch's own SNMP source-permit allowing your host's IP. Many switches
  restrict SNMP writes to specific source IPs — run Switchkeeper from an allowed host or
  reads will work while writes silently fail.
- **Saving to startup is deliberate.** It only becomes available after a successful,
  reachable apply, and it is vendor-specific (some models don't expose a save-config OID
  over SNMP — see the supported-hardware notes in the README).
- **Rollback-timer guidance.** The baseline safety guarantee is **running-only +
  reboot-recovers**: a bad change is never persisted to startup until you confirm the
  switch is still reachable, so a power-cycle undoes it. A *vendor rollback/commit timer*
  (arm-before-write, auto-revert-if-not-confirmed) is an **optional future hook** — the
  framework exists as a no-op extension point but no vendor values ship, because no
  switch here is known to support a standard SNMP rollback timer. Do not rely on a vendor
  rollback timer; rely on running-only + reboot, and keep a console/serial fallback for
  any change you can't verify remotely.
