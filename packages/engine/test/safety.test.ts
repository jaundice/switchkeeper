import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectProtectedSet,
  classifyEdits,
  gateDecision,
  worstOf,
} from "../src/safety.ts";
import type {
  DeviceState,
  ProtectedSet,
  Edit,
  FdbEntry,
  LldpNeighbor,
} from "../src/model.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A small device: bridgePort === ifIndex for ports 1,5,49 — except port 5 whose ifIndex is 105
// (so we exercise the ifIndex->bridgePort resolution in setPortAdmin).
function state(): DeviceState {
  return {
    device: { id: "d", host: "d", transport: "snmpV2c", reachable: true },
    ports: [
      { ifIndex: 1, bridgePort: 1, name: "g1", kind: "physical", adminStatus: "up", operStatus: "up", pvid: 1, taggedVlans: [] },
      { ifIndex: 105, bridgePort: 5, name: "g5", kind: "physical", adminStatus: "up", operStatus: "up", pvid: 1, taggedVlans: [] },
      { ifIndex: 49, bridgePort: 49, name: "g49", kind: "physical", adminStatus: "up", operStatus: "up", pvid: 1, taggedVlans: [10] },
    ],
    vlans: [
      { vid: 1, name: "default", members: { tagged: [49], untagged: [1, 5] }, active: true, source: "current" },
      { vid: 10, name: "Voice", members: { tagged: [49], untagged: [] }, active: true, source: "current" },
    ],
    lags: [],
    readAt: new Date().toISOString(),
  };
}

// Protected set used for the classifier tests: mgmt access port 5 + uplink 49, mgmt VLAN 1.
function pset(): ProtectedSet {
  return { ports: [5, 49], vlans: [1], reason: "fixture", confidence: "high" };
}

function only(edit: Edit): { cls: string; reason: string } {
  const r = classifyEdits([edit], state(), pset());
  return { cls: r.classifications[0].cls, reason: r.classifications[0].reason };
}

// ---------------------------------------------------------------------------
// classifyEdits — every edit kind, protected + unprotected
// ---------------------------------------------------------------------------

test("setPortAdmin up:false on a protected port (via ifIndex->bridgePort) -> blocked", () => {
  // ifIndex 105 maps to bridgePort 5, which is protected.
  assert.equal(only({ kind: "setPortAdmin", ifIndex: 105, up: false }).cls, "blocked");
});

test("setPortAdmin up:false on an unprotected port -> safe", () => {
  assert.equal(only({ kind: "setPortAdmin", ifIndex: 1, up: false }).cls, "safe");
});

test("setPortAdmin up:true is always safe", () => {
  assert.equal(only({ kind: "setPortAdmin", ifIndex: 105, up: true }).cls, "safe");
});

test("setPortAdmin up:false with an unresolvable ifIndex -> risky (uncertain)", () => {
  assert.equal(only({ kind: "setPortAdmin", ifIndex: 9999, up: false }).cls, "risky");
});

test("setPvid: protected port moved OFF a mgmt VLAN -> blocked", () => {
  assert.equal(only({ kind: "setPvid", bridgePort: 5, vid: 20 }).cls, "blocked");
});

test("setPvid: protected port set TO a mgmt VLAN -> safe", () => {
  assert.equal(only({ kind: "setPvid", bridgePort: 5, vid: 1 }).cls, "safe");
});

test("setPvid: unprotected port -> safe", () => {
  assert.equal(only({ kind: "setPvid", bridgePort: 1, vid: 20 }).cls, "safe");
});

test("setPvid: unknown bridge port -> risky", () => {
  assert.equal(only({ kind: "setPvid", bridgePort: 777, vid: 20 }).cls, "risky");
});

test("setVlanMembership: mgmt VLAN drops a protected port from egress -> blocked", () => {
  // VLAN 1 currently has 49 tagged, 1+5 untagged. Dropping 5 from egress strands the mgmt port.
  assert.equal(only({ kind: "setVlanMembership", vid: 1, tagged: [49], untagged: [1] }).cls, "blocked");
});

