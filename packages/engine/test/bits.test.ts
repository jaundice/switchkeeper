import { test } from "node:test";
import assert from "node:assert/strict";
import { describeObject } from "../src/mibSyntax.ts";
import { editToVarbinds } from "../src/apply.ts";
import type { MibStore, MibObject } from "../src/mib.ts";
import type { DeviceState, Edit } from "../src/model.ts";

// Polish deliverable #3 (cross-cutting BITS contract): describeObject parses
//   BITS { name(0), name(1), ... }
// into MibSyntax.enums where VALUE IS THE BIT POSITION (0-based, per SMI), with base "bits" and the
// OCTET STRING wire type. The setObject write path then accepts the UI's ENCODED octet-string/hex
// value and builds an OctetString varbind (it must NOT utf8-encode the hex text).

const VENDOR_MIB = `
ACMEB-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE FROM SNMPv2-SMI;

acmeCapabilities OBJECT-TYPE
    SYNTAX      BITS { other(0), speed10(1), speed100(2), speed1000(3), fullDuplex(4) }
    MAX-ACCESS  read-write
    STATUS      current
    DESCRIPTION "A capability bit string."
    ::= { acmeb 1 }

END
`;

const OBJ: Record<string, MibObject> = {
  acmeCapabilities: { name: "acmeCapabilities", oid: "1.3.6.1.4.1.97.1", module: "ACMEB-MIB" },
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
    loadedModules: () => ["ACMEB-MIB"],
    indexedModules: () => ["ACMEB-MIB"],
    moduleText: (m: string) => (m === "ACMEB-MIB" ? VENDOR_MIB : null),
    sourceFor: (symbolOrOid: string) => {
      let obj = OBJ[symbolOrOid] ?? byOid.get(symbolOrOid) ?? null;
      if (!obj && /^[0-9]+(\.[0-9]+)*$/.test(symbolOrOid)) {
        for (const o of byOid.values()) {
          if (symbolOrOid === o.oid || symbolOrOid.startsWith(o.oid + ".")) obj = o;
        }
      }
      if (!obj) return null;
      return { module: "ACMEB-MIB", file: "ACMEB-MIB.mib", text: VENDOR_MIB, object: obj };
    },
  };
}

function state(): DeviceState {
  return {
    device: { id: "d", host: "d", transport: "snmpV2c", reachable: true },
    ports: [],
    vlans: [],
    lags: [],
    readAt: new Date().toISOString(),
  };
}

test("describeObject: BITS -> base bits, OctetString snmpType, enums valued by BIT POSITION", () => {
  const s = describeObject(fakeStore(), "acmeCapabilities");
  assert.ok(s);
  assert.equal(s.base, "bits");
  assert.equal(s.snmpType, 4); // OctetString on the wire
  // Per the contract: value === the bit position (NOT a re-numbered enum).
  assert.deepEqual(s.enums, [
    { label: "other", value: 0 },
    { label: "speed10", value: 1 },
    { label: "speed100", value: 2 },
    { label: "speed1000", value: 3 },
    { label: "fullDuplex", value: 4 },
  ]);
});

test("setObject (bits): UI's encoded hex octet-string -> OctetString varbind with those raw bytes", () => {
  // UI selects bits 1 and 4 -> big-endian bit string: bit p in byte p>>3, mask 0x80>>(p&7).
  //   bit1 -> 0x40, bit4 -> 0x08 -> byte0 = 0x48.
  const edit: Edit = { kind: "setObject", oid: "1.3.6.1.4.1.97.1.0", name: "acmeCapabilities", value: "48" };
  const vbs = editToVarbinds(edit, state(), fakeStore());
  assert.equal(vbs.length, 1);
  assert.equal(vbs[0].type, 4); // OctetString
  assert.ok(Buffer.isBuffer(vbs[0].value));
  assert.deepEqual([...(vbs[0].value as Buffer)], [0x48]); // raw byte, NOT the ascii of "48"
});

test("setObject (bits): hex with separators/0x is tolerated (hexToBytes strips non-hex)", () => {
  const edit: Edit = { kind: "setObject", oid: "1.3.6.1.4.1.97.1.0", name: "acmeCapabilities", value: "48 00" };
  const vbs = editToVarbinds(edit, state(), fakeStore());
  assert.deepEqual([...(vbs[0].value as Buffer)], [0x48, 0x00]);
});

test("setObject (bits): empty value -> a valid zero-length OCTET STRING (all bits clear)", () => {
  const edit: Edit = { kind: "setObject", oid: "1.3.6.1.4.1.97.1.0", name: "acmeCapabilities", value: "" };
  const vbs = editToVarbinds(edit, state(), fakeStore());
  assert.equal((vbs[0].value as Buffer).length, 0);
});

test("setObject (bits): an explicit snmpType still routes through bits coercion via the resolved base", () => {
  // Even if the edit carries snmpType=4 (OctetString), the base resolves to "bits" so we hex-decode.
  const edit: Edit = { kind: "setObject", oid: "1.3.6.1.4.1.97.1.0", name: "acmeCapabilities", value: "C0", snmpType: 4 };
  const vbs = editToVarbinds(edit, state(), fakeStore());
  assert.deepEqual([...(vbs[0].value as Buffer)], [0xc0]);
});
