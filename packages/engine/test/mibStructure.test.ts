import { test } from "node:test";
import assert from "node:assert/strict";
import { enumerateModule, buildRowDecoder, rowIndexNames } from "../src/mibStructure.ts";
import type { MibStore, MibObject } from "../src/mib.ts";
import type { DeviceState } from "../src/model.ts";

// ---------------------------------------------------------------------------
// Fixture MIB text + a minimal in-memory MibStore. enumerateModule parses the RAW MIB TEXT (the
// columns net-snmp's providers omit), seeding parent OIDs from providers(). So the fixture store
// returns providers for the TABLE + ENTRY (which net-snmp would expose) but NOT the columns — that
// is exactly the gap Phase 4 fills, and the honest unit under test.
// ---------------------------------------------------------------------------

// An ifIndex-keyed table (acmePortCfgTable) and a dot1q VLAN-first table (acmeVlanCfgTable).
const VENDOR_MIB = `
ACME-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE, Integer32 FROM SNMPv2-SMI
        ifIndex FROM IF-MIB
        dot1qVlanIndex FROM Q-BRIDGE-MIB;

acmePortCfgTable OBJECT-TYPE
    SYNTAX      SEQUENCE OF AcmePortCfgEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "Per-port config."
    ::= { acmeCfg 1 }

acmePortCfgEntry OBJECT-TYPE
    SYNTAX      AcmePortCfgEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "A row."
    INDEX       { ifIndex }
    ::= { acmePortCfgTable 1 }

acmePortCfgSpeed OBJECT-TYPE
    SYNTAX      INTEGER { s10(1), s100(2), s1000(3) }
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION "Configured speed."
    ::= { acmePortCfgEntry 1 }

acmePortCfgName OBJECT-TYPE
    SYNTAX      OCTET STRING
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION "Port name."
    ::= { acmePortCfgEntry 2 }

acmeVlanCfgTable OBJECT-TYPE
    SYNTAX      SEQUENCE OF AcmeVlanCfgEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "Per-VLAN config."
    ::= { acmeCfg 2 }

acmeVlanCfgEntry OBJECT-TYPE
    SYNTAX      AcmeVlanCfgEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "A vlan row."
    INDEX       { dot1qVlanIndex }
    ::= { acmeVlanCfgTable 1 }

acmeVlanCfgName OBJECT-TYPE
    SYNTAX      OCTET STRING
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION "VLAN name."
    ::= { acmeVlanCfgEntry 1 }

END
`;

// Object OIDs net-snmp's providers WOULD expose: the table node + the entry node (plus the cfg group
// node acmeCfg as an anchor). The columns are deliberately NOT here — enumerateModule derives them.
const ACME_CFG = "1.3.6.1.4.1.99.1";
const PROVIDERS: MibObject[] = [
  { name: "acmeCfg", oid: ACME_CFG, module: "ACME-MIB" },
  { name: "acmePortCfgTable", oid: ACME_CFG + ".1", module: "ACME-MIB" },
  { name: "acmePortCfgEntry", oid: ACME_CFG + ".1.1", module: "ACME-MIB" },
  { name: "acmeVlanCfgTable", oid: ACME_CFG + ".2", module: "ACME-MIB" },
  { name: "acmeVlanCfgEntry", oid: ACME_CFG + ".2.1", module: "ACME-MIB" },
];