test("setVlanMembership: mgmt VLAN keeps all protected ports -> safe", () => {
  assert.equal(only({ kind: "setVlanMembership", vid: 1, tagged: [49], untagged: [1, 5] }).cls, "safe");
});

test("setVlanMembership: non-mgmt VLAN changes a protected port's tagging -> risky", () => {
  // VLAN 10 has 49 tagged. Removing 49 changes a protected port's tagging on a non-mgmt VLAN.
  assert.equal(only({ kind: "setVlanMembership", vid: 10, tagged: [], untagged: [] }).cls, "risky");
});

test("setVlanMembership: non-mgmt VLAN, no protected port change -> safe", () => {
  // VLAN 10 keeps 49 tagged exactly as before; adding unprotected port 1 doesn't touch P.
  assert.equal(only({ kind: "setVlanMembership", vid: 10, tagged: [49], untagged: [1] }).cls, "safe");
});

test("setVlanMembership: unknown VLAN -> risky", () => {
  assert.equal(only({ kind: "setVlanMembership", vid: 999, tagged: [], untagged: [] }).cls, "risky");
});

test("deleteVlan: mgmt VLAN -> blocked", () => {
  assert.equal(only({ kind: "deleteVlan", vid: 1 }).cls, "blocked");
});

test("deleteVlan: non-mgmt VLAN -> risky (ports lose it)", () => {
  assert.equal(only({ kind: "deleteVlan", vid: 10 }).cls, "risky");
});

test("setLag: protected port -> risky", () => {
  assert.equal(only({ kind: "setLag", bridgePort: 5, lagId: 1 }).cls, "risky");
});

test("setLag: unprotected port -> safe", () => {
  assert.equal(only({ kind: "setLag", bridgePort: 1, lagId: 1 }).cls, "safe");
});

test("setLag: unknown bridge port -> risky", () => {
  assert.equal(only({ kind: "setLag", bridgePort: 777, lagId: 1 }).cls, "risky");
});

test("setPoe off on a protected port -> risky", () => {
  assert.equal(only({ kind: "setPoe", bridgePort: 5, on: false }).cls, "risky");
});

test("setPoe off on an unprotected port -> safe", () => {
  assert.equal(only({ kind: "setPoe", bridgePort: 1, on: false }).cls, "safe");
});

test("setPoe on -> always safe", () => {
  assert.equal(only({ kind: "setPoe", bridgePort: 5, on: true }).cls, "safe");
});

test("setPoe off on unknown bridge port -> risky", () => {
  assert.equal(only({ kind: "setPoe", bridgePort: 777, on: false }).cls, "risky");
});

test("createVlan -> safe", () => {
  assert.equal(only({ kind: "createVlan", vid: 50, name: "x" }).cls, "safe");
});

test("setPortLabel -> safe", () => {
  assert.equal(only({ kind: "setPortLabel", ifIndex: 1, label: "uplink" }).cls, "safe");
});

// ---------------------------------------------------------------------------
// setObject (Phase 3 generic write) — never safe; blocked under dangerous subtrees
// ---------------------------------------------------------------------------

test("setObject on a benign vendor OID -> risky (never safe)", () => {
  // A vendor enterprise OID (1.3.6.1.4.1.1916.x = Extreme) is not in any dangerous subtree.
  const r = only({ kind: "setObject", oid: "1.3.6.1.4.1.1916.1.1.1.10.0", value: 1 });
  assert.equal(r.cls, "risky");
  assert.notEqual(r.cls, "safe");
});

test("setObject on the IP subtree (1.3.6.1.2.1.4.x) -> blocked", () => {
  // ipAdEntAddr-style OID under the IP config subtree.
  assert.equal(only({ kind: "setObject", oid: "1.3.6.1.2.1.4.20.1.1.10.0.0.1", value: "10.0.0.2" }).cls, "blocked");
});

