import { test } from "node:test";
import assert from "node:assert/strict";
import { editToVarbinds, planChanges } from "../src/apply.ts";
import { decodePortList } from "../src/portlist.ts";
import type { DeviceState } from "../src/model.ts";

function fixture(): DeviceState {
  return {
    device: {
      id: "h", host: "h", transport: "snmpV2c", reachable: true,
      capabilities: {
        qbridgeRead: true, qbridgeWrite: false, pvidWrite: true, poe: true,
        lldp: false, lag: true, canCreateVlan: false, canEditLag: false, portListWidth: 126, membershipSource: "current",
      },
    },
    ports: [
      { ifIndex: 16, bridgePort: 16, name: "g16", kind: "physical", adminStatus: "up", operStatus: "up", pvid: 1, taggedVlans: [] },
      { ifIndex: 1, bridgePort: 1, name: "g1", kind: "physical", adminStatus: "up", operStatus: "down", pvid: 1, taggedVlans: [] },
      { ifIndex: 38, bridgePort: 38, name: "g38", kind: "physical", adminStatus: "up", operStatus: "up", pvid: 1, taggedVlans: [] },
    ],
    vlans: [{ vid: 10, name: "Main", members: { tagged: [], untagged: [] }, active: true, source: "current" }],
    lags: [],
    readAt: new Date().toISOString(),
  };
}

test("setPvid -> dot1qPvid.<port> = vid (Gauge32)", () => {
  const vbs = editToVarbinds({ kind: "setPvid", bridgePort: 16, vid: 20 }, fixture());
  assert.equal(vbs.length, 1);
  assert.equal(vbs[0].oid, "1.3.6.1.2.1.17.7.1.4.5.1.1.16");
  assert.equal(vbs[0].type, 66); // Gauge32
  assert.equal(vbs[0].value, 20);
});

test("setVlanMembership -> egress = tagged+untagged, plus untagged bitmap", () => {
  const vbs = editToVarbinds({ kind: "setVlanMembership", vid: 10, tagged: [38], untagged: [16, 18] }, fixture());
  assert.equal(vbs.length, 2);
  assert.equal(vbs[0].oid, "1.3.6.1.2.1.17.7.1.4.3.1.2.10"); // egress
  assert.equal(vbs[1].oid, "1.3.6.1.2.1.17.7.1.4.3.1.4.10"); // untagged
  assert.deepEqual(decodePortList(vbs[0].value as Buffer), [16, 18, 38]);
  assert.deepEqual(decodePortList(vbs[1].value as Buffer), [16, 18]);
  assert.equal((vbs[0].value as Buffer).length, 126);
});

test("setPoe -> pethPsePortAdminEnable.1.<port> TruthValue", () => {
  const off = editToVarbinds({ kind: "setPoe", bridgePort: 5, on: false }, fixture());
  assert.equal(off[0].oid, "1.3.6.1.2.1.105.1.1.1.3.1.5");
  assert.equal(off[0].value, 2); // false
  const on = editToVarbinds({ kind: "setPoe", bridgePort: 5, on: true }, fixture());
  assert.equal(on[0].value, 1); // true
});

test("createVlan is blocked on a model that can't create VLANs over SNMP", () => {
  const cs = planChanges(fixture(), [{ kind: "createVlan", vid: 99, name: "X" }]);
  assert.match(cs.diff[0].warning ?? "", /cannot create VLANs/);
});

test("setLag is blocked on a model that can't edit LAGs over SNMP", () => {
  const cs = planChanges(fixture(), [{ kind: "setLag", bridgePort: 5, lagId: 1000 }]);
  assert.match(cs.diff[0].warning ?? "", /cannot edit LAG/);
});

test("createVlan / deleteVlan use RowStatus", () => {
  const create = editToVarbinds({ kind: "createVlan", vid: 99, name: "Test" }, fixture());
  assert.equal(create[0].oid, "1.3.6.1.2.1.17.7.1.4.3.1.5.99");
  assert.equal(create[0].value, 4); // createAndGo
  assert.equal(create[1].oid, "1.3.6.1.2.1.17.7.1.4.3.1.1.99");
  const del = editToVarbinds({ kind: "deleteVlan", vid: 99 }, fixture());
  assert.equal(del[0].value, 6); // destroy
});

test("planChanges produces a before/after diff", () => {
  const cs = planChanges(fixture(), [{ kind: "setPvid", bridgePort: 1, vid: 20 }]);
  assert.equal(cs.status, "planned");
  assert.equal(cs.diff.length, 1);
  assert.deepEqual(cs.diff[0].before, { pvid: 1 });
  assert.deepEqual(cs.diff[0].after, { pvid: 20 });
});

test("guard warns when an edit touches a management port", () => {
  const cs = planChanges(fixture(), [{ kind: "setPvid", bridgePort: 38, vid: 20 }], { managementPorts: [38] });
  assert.match(cs.diff[0].warning ?? "", /management path/);
});

test("guard warns when changing an UP port (link active)", () => {
  const cs = planChanges(fixture(), [{ kind: "setPvid", bridgePort: 16, vid: 20 }]);
  assert.match(cs.diff[0].warning ?? "", /currently UP/);
});

test("no warning on a down, non-management port", () => {
  const cs = planChanges(fixture(), [{ kind: "setPvid", bridgePort: 1, vid: 20 }]);
  assert.equal(cs.diff[0].warning, undefined);
});
