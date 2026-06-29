import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyEdits } from "../src/safety.ts";
import type { DeviceState, ProtectedSet, Edit } from "../src/model.ts";

// ---------------------------------------------------------------------------
// Phase 4: classifyEdits with a row decoder for setObject TABLE CELLS.
// A cell whose decoded row is a protected port/VLAN must be blocked; a decodable-unprotected cell is
// risky; a dangerous subtree is blocked even if decodable; an undecodable cell is risky (never safe).
// ---------------------------------------------------------------------------

function state(): DeviceState {
  return {
    device: { id: "d", host: "d", transport: "snmpV2c", reachable: true },
    ports: [
      { ifIndex: 1, bridgePort: 1, name: "g1", kind: "physical", adminStatus: "up", operStatus: "up", pvid: 1, taggedVlans: [] },
      { ifIndex: 105, bridgePort: 5, name: "g5", kind: "physical", adminStatus: "up", operStatus: "up", pvid: 1, taggedVlans: [] },
    ],
    vlans: [{ vid: 1, name: "default", members: { tagged: [], untagged: [1, 5] }, active: true, source: "current" }],
    lags: [],
    readAt: new Date().toISOString(),
  };
}

// Protects bridge ports 5 + 49 and VLAN 1 (mirrors the safety.test.ts fixture).
function pset(): ProtectedSet {
  return { ports: [5, 49], vlans: [1], reason: "fixture", confidence: "high" };
}

// A decoder fixture: column 1.3.6.1.4.1.99.1.1.1 is ifIndex-keyed (suffix mapped straight to a bridge
// port here), 1.3.6.1.4.1.99.2.1.1 is a vlan-first column. Anything else is undecodable -> null.
function decodeRow(instanceOid: string): { port?: number; vlan?: number } | null {
  const portCol = "1.3.6.1.4.1.99.1.1.1.";
  const vlanCol = "1.3.6.1.4.1.99.2.1.1.";
  if (instanceOid.startsWith(portCol)) return { port: Number(instanceOid.slice(portCol.length).split(".")[0]) };
  if (instanceOid.startsWith(vlanCol)) return { vlan: Number(instanceOid.slice(vlanCol.length).split(".")[0]) };
  return null;
}

function cell(edit: Edit): { cls: string; reason: string } {
  const r = classifyEdits([edit], state(), pset(), { decodeRow });
  return { cls: r.classifications[0].cls, reason: r.classifications[0].reason };
}

test("setObject cell on a PROTECTED port row -> blocked", () => {
  const r = cell({ kind: "setObject", oid: "1.3.6.1.4.1.99.1.1.1.5", value: 2, name: "acmePortCfgSpeed.5" });
  assert.equal(r.cls, "blocked");
  assert.match(r.reason, /management port 5/);
});

test("setObject cell on an UNPROTECTED port row -> risky (never safe)", () => {
  const r = cell({ kind: "setObject", oid: "1.3.6.1.4.1.99.1.1.1.1", value: 2 });
  assert.equal(r.cls, "risky");
  assert.notEqual(r.cls, "safe");
});

test("setObject cell on the PROTECTED management VLAN row -> blocked", () => {
  const r = cell({ kind: "setObject", oid: "1.3.6.1.4.1.99.2.1.1.1", value: "x" });
  assert.equal(r.cls, "blocked");
  assert.match(r.reason, /management VLAN 1/);
});

test("setObject cell on an UNPROTECTED VLAN row -> risky", () => {
  const r = cell({ kind: "setObject", oid: "1.3.6.1.4.1.99.2.1.1.20", value: "x" });
  assert.equal(r.cls, "risky");
});

test("setObject cell under a DANGEROUS subtree -> blocked even when decodable & unprotected", () => {
  // A decoder maps an ifAdminStatus column to an UNPROTECTED port (1); the dangerous-subtree rule
  // must still win and block the link-dropping write.
  const danger = (oid: string): { port?: number; vlan?: number } | null =>
    oid.startsWith("1.3.6.1.2.1.2.2.1.7.") ? { port: 1 } : null;
  const r = classifyEdits(
    [{ kind: "setObject", oid: "1.3.6.1.2.1.2.2.1.7.1", value: 2 }],
    state(),
    pset(),
    { decodeRow: danger },
  );
  assert.equal(r.classifications[0].cls, "blocked");
});

test("setObject cell that is UNDECODABLE -> risky (never safe)", () => {
  const r = cell({ kind: "setObject", oid: "1.3.6.1.4.1.99.9.9.9.1", value: 1 });
  assert.equal(r.cls, "risky");
  assert.notEqual(r.cls, "safe");
});

test("setObject with NO decoder supplied keeps Phase 3 behaviour (benign vendor -> risky)", () => {
  const r = classifyEdits(
    [{ kind: "setObject", oid: "1.3.6.1.4.1.1916.1.1.1.10.0", value: 1 }],
    state(),
    pset(),
  );
  assert.equal(r.classifications[0].cls, "risky");
});
