import { test } from "node:test";
import assert from "node:assert/strict";
import { editToVarbinds, planChanges, applyChangeSet } from "../src/apply.ts";
import { decodePortList } from "../src/portlist.ts";
import { OID } from "../src/oids.ts";
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

// --- setObject (Phase 3 generic write) ---

test("setObject with an explicit Integer snmpType builds a numeric varbind (enum value)", () => {
  // An enum write: snmpType 2 (Integer), value the enum's numeric code.
  const vbs = editToVarbinds({ kind: "setObject", oid: "1.3.6.1.4.1.99.1.0", value: 2, snmpType: 2 }, fixture());
  assert.equal(vbs.length, 1);
  assert.equal(vbs[0].oid, "1.3.6.1.4.1.99.1.0");
  assert.equal(vbs[0].type, 2);
  assert.equal(vbs[0].value, 2);
});

test("setObject with an OctetString snmpType builds a Buffer varbind (string value)", () => {
  const vbs = editToVarbinds({ kind: "setObject", oid: "1.3.6.1.4.1.99.3.0", value: "lobby-sw", snmpType: 4 }, fixture());
  assert.equal(vbs[0].type, 4);
  assert.ok(Buffer.isBuffer(vbs[0].value));
  assert.equal((vbs[0].value as Buffer).toString("utf8"), "lobby-sw");
});

test("setObject coerces a numeric-string value to a number for an integer type", () => {
  const vbs = editToVarbinds({ kind: "setObject", oid: "1.3.6.1.4.1.99.2.0", value: "4094", snmpType: 2 }, fixture());
  assert.strictEqual(vbs[0].value, 4094);
});

test("setObject rejects a non-numeric value for an integer type", () => {
  assert.throws(
    () => editToVarbinds({ kind: "setObject", oid: "1.3.6.1.4.1.99.2.0", value: "abc", snmpType: 2 }, fixture()),
    /not a valid number/,
  );
});

test("setObject rejects a non-dotted IpAddress value", () => {
  assert.throws(
    () => editToVarbinds({ kind: "setObject", oid: "1.3.6.1.4.1.99.7.0", value: "not-an-ip", snmpType: 64 }, fixture()),
    /not a dotted IPv4/,
  );
});

test("setObject without a snmpType and no MIB store throws (won't guess a wire type)", () => {
  assert.throws(
    () => editToVarbinds({ kind: "setObject", oid: "1.3.6.1.4.1.99.1.0", value: 1 }, fixture()),
    /could not be resolved/,
  );
});

test("setObject infers the snmpType from describeObject when omitted", () => {
  // Minimal MIB store fixture exposing one enum object so the inference path is exercised.
  const acme = `
ACME-MIB DEFINITIONS ::= BEGIN
acmeDuplex OBJECT-TYPE
  SYNTAX INTEGER { half(1), full(2) }
  MAX-ACCESS read-write STATUS current DESCRIPTION "d" ::= { acme 1 }
END
`;
  const obj = { name: "acmeDuplex", oid: "1.3.6.1.4.1.99.1", module: "ACME-MIB" };
  const mib = {
    indexDir: () => 0, loadFile: () => null, loadDir: () => ({ loaded: 0, skipped: [] }),
    loadDirFromCache: () => false, loadModule: () => false, providers: () => [],
    findOid: (s: string) => (s === "acmeDuplex" ? obj : null),
    loadedModules: () => ["ACME-MIB"], indexedModules: () => ["ACME-MIB"],
    moduleText: (m: string) => (m === "ACME-MIB" ? acme : null),
    sourceFor: (s: string) =>
      s === "acmeDuplex" || s === "1.3.6.1.4.1.99.1.0" || s === "1.3.6.1.4.1.99.1"
        ? { module: "ACME-MIB", file: "ACME-MIB.mib", text: acme, object: obj }
        : null,
  };
  const vbs = editToVarbinds(
    { kind: "setObject", oid: "1.3.6.1.4.1.99.1.0", value: 2, name: "acmeDuplex" },
    fixture(),
    mib as never,
  );
  assert.equal(vbs[0].type, 2); // Integer, inferred from the SYNTAX
  assert.equal(vbs[0].value, 2);
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

// --- apply/verify/rollback behaviour (field-report bug fixes) ---

// Fixture for a switch that CAN create VLANs over SNMP (e.g. EXOS).
function creatable(): DeviceState {
  const s = fixture();
  s.device.capabilities!.canCreateVlan = true;
  return s;
}

// In-memory SNMP client: simulates the Q-BRIDGE static VLAN table so verify can be exercised.
class FakeClient {
  sets: { oid: string; value: number | Buffer }[][] = [];
  staticRows = new Map<number, number>(); // vid -> RowStatus (1=active)
  confirm = true; // whether read-backs reflect writes (false simulates EXOS empty-VLAN miss)
  setHook: ((n: number) => void) | null = null;
  private n = 0;
  async set(vbs: { oid: string; value: number | Buffer }[]) {
    this.n++;
    if (this.setHook) this.setHook(this.n);
    this.sets.push(vbs);
    for (const vb of vbs) {
      const m = vb.oid.match(/17\.7\.1\.4\.3\.1\.5\.(\d+)$/); // dot1qVlanStaticRowStatus.<vid>
      if (m) { const vid = +m[1]; if (vb.value === 6) this.staticRows.delete(vid); else this.staticRows.set(vid, 1); }
    }
  }
  async get(oids: string[]) { return oids.map(() => ({ value: 0 })); }
  async column(oid: string) {
    const map = new Map<string, { value: unknown }>();
    if (this.confirm && oid === OID.dot1qVlanStaticRowStatus) {
      for (const [vid, rs] of this.staticRows) map.set(String(vid), { value: rs });
    }
    return map;
  }
}

const destroyed = (c: FakeClient, vid: number) =>
  c.sets.some((vbs) => vbs.some((v) => new RegExp(`\\.3\\.1\\.5\\.${vid}$`).test(v.oid) && v.value === 6));

test("createVlan: SET accepted + static row present -> verified, not rolled back", async () => {
  const st = creatable();
  const c = new FakeClient();
  const out = await applyChangeSet(c as never, st, planChanges(st, [{ kind: "createVlan", vid: 4090, name: "x" }]));
  assert.equal(out.status, "verified");
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].verified, true);
  assert.equal(c.staticRows.get(4090), 1); // still exists
  assert.equal(destroyed(c, 4090), false); // never rolled back
});

