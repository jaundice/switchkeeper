import { test } from "node:test";
import assert from "node:assert/strict";
import { describeObject } from "../src/mibSyntax.ts";
import type { MibStore, MibObject } from "../src/mib.ts";

// ---------------------------------------------------------------------------
// Fixture MIB text + a minimal in-memory MibStore that exposes just the methods describeObject
// needs (sourceFor / moduleText / indexedModules). We don't spin up net-snmp's parser here — the
// spike reads RAW MIB TEXT, so a fixture string is the honest unit under test.
// ---------------------------------------------------------------------------

const VENDOR_MIB = `
ACME-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE, Integer32, Unsigned32 FROM SNMPv2-SMI
        TruthValue FROM SNMPv2-TC;

acmePortDuplex OBJECT-TYPE
    SYNTAX      INTEGER { half(1), full(2), auto(3) }
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION "Configured duplex of the port."
    ::= { acme 1 }

acmeVlanId OBJECT-TYPE
    SYNTAX      Integer32 (1..4094)
    UNITS       "vlan"
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION "The 802.1Q VLAN id."
    ::= { acme 2 }

acmeName OBJECT-TYPE
    SYNTAX      OCTET STRING (SIZE (0..32))
    MAX-ACCESS  read-create
    STATUS      current
    DESCRIPTION "A free-text name."
    ::= { acme 3 }

acmeEnabled OBJECT-TYPE
    SYNTAX      TruthValue
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION "Whether the feature is enabled."
    ::= { acme 4 }

acmeCounter OBJECT-TYPE
    SYNTAX      Integer32
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "A plain integer with no constraints."
    ::= { acme 5 }

acmeSpeed OBJECT-TYPE
    SYNTAX      AcmeSpeed
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION "Speed via a named textual-convention."
    ::= { acme 6 }

AcmeSpeed ::= TEXTUAL-CONVENTION
    STATUS      current
    DESCRIPTION "Link speed enum."
    SYNTAX      INTEGER { s10(1), s100(2), s1000(3) }

END
`;

// A separate module defining a TC that ACME imports, to exercise cross-module TC resolution.
const TC_MIB = `
ACME-TC DEFINITIONS ::= BEGIN
AcmeRange ::= TEXTUAL-CONVENTION
    STATUS current
    DESCRIPTION "A constrained unsigned."
    SYNTAX  Unsigned32 (0..100)
END
`;

const MODULES: Record<string, string> = { "ACME-MIB": VENDOR_MIB, "ACME-TC": TC_MIB };

// Object OIDs for the symbols above (arbitrary but consistent).
const OBJ: Record<string, MibObject> = {
  acmePortDuplex: { name: "acmePortDuplex", oid: "1.3.6.1.4.1.99.1", module: "ACME-MIB" },
  acmeVlanId: { name: "acmeVlanId", oid: "1.3.6.1.4.1.99.2", module: "ACME-MIB" },
  acmeName: { name: "acmeName", oid: "1.3.6.1.4.1.99.3", module: "ACME-MIB" },
  acmeEnabled: { name: "acmeEnabled", oid: "1.3.6.1.4.1.99.4", module: "ACME-MIB" },
  acmeCounter: { name: "acmeCounter", oid: "1.3.6.1.4.1.99.5", module: "ACME-MIB" },
  acmeSpeed: { name: "acmeSpeed", oid: "1.3.6.1.4.1.99.6", module: "ACME-MIB" },
};