function fakeStore(): MibStore {
  const byName = new Map(PROVIDERS.map((p) => [p.name, p]));
  return {
    indexDir: () => 0,
    loadFile: () => null,
    loadDir: () => ({ loaded: 0, skipped: [] }),
    loadDirFromCache: () => false,
    loadModule: () => false,
    providers: (m: string) => (m === "ACME-MIB" ? PROVIDERS : []),
    findOid: (s: string) => byName.get(s) ?? null,
    loadedModules: () => ["ACME-MIB"],
    indexedModules: () => ["ACME-MIB"],
    moduleText: (m: string) => (m === "ACME-MIB" ? VENDOR_MIB : null),
    // describeObject (called by baseOf) resolves the column via sourceFor on its symbol; we only
    // need to answer for the symbols enumerateModule asks about. Return the module text so the
    // OBJECT-TYPE block can be sliced; objectFor-by-OID isn't exercised here.
    sourceFor: (symbolOrOid: string) => {
      const obj = byName.get(symbolOrOid);
      if (obj) return { module: "ACME-MIB", file: "ACME-MIB.mib", text: VENDOR_MIB, object: obj };
      // Columns aren't in providers, but describeObject needs an object record to slice the block;
      // synthesize one keyed by the symbol so the SYNTAX parse can proceed.
      if (/^[A-Za-z]/.test(symbolOrOid)) {
        return {
          module: "ACME-MIB",
          file: "ACME-MIB.mib",
          text: VENDOR_MIB,
          object: { name: symbolOrOid, oid: "0", module: "ACME-MIB" },
        };
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// enumerateModule — columns resolve to entryOid + ".N." pattern
// ---------------------------------------------------------------------------

test("enumerateModule resolves table, row, and column kinds with OIDs from ::= { parent N }", () => {
  const objs = enumerateModule(fakeStore(), "ACME-MIB");
  const byName = new Map(objs.map((o) => [o.name, o]));

  // The table node.
  const tbl = byName.get("acmePortCfgTable");
  assert.ok(tbl);
  assert.equal(tbl.kind, "table");
  assert.equal(tbl.oid, ACME_CFG + ".1");

  // The entry/row node.
  const entry = byName.get("acmePortCfgEntry");
  assert.ok(entry);
  assert.equal(entry.kind, "row");
  assert.equal(entry.oid, ACME_CFG + ".1.1");

  // Two columns, resolved as entryOid + ".N" (here ".1.1.1" and ".1.1.2").
  const speed = byName.get("acmePortCfgSpeed");
  assert.ok(speed);
  assert.equal(speed.kind, "column");
  assert.equal(speed.table, "acmePortCfgEntry");
  assert.equal(speed.oid, ACME_CFG + ".1.1.1");
  assert.equal(speed.access, "read-write");
  assert.equal(speed.base, "enum"); // INTEGER { ... } via describeObject

  const name = byName.get("acmePortCfgName");
  assert.ok(name);
  assert.equal(name.kind, "column");
  assert.equal(name.oid, ACME_CFG + ".1.1.2");

  // Second table's column resolves too.
  const vname = byName.get("acmeVlanCfgName");
  assert.ok(vname);
  assert.equal(vname.kind, "column");
  assert.equal(vname.oid, ACME_CFG + ".2.1.1");
});

test("rowIndexNames parses the INDEX clause in order", () => {
  assert.deepEqual(rowIndexNames(fakeStore(), "ACME-MIB", "acmePortCfgEntry"), ["ifIndex"]);
  assert.deepEqual(rowIndexNames(fakeStore(), "ACME-MIB", "acmeVlanCfgEntry"), ["dot1qVlanIndex"]);
});

// ---------------------------------------------------------------------------
// buildRowDecoder — INDEX parse + suffix decode
// ---------------------------------------------------------------------------

function state(): DeviceState {
  return {
    device: { id: "d", host: "d", transport: "snmpV2c", reachable: true },
    ports: [
      // ifIndex 49 maps to bridgePort 49; ifIndex 105 maps to bridgePort 5 (exercise the mapping).
      { ifIndex: 49, bridgePort: 49, name: "g49", kind: "physical", adminStatus: "up", operStatus: "up", taggedVlans: [] },
      { ifIndex: 105, bridgePort: 5, name: "g5", kind: "physical", adminStatus: "up", operStatus: "up", taggedVlans: [] },
    ],
    vlans: [{ vid: 20, name: "v20", members: { tagged: [], untagged: [] }, active: true, source: "current" }],
    lags: [],
    readAt: new Date().toISOString(),
  };
}

test("decoder: ifIndex table cell -> { port } mapped via state (ifIndex 105 -> bridgePort 5)", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  // acmePortCfgSpeed instance for ifIndex 105.
  const d = decode(ACME_CFG + ".1.1.1.105");
  assert.deepEqual(d, { port: 5 });
});

test("decoder: ifIndex not in state still resolves to the ifIndex itself (unprotected, not safe)", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  const d = decode(ACME_CFG + ".1.1.2.999");
  assert.deepEqual(d, { port: 999 });
});

test("decoder: dot1q vlan-first table cell -> { vlan } from the leading suffix integer", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  // acmeVlanCfgName instance for VLAN 20.
  const d = decode(ACME_CFG + ".2.1.1.20");
  assert.deepEqual(d, { vlan: 20 });
});

test("decoder: an OID under no enumerated column -> null (undecodable)", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  assert.equal(decode("1.3.6.1.4.1.12345.7.7.7.1"), null);
});

test("decoder: non-numeric input -> null", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  assert.equal(decode("not.an.oid"), null);
});
