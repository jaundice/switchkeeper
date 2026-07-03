import { test } from "node:test";
import assert from "node:assert/strict";
import { editToVarbinds } from "../src/apply.ts";
import { classifyEdits } from "../src/safety.ts";
import { OID } from "../src/oids.ts";
import type { DeviceState, ProtectedSet } from "../src/model.ts";

// Minimal device: VLAN 1 (management) + VLAN 10 (user). Port fields kept simple; rename doesn't
// touch ports, so only the vlan table matters for these tests.
function state(): DeviceState {
  return {
    device: { id: "d", host: "d", transport: "snmpV2c", reachable: true },
    ports: [
      { ifIndex: 1, bridgePort: 1, name: "g1", kind: "physical", adminStatus: "up", operStatus: "up", pvid: 1, taggedVlans: [] },
    ],
    vlans: [
      { vid: 1, name: "default", members: { tagged: [], untagged: [1] }, active: true, source: "current" },
      { vid: 10, name: "Voice", members: { tagged: [], untagged: [] }, active: true, source: "current" },
    ],
    lags: [],
    readAt: new Date().toISOString(),
  };
}

// Protected set: management VLAN 1.
function pset(): ProtectedSet {
  return { ports: [1], vlans: [1], reason: "fixture", confidence: "high" };
}

function only(vid: number, name: string): { cls: string; reason: string } {
  const r = classifyEdits([{ kind: "renameVlan", vid, name }], state(), pset());
  return { cls: r.classifications[0].cls, reason: r.classifications[0].reason };
}

// ---------------------------------------------------------------------------
// editToVarbinds
// ---------------------------------------------------------------------------

test("renameVlan -> single dot1qVlanStaticName.<vid> OCTET STRING varbind (utf8 name)", () => {
  const vbs = editToVarbinds({ kind: "renameVlan", vid: 10, name: "Servers" }, state());
  assert.equal(vbs.length, 1);
  assert.equal(vbs[0].oid, `${OID.dot1qVlanStaticName}.10`);
  assert.equal(vbs[0].oid, "1.3.6.1.2.1.17.7.1.4.3.1.1.10");
  assert.equal(vbs[0].type, 4); // OctetString
  assert.ok(Buffer.isBuffer(vbs[0].value));
  assert.ok((vbs[0].value as Buffer).equals(Buffer.from("Servers", "utf8")));
});

// ---------------------------------------------------------------------------
// classifyEdits
// ---------------------------------------------------------------------------

test("renameVlan on a non-management VLAN -> safe", () => {
  assert.equal(only(10, "Servers").cls, "safe");
});

test("renameVlan on the management VLAN -> risky (never blocked)", () => {
  const r = only(1, "mgmt");
  assert.equal(r.cls, "risky");
  assert.match(r.reason, /management VLAN 1/);
});

test("renameVlan for a vid not present in state -> risky", () => {
  const r = only(999, "Ghost");
  assert.equal(r.cls, "risky");
  assert.match(r.reason, /not found in state/);
});