test("setObject on the SNMP modules subtree (1.3.6.1.6.x) -> blocked", () => {
  // A USM user-table OID under snmpModules.
  assert.equal(only({ kind: "setObject", oid: "1.3.6.1.6.3.15.1.2.2.1.3", value: "x" }).cls, "blocked");
});

test("setObject on the snmp group (1.3.6.1.2.1.11.x) -> blocked", () => {
  assert.equal(only({ kind: "setObject", oid: "1.3.6.1.2.1.11.30.0", value: 1 }).cls, "blocked");
});

test("setObject on ifAdminStatus (1.3.6.1.2.1.2.2.1.7.x) -> blocked", () => {
  assert.equal(only({ kind: "setObject", oid: "1.3.6.1.2.1.2.2.1.7.5", value: 2 }).cls, "blocked");
});

test("setObject never classifies as safe even on a deep benign OID", () => {
  const r = classifyEdits(
    [{ kind: "setObject", oid: "1.3.6.1.4.1.4526.10.1.1.1.1.0", value: 7, name: "ngVendorThing" }],
    state(),
    pset(),
  );
  assert.notEqual(r.classifications[0].cls, "safe");
});

test("setObject: a sibling of a dangerous prefix is NOT mis-blocked (1.3.6.1.2.1.40)", () => {
  // 1.3.6.1.2.1.40 must not match the 1.3.6.1.2.1.4 prefix (subtree boundary on the dot).
  assert.equal(only({ kind: "setObject", oid: "1.3.6.1.2.1.40.1.0", value: 1 }).cls, "risky");
});

// ---------------------------------------------------------------------------
// worst aggregation
// ---------------------------------------------------------------------------

test("worst = blocked when any edit is blocked", () => {
  const r = classifyEdits(
    [
      { kind: "setPortLabel", ifIndex: 1, label: "a" }, // safe
      { kind: "setPoe", bridgePort: 5, on: false }, // risky
      { kind: "deleteVlan", vid: 1 }, // blocked
    ],
    state(),
    pset(),
  );
  assert.equal(r.worst, "blocked");
});

test("worst = risky when the worst edit is risky", () => {
  const r = classifyEdits(
    [
      { kind: "setPortLabel", ifIndex: 1, label: "a" }, // safe
      { kind: "setPoe", bridgePort: 5, on: false }, // risky
    ],
    state(),
    pset(),
  );
  assert.equal(r.worst, "risky");
});

test("worst = safe for an empty edit list", () => {
  assert.equal(worstOf([]), "safe");
  assert.equal(classifyEdits([], state(), pset()).worst, "safe");
});

test("worst = safe when all edits are safe", () => {
  const r = classifyEdits([{ kind: "createVlan", vid: 50 }], state(), pset());
  assert.equal(r.worst, "safe");
});

// ---------------------------------------------------------------------------
// detectProtectedSet — FDB pin, uplink heuristic, conservative fallback
// ---------------------------------------------------------------------------

test("detectProtectedSet: FDB pin of sourceMac -> high confidence, mgmt port + VLAN from its PVID", () => {
  const fdb: FdbEntry[] = [
    { mac: "aa:bb:cc:00:00:01", bridgePort: 5, vlan: 1 }, // the mgmt station, on port 5
    { mac: "aa:bb:cc:00:00:02", bridgePort: 1, vlan: 1 },
  ];
  const ps = detectProtectedSet(state(), { fdb, lldp: [] }, { sourceMac: "aa-bb-cc-00-00-01" });
  assert.equal(ps.confidence, "high");
  assert.ok(ps.ports.includes(5), "mgmt access port 5 must be protected");
  assert.deepEqual(ps.vlans, [1]); // PVID of port 5
  assert.match(ps.reason, /FDB/);
});