test("createVlan: SET accepted but read-back can't confirm -> applied, still NOT rolled back", async () => {
  const st = creatable();
  const c = new FakeClient();
  c.confirm = false; // verify reads see nothing (the EXOS empty-VLAN false-fail)
  const out = await applyChangeSet(c as never, st, planChanges(st, [{ kind: "createVlan", vid: 4091 }]));
  assert.equal(out.status, "applied");
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].verified, false);
  assert.equal(destroyed(c, 4091), false); // a successful SET is never rolled back
});

test("deleteVlan: SET accepted + row gone -> verified", async () => {
  const st = creatable();
  const c = new FakeClient();
  c.staticRows.set(10, 1);
  const out = await applyChangeSet(c as never, st, planChanges(st, [{ kind: "deleteVlan", vid: 10 }]));
  assert.equal(out.status, "verified");
  assert.equal(out.results[0].verified, true);
  assert.equal(c.staticRows.has(10), false);
});

test("batch is not aborted by an unconfirmable verify", async () => {
  const st = creatable();
  const c = new FakeClient();
  c.confirm = false; // neither create can be confirmed
  const out = await applyChangeSet(c as never, st, planChanges(st, [
    { kind: "createVlan", vid: 11 },
    { kind: "createVlan", vid: 12 },
  ]));
  assert.equal(out.results.length, 2); // edit #2 still ran (no abort after #1)
  assert.equal(out.status, "applied");
  assert.ok(out.results.every((r) => r.ok));
});

test("a genuine SNMP SET error -> failed, prior accepted edits rolled back", async () => {
  const st = creatable();
  const c = new FakeClient();
  c.setHook = (n) => { if (n === 2) throw new Error("genErr"); }; // 2nd set fails
  const out = await applyChangeSet(c as never, st, planChanges(st, [
    { kind: "createVlan", vid: 20 },
    { kind: "createVlan", vid: 21 },
  ]));
  assert.equal(out.status, "failed");
  assert.equal(destroyed(c, 20), true); // vid 20 was created then reverted
});

// --- setObject apply/verify/rollback (generic write) ---

// FakeClient extension that stores SET values per OID and replays them on GET, so the generic
// setObject verify (read-back compare) and the planChanges before-read can be exercised offline.
class FakeStore {
  values = new Map<string, number | Buffer>();
  sets: { oid: string; type: number; value: number | Buffer }[][] = [];
  async set(vbs: { oid: string; type: number; value: number | Buffer }[]) {
    this.sets.push(vbs);
    for (const vb of vbs) this.values.set(vb.oid, vb.value);
  }
  async get(oids: string[]) {
    return oids.map((o) => ({ value: this.values.has(o) ? this.values.get(o) : 0 }));
  }
  async column() { return new Map<string, { value: unknown }>(); }
}

test("setObject: SET accepted + read-back matches -> verified", async () => {
  const st = fixture();
  const c = new FakeStore();
  const cs = planChanges(st, [{ kind: "setObject", oid: "1.3.6.1.4.1.99.3.0", value: "lab", snmpType: 4 }]);
  const out = await applyChangeSet(c as never, st, cs);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].verified, true);
  assert.equal((c.values.get("1.3.6.1.4.1.99.3.0") as Buffer).toString("utf8"), "lab");
});
