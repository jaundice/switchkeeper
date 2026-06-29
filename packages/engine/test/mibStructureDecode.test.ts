import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRowDecoder } from "../src/mibStructure.ts";
import type { MibStore, MibObject } from "../src/mib.ts";
import type { DeviceState } from "../src/model.ts";

// Polish deliverable #2: buildRowDecoder now decodes more INDEX shapes:
//  (a) a single bridge-port index (dot1dBasePort & friends)            -> { port }
//  (b) a leading ifIndex EVEN WITH trailing index parts                 -> { port }
//  (c) a leading VLAN id with trailing index parts                      -> { vlan }
// while staying conservative: an unrecognised leading index element, or a bridge-port index whose
// value isn't a port we actually read, stays null (risky).
//
// Fixture MIB with four tables, one per shape we want to exercise. enumerateModule parses the raw
// text (columns aren't in providers), so we seed only the group/table/entry OIDs as providers.

const VENDOR_MIB = `
ACME2-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE, Integer32 FROM SNMPv2-SMI
        ifIndex FROM IF-MIB
        dot1dBasePort FROM BRIDGE-MIB
        dot1qVlanIndex FROM Q-BRIDGE-MIB;

-- (a) single bridge-port index
acmeBpTable OBJECT-TYPE SYNTAX SEQUENCE OF AcmeBpEntry MAX-ACCESS not-accessible STATUS current
    DESCRIPTION "bp" ::= { acme2 1 }
acmeBpEntry OBJECT-TYPE SYNTAX AcmeBpEntry MAX-ACCESS not-accessible STATUS current
    DESCRIPTION "r" INDEX { dot1dBasePort } ::= { acmeBpTable 1 }
acmeBpFlag OBJECT-TYPE SYNTAX Integer32 MAX-ACCESS read-write STATUS current
    DESCRIPTION "c" ::= { acmeBpEntry 1 }

-- (b) ifIndex with a trailing index part (composite index)
acmeIfQTable OBJECT-TYPE SYNTAX SEQUENCE OF AcmeIfQEntry MAX-ACCESS not-accessible STATUS current
    DESCRIPTION "ifq" ::= { acme2 2 }
acmeIfQEntry OBJECT-TYPE SYNTAX AcmeIfQEntry MAX-ACCESS not-accessible STATUS current
    DESCRIPTION "r" INDEX { ifIndex, acmeQueueId } ::= { acmeIfQTable 1 }
acmeIfQWeight OBJECT-TYPE SYNTAX Integer32 MAX-ACCESS read-write STATUS current
    DESCRIPTION "c" ::= { acmeIfQEntry 1 }

-- (c) VLAN with a trailing index part
acmeVlanXTable OBJECT-TYPE SYNTAX SEQUENCE OF AcmeVlanXEntry MAX-ACCESS not-accessible STATUS current
    DESCRIPTION "vx" ::= { acme2 3 }
acmeVlanXEntry OBJECT-TYPE SYNTAX AcmeVlanXEntry MAX-ACCESS not-accessible STATUS current
    DESCRIPTION "r" INDEX { dot1qVlanIndex, ifIndex } ::= { acmeVlanXTable 1 }
acmeVlanXFlag OBJECT-TYPE SYNTAX Integer32 MAX-ACCESS read-write STATUS current
    DESCRIPTION "c" ::= { acmeVlanXEntry 1 }

-- a table whose index element we DON'T recognise -> must stay null (risky)
acmeOpaqueTable OBJECT-TYPE SYNTAX SEQUENCE OF AcmeOpaqueEntry MAX-ACCESS not-accessible STATUS current
    DESCRIPTION "op" ::= { acme2 4 }
acmeOpaqueEntry OBJECT-TYPE SYNTAX AcmeOpaqueEntry MAX-ACCESS not-accessible STATUS current
    DESCRIPTION "r" INDEX { acmeOpaqueId } ::= { acmeOpaqueTable 1 }
acmeOpaqueVal OBJECT-TYPE SYNTAX Integer32 MAX-ACCESS read-write STATUS current
    DESCRIPTION "c" ::= { acmeOpaqueEntry 1 }

END
`;

