import { test } from "node:test";
import assert from "node:assert/strict";
import { macFromIndexTail, lldpLocalPortFromIndex, textOrHex, readFdb, readLldpNeighbors } from "../src/topology.ts";
import { OID } from "../src/oids.ts";

test("macFromIndexTail builds a MAC from the last 6 sub-OIDs", () => {
  assert.equal(macFromIndexTail([10, 0, 17, 34, 51, 68, 85]), "00:11:22:33:44:55");
  assert.equal(macFromIndexTail([0, 11, 22, 33, 44, 55]), "00:0b:16:21:2c:37");
});

test("lldpLocalPortFromIndex extracts the local port (middle component)", () => {
  assert.equal(lldpLocalPortFromIndex("0.5.1"), 5);
  assert.equal(lldpLocalPortFromIndex("123.49.7"), 49);
});

test("textOrHex prints printable strings, hex otherwise", () => {
  assert.equal(textOrHex("sw-core"), "sw-core");
  assert.equal(textOrHex(Buffer.from([0, 17, 34, 51, 68, 85])), "00:11:22:33:44:55");
});

function fakeClient(cols: Record<string, Map<string, { value: unknown }>>) {
  return {
    async column(oid: string) { return cols[oid] ?? new Map(); },
    async get() { return []; },
    async set() { /* noop */ },
  };
}

test("readFdb parses Q-BRIDGE FDB (vlan + mac -> port)", async () => {
  const cols: Record<string, Map<string, { value: unknown }>> = {};
  cols[OID.dot1qTpFdbPort] = new Map([["10.0.17.34.51.68.85", { value: 16 }]]);
  const fdb = await readFdb(fakeClient(cols) as never);
  assert.equal(fdb.length, 1);
  assert.deepEqual(fdb[0], { vlan: 10, mac: "00:11:22:33:44:55", bridgePort: 16 });
});

test("readFdb falls back to BRIDGE-MIB when Q-BRIDGE FDB is empty", async () => {
  const cols: Record<string, Map<string, { value: unknown }>> = {};
  cols[OID.dot1dTpFdbPort] = new Map([["0.17.34.51.68.85", { value: 3 }]]);
  const fdb = await readFdb(fakeClient(cols) as never);
  assert.equal(fdb.length, 1);
  assert.equal(fdb[0].mac, "00:11:22:33:44:55");
  assert.equal(fdb[0].bridgePort, 3);
  assert.equal(fdb[0].vlan, undefined);
});

test("readLldpNeighbors joins the remote columns by index", async () => {
  const idx = "0.49.1";
  const cols: Record<string, Map<string, { value: unknown }>> = {};
  cols[OID.lldpRemSysName] = new Map([[idx, { value: "core-sw" }]]);
  cols[OID.lldpRemPortId] = new Map([[idx, { value: "Gi1/0/1" }]]);
  cols[OID.lldpRemPortDesc] = new Map([[idx, { value: "uplink" }]]);
  cols[OID.lldpRemChassisId] = new Map([[idx, { value: Buffer.from([0, 17, 34, 51, 68, 85]) }]]);
  const n = await readLldpNeighbors(fakeClient(cols) as never);
  assert.equal(n.length, 1);
  assert.equal(n[0].localPort, 49);
  assert.equal(n[0].remoteSysName, "core-sw");
  assert.equal(n[0].remotePortId, "Gi1/0/1");
  assert.equal(n[0].remotePortDesc, "uplink");
  assert.equal(n[0].remoteChassisId, "00:11:22:33:44:55");
});
