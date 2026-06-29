import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCuratedSections,
  buildGenericSections,
  buildGenericTableSections,
  scalarInstanceOid,
  type GenericTableCandidate,
} from "../src/deviceCapabilities.ts";
import type { DeviceState, ResolvedObject } from "../src/model.ts";

// A minimal but realistic DeviceState fixture: PoE on one port, one VLAN, an LLDP neighbour.
function fixtureState(): DeviceState {
  return {
    device: {
      id: "10.0.0.1",
      host: "10.0.0.1",
      transport: "snmpV2c",
      vendorOid: "1.3.6.1.4.1.4526.100.4.11",
      vendorEnterprise: 4526,
      model: "Netgear GS748TP",
      sysName: "sw1",
      portCount: 48,
      reachable: true,
    },
    ports: [
      {
        ifIndex: 1, bridgePort: 1, name: "g1", label: "uplink", kind: "physical",
        adminStatus: "up", operStatus: "up", speedMbps: 1000, pvid: 1, untaggedVlan: 1,
        taggedVlans: [10, 20],
        poe: { capable: true, adminOn: true, status: "deliveringPower", class: 4 },
      },
      {
        ifIndex: 2, bridgePort: 2, name: "g2", kind: "physical",
        adminStatus: "down", operStatus: "down", pvid: 1, taggedVlans: [],
        poe: { capable: false },
      },
    ],
    vlans: [
      { vid: 1, name: "default", members: { tagged: [], untagged: [1, 2] }, active: true, source: "current" },
      { vid: 10, name: "voice", members: { tagged: [1], untagged: [] }, active: true, source: "current" },
    ],
    lags: [],
    readAt: "2026-06-29T00:00:00.000Z",
  };
}

test("buildCuratedSections: emits populated sections in curated order", () => {
  const topo = {
    lldp: [{ localPort: 1, remoteSysName: "core", remotePortId: "Gi0/1", remotePortDesc: "to-sw1", remoteChassisId: "aa:bb" }],
    fdb: [],
  };
  const sections = buildCuratedSections(fixtureState(), topo);
  const ids = sections.map((s) => s.id);
  assert.deepEqual(ids, ["system", "ports", "vlans", "poe", "lldp"]);
  assert.ok(sections.every((s) => s.kind === "curated"));

  const system = sections.find((s) => s.id === "system")!;
  assert.ok(system.scalars?.some((v) => v.name === "sysName" && v.value === "sw1"));
  assert.ok(system.scalars?.some((v) => v.name === "sysDescr" && v.value === "Netgear GS748TP"));

  const ports = sections.find((s) => s.id === "ports")!;
  assert.equal(ports.table!.rows.length, 2);
  assert.equal(ports.table!.columns[1], "name");

  // PoE only lists the capable port.
  const poe = sections.find((s) => s.id === "poe")!;
  assert.equal(poe.table!.rows.length, 1);
  assert.equal(poe.table!.rows[0][0], 1);
});

test("buildCuratedSections: omits empty sections (no PoE / no topology)", () => {
  const state = fixtureState();
  for (const p of state.ports) p.poe = { capable: false }; // strip PoE capability
  const sections = buildCuratedSections(state); // no topo arg
  const ids = sections.map((s) => s.id);
  assert.ok(!ids.includes("poe"), "no PoE section when no capable ports");
  assert.ok(!ids.includes("lldp"), "no LLDP section without topology");
  assert.deepEqual(ids, ["system", "ports", "vlans"]);
});

test("buildCuratedSections: minimal state yields only system when no ports/vlans", () => {
  const state = fixtureState();
  state.ports = [];
  state.vlans = [];
  const sections = buildCuratedSections(state);
  assert.deepEqual(sections.map((s) => s.id), ["system"]);
});

