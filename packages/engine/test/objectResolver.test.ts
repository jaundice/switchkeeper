import { test } from "node:test";
import assert from "node:assert/strict";
import { createObjectResolver } from "../src/objectResolver.ts";
import type { MibStore, MibObject } from "../src/mib.ts";

// A fake MibStore lets us drive resolution precedence without parsing real MIBs or a live device.
function fakeMib(objects: Record<string, MibObject>): MibStore {
  return {
    indexDir: () => 0,
    loadFile: () => null,
    loadDir: () => ({ loaded: 0, skipped: [] }),
    loadDirFromCache: () => false,
    loadModule: () => false,
    providers: () => [],
    findOid: (sym: string) => objects[sym] ?? null,
    loadedModules: () => [],
    indexedModules: () => [],
  };
}

test("resolve: device-MIB wins over standard and carries type/access metadata", () => {
  // ifName exists in both the device MIB and oids.ts; the device MIB must win.
  const mib = fakeMib({
    ifName: { name: "ifName", oid: "1.3.6.1.2.1.31.1.1.1.1", module: "IF-MIB-VENDOR", scalarType: 4, maxAccess: 2 },
  });
  const r = createObjectResolver(mib).resolve("ifName");
  assert.ok(r);
  assert.equal(r!.source, "device-mib");
  assert.equal(r!.module, "IF-MIB-VENDOR");
  assert.equal(r!.type, "OctetString"); // scalarType 4
  assert.equal(r!.access, "read-only"); // maxAccess 2
});

test("resolve: standard (oids.ts) wins over profile when not in device MIB", () => {
  const r = createObjectResolver(fakeMib({})).resolve("sysName");
  assert.ok(r);
  assert.equal(r!.source, "standard");
  assert.equal(r!.module, "standard");
  // Standard map stores the scalar instance ("...1.5.0"); resolver strips the trailing ".0".
  assert.equal(r!.oid, "1.3.6.1.2.1.1.5");
  assert.equal(r!.type, undefined); // no MIB metadata on the standard tier
});

test("resolve: precedence chain falls through device -> standard -> profile", () => {
  // rlCopyEntryBase happens to live in BOTH oids.ts (standard) and the profile tier; the chain
  // must return "standard" for it (standard is checked before profile). This pins the ordering.
  const r = createObjectResolver(fakeMib({})).resolve("rlCopyEntryBase");
  assert.ok(r);
  assert.equal(r!.source, "standard");
  assert.equal(r!.oid, "1.3.6.1.4.1.89.87.2.1");

  // A device MIB defining the same symbol must shadow the standard hit.
  const mib = fakeMib({
    rlCopyEntryBase: { name: "rlCopyEntryBase", oid: "1.3.6.1.4.1.4526.17.29", module: "NETGEAR-MIB", maxAccess: 3 },
  });
  const d = createObjectResolver(mib).resolve("rlCopyEntryBase");
  assert.equal(d!.source, "device-mib");
  assert.equal(d!.module, "NETGEAR-MIB");
});

test("resolve: unknown symbol returns null", () => {
  assert.equal(createObjectResolver(fakeMib({})).resolve("nopeNotAThing"), null);
});

test("resolve: maxAccess/scalarType mapping edge cases", () => {
  const mib = fakeMib({
    rw: { name: "rw", oid: "1.3.6.1.4.1.1.1", module: "X", scalarType: 2, maxAccess: 3 },
    na: { name: "na", oid: "1.3.6.1.4.1.1.2", module: "X", scalarType: 6, maxAccess: 0 },
    unk: { name: "unk", oid: "1.3.6.1.4.1.1.3", module: "X" }, // no scalarType/maxAccess
  });
  const res = createObjectResolver(mib);
  assert.equal(res.resolve("rw")!.access, "read-write");
  assert.equal(res.resolve("rw")!.type, "Integer32");
  assert.equal(res.resolve("na")!.access, "not-accessible");
  assert.equal(res.resolve("na")!.type, "ObjectIdentifier");
  assert.equal(res.resolve("unk")!.access, "unknown");
  assert.equal(res.resolve("unk")!.type, undefined);
});