function fakeStore(): MibStore {
  const byOid = new Map<string, MibObject>();
  for (const o of Object.values(OBJ)) byOid.set(o.oid, o);
  return {
    indexDir: () => 0,
    loadFile: () => null,
    loadDir: () => ({ loaded: 0, skipped: [] }),
    loadDirFromCache: () => false,
    loadModule: () => false,
    providers: () => [],
    findOid: (s: string) => OBJ[s] ?? null,
    loadedModules: () => Object.keys(MODULES),
    indexedModules: () => Object.keys(MODULES),
    moduleText: (m: string) => MODULES[m] ?? null,
    sourceFor: (symbolOrOid: string) => {
      // Mirror the real MibStore.sourceFor: symbol -> object, or numeric OID -> the longest object
      // OID that the requested OID equals or sits under (so an instance OID like "<obj>.0" resolves).
      let obj = OBJ[symbolOrOid] ?? byOid.get(symbolOrOid) ?? null;
      if (!obj && /^[0-9]+(\.[0-9]+)*$/.test(symbolOrOid)) {
        for (const o of byOid.values()) {
          if (symbolOrOid === o.oid || symbolOrOid.startsWith(o.oid + ".")) {
            if (!obj || o.oid.length > obj.oid.length) obj = o;
          }
        }
      }
      if (!obj) return null;
      const text = MODULES[obj.module];
      if (!text) return null;
      return { module: obj.module, file: `${obj.module}.mib`, text, object: obj };
    },
  };
}

// ---------------------------------------------------------------------------
// describeObject — one assertion per SYNTAX construct the contract calls out
// ---------------------------------------------------------------------------

test("inline INTEGER enum -> base enum with labelled values + Integer snmpType", () => {
  const s = describeObject(fakeStore(), "acmePortDuplex");
  assert.ok(s);
  assert.equal(s.base, "enum");
  assert.equal(s.snmpType, 2); // Integer
  assert.deepEqual(s.enums, [
    { label: "half", value: 1 },
    { label: "full", value: 2 },
    { label: "auto", value: 3 },
  ]);
  assert.equal(s.access, "read-write");
  assert.match(s.description ?? "", /duplex/i);
});

test("INTEGER (1..4094) range -> base integer with range + UNITS", () => {
  const s = describeObject(fakeStore(), "acmeVlanId");
  assert.ok(s);
  assert.equal(s.base, "integer");
  assert.equal(s.snmpType, 2);
  assert.deepEqual(s.range, { min: 1, max: 4094 });
  assert.equal(s.units, "vlan");
});

test("OCTET STRING (SIZE (0..32)) -> base string with sizeRange + OctetString snmpType", () => {
  const s = describeObject(fakeStore(), "acmeName");
  assert.ok(s);
  assert.equal(s.base, "string");
  assert.equal(s.snmpType, 4); // OctetString
  assert.deepEqual(s.sizeRange, { min: 0, max: 32 });
  assert.equal(s.access, "read-write"); // read-create normalises to read-write
});

test("TruthValue TC -> base boolean with true(1)/false(2) enum", () => {
  const s = describeObject(fakeStore(), "acmeEnabled");
  assert.ok(s);
  assert.equal(s.base, "boolean");
  assert.equal(s.snmpType, 2);
  assert.equal(s.tc, "TruthValue");
  assert.deepEqual(s.enums, [
    { label: "true", value: 1 },
    { label: "false", value: 2 },
  ]);
});

test("plain Integer32 -> base integer, no range, no enums", () => {
  const s = describeObject(fakeStore(), "acmeCounter");
  assert.ok(s);
  assert.equal(s.base, "integer");
  assert.equal(s.snmpType, 2);
  assert.equal(s.range, undefined);
  assert.equal(s.enums, undefined);
});

test("named TC in the same module is resolved one level (enum)", () => {
  const s = describeObject(fakeStore(), "acmeSpeed");
  assert.ok(s);
  assert.equal(s.base, "enum");
  assert.equal(s.tc, "AcmeSpeed");
  assert.deepEqual(s.enums?.map((e) => e.value), [1, 2, 3]);
});

test("resolve by numeric OID (object OID) works too", () => {
  const s = describeObject(fakeStore(), "1.3.6.1.4.1.99.2");
  assert.ok(s);
  assert.equal(s.base, "integer");
  assert.deepEqual(s.range, { min: 1, max: 4094 });
});

test("resolve by instance OID (object OID + .0) works", () => {
  const s = describeObject(fakeStore(), "1.3.6.1.4.1.99.1.0");
  assert.ok(s);
  assert.equal(s.base, "enum");
});

test("unknown symbol -> null (caller falls back to free-text editor)", () => {
  assert.equal(describeObject(fakeStore(), "noSuchObject"), null);
});