test("buildGenericSections: groups by module, drops objects with no value", () => {
  const objects: ResolvedObject[] = [
    { name: "vbar", oid: "1.3.6.1.4.1.9.1", module: "VENDOR-B-MIB", source: "device-mib", type: "Integer32", access: "read-only" },
    { name: "afoo", oid: "1.3.6.1.4.1.10.1", module: "VENDOR-A-MIB", source: "device-mib", type: "DisplayString", access: "read-only" },
    { name: "missing", oid: "1.3.6.1.4.1.10.2", module: "VENDOR-A-MIB", source: "device-mib", access: "read-only" },
  ];
  const values = new Map<string, string | number | null>([
    ["1.3.6.1.4.1.9.1.0", 42],
    ["1.3.6.1.4.1.10.1.0", "hello"],
    // 1.3.6.1.4.1.10.2.0 absent -> "missing" must be dropped
  ]);

  const sections = buildGenericSections(objects, values);
  // Sorted by module name: VENDOR-A-MIB before VENDOR-B-MIB.
  assert.deepEqual(sections.map((s) => s.id), ["VENDOR-A-MIB", "VENDOR-B-MIB"]);
  assert.ok(sections.every((s) => s.kind === "generic"));

  const a = sections.find((s) => s.id === "VENDOR-A-MIB")!;
  assert.equal(a.scalars!.length, 1); // only afoo, missing dropped
  assert.equal(a.scalars![0].name, "afoo");
  assert.equal(a.scalars![0].oid, "1.3.6.1.4.1.10.1.0"); // instance OID
  assert.equal(a.scalars![0].value, "hello");

  const b = sections.find((s) => s.id === "VENDOR-B-MIB")!;
  assert.equal(b.scalars![0].value, 42);
});

test("buildGenericSections: no surviving objects -> no sections", () => {
  const objects: ResolvedObject[] = [
    { name: "x", oid: "1.3.6.1.4.1.1.1", module: "M", source: "device-mib", access: "read-only" },
  ];
  assert.deepEqual(buildGenericSections(objects, new Map()), []);
});

// ---------------------------------------------------------------------------
// Phase 4: buildGenericTableSections — rows keyed by shared suffix, columnMeta/rowKeys/index attached
// ---------------------------------------------------------------------------

function tableCand(): GenericTableCandidate {
  return {
    module: "ACME-MIB",
    entry: "acmePortCfgEntry",
    title: "acmePortCfgEntry",
    columns: [
      { name: "acmePortCfgSpeed", oid: "1.3.6.1.4.1.99.1.1.1", access: "read-write", base: "enum", kind: "column", table: "acmePortCfgEntry" },
      { name: "acmePortCfgName", oid: "1.3.6.1.4.1.99.1.1.2", access: "read-write", base: "string", kind: "column", table: "acmePortCfgEntry" },
    ],
  };
}

test("buildGenericTableSections: assembles rows by shared row key + attaches columnMeta/rowKeys/index", () => {
  const cand = tableCand();
  const columnValues = new Map<string, Map<string, string | number | null>>([
    ["1.3.6.1.4.1.99.1.1.1", new Map<string, string | number | null>([["1", 3], ["49", 2]])],
    ["1.3.6.1.4.1.99.1.1.2", new Map<string, string | number | null>([["1", "g1"], ["49", "uplink"]])],
  ]);
  const sections = buildGenericTableSections([cand], columnValues, () => "ifIndex");
  assert.equal(sections.length, 1);
  const s = sections[0];
  assert.equal(s.kind, "generic");
  assert.equal(s.id, "acmePortCfgEntry");
  assert.deepEqual(s.table!.columns, ["acmePortCfgSpeed", "acmePortCfgName"]);
  assert.deepEqual(s.table!.rowKeys, ["1", "49"]); // sorted numerically by OID compare
  assert.deepEqual(s.table!.rows, [[3, "g1"], [2, "uplink"]]);
  assert.equal(s.table!.index, "ifIndex");
  // columnMeta aligned to columns, carrying the editable column OID + access + base.
  assert.equal(s.table!.columnMeta!.length, 2);
  assert.equal(s.table!.columnMeta![0].oid, "1.3.6.1.4.1.99.1.1.1");
  assert.equal(s.table!.columnMeta![0].access, "read-write");
  assert.equal(s.table!.columnMeta![0].base, "enum");
});

test("buildGenericTableSections: a row key present in only one column still emits a (sparse) row", () => {
  const cand = tableCand();
  const columnValues = new Map<string, Map<string, string | number | null>>([
    ["1.3.6.1.4.1.99.1.1.1", new Map<string, string | number | null>([["7", 1]])],
    // name column has nothing for row 7
  ]);
  const sections = buildGenericTableSections([cand], columnValues);
  assert.equal(sections[0].table!.rows.length, 1);
  assert.deepEqual(sections[0].table!.rows[0], [1, null]); // missing cell -> null
});

test("buildGenericTableSections: a table that returned no rows is dropped", () => {
  assert.deepEqual(buildGenericTableSections([tableCand()], new Map()), []);
});

test("scalarInstanceOid: appends .0 idempotently", () => {
  assert.equal(scalarInstanceOid("1.3.6.1.4.1.1"), "1.3.6.1.4.1.1.0");
  assert.equal(scalarInstanceOid("1.3.6.1.4.1.1.0"), "1.3.6.1.4.1.1.0");
});
