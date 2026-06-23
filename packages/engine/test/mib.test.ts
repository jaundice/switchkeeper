import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMibStore } from "../src/mib.ts";
import { mibPointersFor, mibSearchUrl, hasCuratedMibSource } from "../src/mibSources.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "fixtures");

test("loadFile parses a MIB and resolves symbols to OIDs", () => {
  const store = createMibStore();
  const mod = store.loadFile(join(fixtures, "SWITCHKEEPER-TEST-MIB.mib"));
  assert.equal(mod, "SWITCHKEEPER-TEST-MIB");
  assert.ok(store.loadedModules().includes("SWITCHKEEPER-TEST-MIB"));

  const scalar = store.findOid("skScalar");
  assert.ok(scalar, "skScalar should resolve");
  assert.equal(scalar!.oid, "1.3.6.1.4.1.99999.1");

  const ro = store.findOid("skReadOnly");
  assert.ok(ro, "skReadOnly should resolve");
  assert.equal(ro!.oid, "1.3.6.1.4.1.99999.2");

  assert.equal(store.findOid("doesNotExist"), null);
});

test("indexDir indexes modules without loading them", () => {
  const store = createMibStore();
  const n = store.indexDir(fixtures);
  assert.ok(n >= 1, "should index at least one module");
  assert.ok(store.indexedModules().includes("SWITCHKEEPER-TEST-MIB"));
});

test("providers lists a module's objects", () => {
  const store = createMibStore();
  store.loadFile(join(fixtures, "SWITCHKEEPER-TEST-MIB.mib"));
  const names = store.providers("SWITCHKEEPER-TEST-MIB").map((p) => p.name);
  assert.ok(names.includes("skScalar"));
});

test("mibPointersFor: curated links for known vendors + universal search fallback", () => {
  const ng = mibPointersFor(4526);
  assert.equal(ng.vendor, "Netgear");
  assert.ok(ng.links.some((l) => /netgear/i.test(l.url)), "expected a Netgear link");
  assert.ok(ng.links.some((l) => l.url.startsWith("https://duckduckgo.com/")), "expected a search fallback");

  const cisco = mibPointersFor(9);
  assert.equal(cisco.vendor, "Cisco");

  const unknown = mibPointersFor(123456);
  assert.equal(unknown.links.length, 1, "unknown vendor still gets a search link");
  assert.ok(unknown.links[0].url.startsWith("https://duckduckgo.com/"));

  assert.equal(hasCuratedMibSource(4526), true);
  assert.equal(hasCuratedMibSource(123456), false);
  assert.ok(mibSearchUrl("Foo X1").includes("SNMP+MIB+download") || mibSearchUrl("Foo X1").includes("SNMP%20MIB%20download"));
});