const ACME2 = "1.3.6.1.4.1.98";
const PROVIDERS: MibObject[] = [
  { name: "acme2", oid: ACME2, module: "ACME2-MIB" },
  { name: "acmeBpTable", oid: ACME2 + ".1", module: "ACME2-MIB" },
  { name: "acmeBpEntry", oid: ACME2 + ".1.1", module: "ACME2-MIB" },
  { name: "acmeIfQTable", oid: ACME2 + ".2", module: "ACME2-MIB" },
  { name: "acmeIfQEntry", oid: ACME2 + ".2.1", module: "ACME2-MIB" },
  { name: "acmeVlanXTable", oid: ACME2 + ".3", module: "ACME2-MIB" },
  { name: "acmeVlanXEntry", oid: ACME2 + ".3.1", module: "ACME2-MIB" },
  { name: "acmeOpaqueTable", oid: ACME2 + ".4", module: "ACME2-MIB" },
  { name: "acmeOpaqueEntry", oid: ACME2 + ".4.1", module: "ACME2-MIB" },
];

function fakeStore(): MibStore {
  const byName = new Map(PROVIDERS.map((p) => [p.name, p]));
  return {
    indexDir: () => 0,
    loadFile: () => null,
    loadDir: () => ({ loaded: 0, skipped: [] }),
    loadDirFromCache: () => false,
    loadModule: () => false,
    providers: (m: string) => (m === "ACME2-MIB" ? PROVIDERS : []),
    findOid: (s: string) => byName.get(s) ?? null,
    loadedModules: () => ["ACME2-MIB"],
    indexedModules: () => ["ACME2-MIB"],
    moduleText: (m: string) => (m === "ACME2-MIB" ? VENDOR_MIB : null),
    sourceFor: (symbolOrOid: string) => {
      const obj = byName.get(symbolOrOid);
      if (obj) return { module: "ACME2-MIB", file: "ACME2-MIB.mib", text: VENDOR_MIB, object: obj };
      if (/^[A-Za-z]/.test(symbolOrOid)) {
        return {
          module: "ACME2-MIB",
          file: "ACME2-MIB.mib",
          text: VENDOR_MIB,
          object: { name: symbolOrOid, oid: "0", module: "ACME2-MIB" },
        };
      }
      return null;
    },
  };
}

function state(): DeviceState {
  return {
    device: { id: "d", host: "d", transport: "snmpV2c", reachable: true },
    ports: [
      // ifIndex 10 -> bridgePort 3; ifIndex 49 -> bridgePort 49.
      { ifIndex: 10, bridgePort: 3, name: "g10", kind: "physical", adminStatus: "up", operStatus: "up", taggedVlans: [] },
      { ifIndex: 49, bridgePort: 49, name: "g49", kind: "physical", adminStatus: "up", operStatus: "up", taggedVlans: [] },
    ],
    vlans: [{ vid: 20, members: { tagged: [], untagged: [] }, active: true, source: "current" }],
    lags: [],
    readAt: new Date().toISOString(),
  };
}

test("decoder (a): single bridge-port index -> { port } when the value is a known bridge port", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  // acmeBpFlag instance for bridge port 3 (a known bridge port).
  assert.deepEqual(decode(ACME2 + ".1.1.1.3"), { port: 3 });
});

test("decoder (a): bridge-port index whose value is NOT a known bridge port -> null (stays risky)", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  // bridge port 77 isn't one we read -> can't be confident -> null.
  assert.equal(decode(ACME2 + ".1.1.1.77"), null);
});

test("decoder (b): leading ifIndex with a trailing index part -> { port } via state map", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  // acmeIfQWeight instance for ifIndex 10, queue 2 -> port = bridgePort 3.
  assert.deepEqual(decode(ACME2 + ".2.1.1.10.2"), { port: 3 });
});

test("decoder (b): leading ifIndex (composite) unknown to state -> the ifIndex itself", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  // ifIndex 200 not in state -> returns the ifIndex (unprotected, not safe).
  assert.deepEqual(decode(ACME2 + ".2.1.1.200.5"), { port: 200 });
});

test("decoder (c): leading VLAN id with a trailing index part -> { vlan } from the leading integer", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  // acmeVlanXFlag instance for VLAN 20, ifIndex 49 -> { vlan: 20 } (trailing parts ignored).
  assert.deepEqual(decode(ACME2 + ".3.1.1.20.49"), { vlan: 20 });
});

test("decoder: an unrecognised leading index element -> null (conservative, stays risky)", () => {
  const decode = buildRowDecoder(fakeStore(), state());
  assert.equal(decode(ACME2 + ".4.1.1.5"), null);
});