test("detectProtectedSet: uplink heuristic via many FDB MACs", () => {
  // Port 49 learns 5 distinct MACs -> uplink. No sourceMac, so confidence is not high.
  const fdb: FdbEntry[] = [1, 2, 3, 4, 5].map((i) => ({
    mac: `aa:bb:cc:00:00:0${i}`,
    bridgePort: 49,
    vlan: 1,
  }));
  const ps = detectProtectedSet(state(), { fdb, lldp: [] });
  assert.ok(ps.ports.includes(49), "the many-MAC uplink port 49 must be protected");
  assert.notEqual(ps.confidence, "high");
  assert.match(ps.reason, /uplink/);
});

test("detectProtectedSet: uplink heuristic via an LLDP switch neighbour", () => {
  const lldp: LldpNeighbor[] = [
    { localPort: 49, remoteSysName: "core-switch-1", remotePortId: "Gi1/0/1" },
  ];
  const ps = detectProtectedSet(state(), { fdb: [], lldp });
  assert.ok(ps.ports.includes(49), "the LLDP-neighboured port must be protected");
  assert.match(ps.reason, /LLDP/);
});

test("detectProtectedSet: conservative fallback (nothing pinnable) -> low confidence, never empty", () => {
  const ps = detectProtectedSet(state(), { fdb: [], lldp: [] });
  assert.equal(ps.confidence, "low");
  assert.ok(ps.ports.length > 0, "must never return an empty protected set");
  assert.match(ps.reason, /conservativ/i);
});

test("detectProtectedSet: never returns empty-ports with high confidence", () => {
  // Even given a sourceMac that is NOT in the FDB, we fall back conservatively, not to high.
  const ps = detectProtectedSet(state(), { fdb: [], lldp: [] }, { sourceMac: "de:ad:be:ef:00:00" });
  assert.notEqual(ps.confidence, "high");
  assert.ok(ps.ports.length > 0);
});

test("detectProtectedSet: opts.mgmtVlan override is honoured when no FDB pin", () => {
  const ps = detectProtectedSet(state(), { fdb: [], lldp: [] }, { mgmtVlan: 99 });
  assert.deepEqual(ps.vlans, [99]);
});

// ---------------------------------------------------------------------------
// Apply-gate decision (pure) — blocked/risky refusal without acknowledgement
// ---------------------------------------------------------------------------

test("gate: a blocked edit is refused without allowBlocked", () => {
  const report = classifyEdits([{ kind: "deleteVlan", vid: 1 }], state(), pset()); // blocked
  const d = gateDecision(report, {});
  assert.equal(d.refuse, true);
  assert.match(d.reason ?? "", /blocked/);
});

test("gate: a blocked edit is allowed with allowBlocked", () => {
  const report = classifyEdits([{ kind: "deleteVlan", vid: 1 }], state(), pset());
  assert.equal(gateDecision(report, { allowBlocked: true }).refuse, false);
});

test("gate: a risky edit is refused without allowRisky", () => {
  const report = classifyEdits([{ kind: "setPoe", bridgePort: 5, on: false }], state(), pset()); // risky
  const d = gateDecision(report, {});
  assert.equal(d.refuse, true);
  assert.match(d.reason ?? "", /risky/);
});

test("gate: a risky edit is allowed with allowRisky", () => {
  const report = classifyEdits([{ kind: "setPoe", bridgePort: 5, on: false }], state(), pset());
  assert.equal(gateDecision(report, { allowRisky: true }).refuse, false);
});

test("gate: blocked is reported even when allowRisky is set (blocked needs allowBlocked)", () => {
  const report = classifyEdits(
    [
      { kind: "setPoe", bridgePort: 5, on: false }, // risky
      { kind: "deleteVlan", vid: 1 }, // blocked
    ],
    state(),
    pset(),
  );
  const d = gateDecision(report, { allowRisky: true });
  assert.equal(d.refuse, true);
  assert.match(d.reason ?? "", /blocked/);
});

test("gate: all-safe edits apply with no acknowledgement", () => {
  const report = classifyEdits([{ kind: "createVlan", vid: 50 }], state(), pset());
  assert.equal(gateDecision(report, {}).refuse, false);
});
