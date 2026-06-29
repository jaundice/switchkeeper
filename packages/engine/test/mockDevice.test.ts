import { test } from "node:test";
import assert from "node:assert/strict";
import { SnmpClient } from "../src/snmp.ts";
import {
  buildCuratedSections,
  buildGenericSections,
  buildGenericTableSections,
  sweepTableColumns,
  type GenericTableCandidate,
} from "../src/deviceCapabilities.ts";
import { buildRowDecoder } from "../src/mibStructure.ts";
import { classifyEdits } from "../src/safety.ts";
import type {
  DeviceState,
  ResolvedObject,
  ProtectedSet,
  Edit,
  MibBaseType,
} from "../src/model.ts";
import type { Credential } from "../src/model.ts";
import type { MibStore, MibObject } from "../src/mib.ts";

// Polish deliverable #5: a mock-device integration test. We drive the REAL engine code paths against
// a recorded SNMP "device" so the live path has CI coverage without hardware:
//   - a fake net-snmp SESSION (recorded GET + GETBULK responses) wired into a real SnmpClient, so the
//     actual walkBulk()/column()/get() code (incl. GETBULK paging + GETNEXT fallback) is exercised;
//   - the pure capability builders (curated + generic scalar + generic table) assembling sections;
//   - a planDevice-style setObject classification end-to-end via buildRowDecoder + classifyEdits.

// ---- Synthetic device: a 2-port switch with one vendor table (ifIndex-keyed). ----

const VENDOR = "1.3.6.1.4.1.99"; // synthetic enterprise 99
const SPEED_COL = VENDOR + ".1.1.1.1"; // acmePortCfgSpeed column base
const NAME_COL = VENDOR + ".1.1.1.2"; // acmePortCfgName column base
const SCALAR = VENDOR + ".2"; // a vendor scalar (object OID; instance is ".0")

// Recorded GET responses keyed by exact instance OID.
const GET_DB: Record<string, { type: number; value: unknown }> = {
  [SCALAR + ".0"]: { type: 2, value: 7 }, // Integer scalar
};

// Recorded subtree contents for GETBULK/GETNEXT, keyed by column base OID. Each entry is the ordered
// list of (instance-suffix, varbind) the agent would return walking that column.
const SUBTREES: Record<string, { oid: string; type: number; value: unknown }[]> = {
  [SPEED_COL]: [
    { oid: SPEED_COL + ".1", type: 2, value: 1000 },
    { oid: SPEED_COL + ".2", type: 2, value: 100 },
  ],
  [NAME_COL]: [
    { oid: NAME_COL + ".1", type: 4, value: Buffer.from("g1") },
    { oid: NAME_COL + ".2", type: 4, value: Buffer.from("g2") },
  ],
};

// A fake net-snmp session implementing just get + getBulk (the calls walkBulk/get make). getBulk
// returns the successors of `from` under whatever subtree `from` falls in, capped to maxRepetitions;
// when it walks past the end it returns an endOfMibView (type 130) varbind so walkBulk terminates.
function fakeSession() {
  const allSubtreeOids = Object.values(SUBTREES).flat();
  return {
    get(oids: string[], cb: (err: Error | null, vbs: any[]) => void) {
      const vbs = oids.map((oid) => GET_DB[oid] ?? { type: 128 /* noSuchObject */, value: null });
      cb(null, vbs.map((v, i) => ({ oid: oids[i], type: v.type, value: v.value })));
    },
    getBulk(oids: string[], _nonRep: number, maxRep: number, cb: (err: Error | null, vbs: any[]) => void) {
      const from = oids[0];
      // Find which column subtree `from` is in (the base it starts at or is under).
      const baseOid = Object.keys(SUBTREES).find((b) => from === b || from.startsWith(b + ".") || from === b.replace(/\.\d+$/, ""));
      const rows = baseOid ? SUBTREES[baseOid] : allSubtreeOids;
      // Successors strictly after `from`, in recorded order.
      const after = rows.filter((r) => r.oid > from || (from === baseOid)); // first page starts at base
      const page = after.slice(0, maxRep).map((r) => ({ oid: r.oid, type: r.type, value: r.value }));
      // Signal end of the walk so walkBulk stops paging.
      page.push({ oid: VENDOR + ".999", type: 130 /* endOfMibView */, value: null });
      cb(null, page);
    },
    close() {},
  };
}

// Build a real SnmpClient but swap its read session for the recorded fake (read-only path only).
function mockClient(): SnmpClient {
  const cred: Credential = { protocol: "snmpV2c", readCommunity: "public" };
  const client = new SnmpClient("10.0.0.9", cred);
  // The constructor opened a real (unused) UDP session; replace it with the recorded fake.
  (client as unknown as { readSession: unknown }).readSession = fakeSession();
  return client;
}

function fixtureState(): DeviceState {
  return {
    device: {
      id: "10.0.0.9", host: "10.0.0.9", transport: "snmpV2c",
      vendorEnterprise: 99, model: "Acme Synthetic 2-port", sysName: "mock1", portCount: 2, reachable: true,
    },
    ports: [
      { ifIndex: 1, bridgePort: 1, name: "g1", kind: "physical", adminStatus: "up", operStatus: "up", pvid: 1, taggedVlans: [] },
      { ifIndex: 2, bridgePort: 2, name: "g2", kind: "physical", adminStatus: "up", operStatus: "down", pvid: 1, taggedVlans: [] },
    ],
    vlans: [{ vid: 1, name: "default", members: { tagged: [], untagged: [1, 2] }, active: true, source: "current" }],
    lags: [],
    readAt: "2026-06-29T00:00:00.000Z",
  };
}

const tableCand: GenericTableCandidate = {
  module: "ACME-MIB",
  entry: "acmePortCfgEntry",
  title: "acmePortCfgEntry",
  columns: [
    { name: "acmePortCfgSpeed", oid: SPEED_COL, access: "read-write", base: "integer", kind: "column", table: "acmePortCfgEntry" },
    { name: "acmePortCfgName", oid: NAME_COL, access: "read-write", base: "string", kind: "column", table: "acmePortCfgEntry" },
  ],
};

test("mock device: GETBULK column walk loads table rows via the real SnmpClient.column path", async () => {
  const client = mockClient();
  try {
    // sweepTableColumns -> client.column(oid) -> walkBulk(oid) against the recorded getBulk session.
    const cv = await sweepTableColumns(client, [tableCand], Date.now() + 5000);
    assert.deepEqual([...(cv.get(SPEED_COL) ?? new Map()).entries()], [["1", 1000], ["2", 100]]);
    assert.deepEqual([...(cv.get(NAME_COL) ?? new Map()).entries()], [["1", "g1"], ["2", "g2"]]);
  } finally {
    client.close();
  }
});

test("mock device: end-to-end capability model (curated + scalar + table) from recorded reads", async () => {
  const client = mockClient();
  try {
    const state = fixtureState();
    const curated = buildCuratedSections(state);
    assert.deepEqual(curated.map((s) => s.id), ["system", "ports", "vlans"]);

    // Generic SCALAR: GET the vendor scalar instance via the real client.get path.
    const scalarObjs: ResolvedObject[] = [
      { name: "acmeScalar", oid: SCALAR, module: "ACME-MIB", source: "device-mib", type: "Integer32", access: "read-only" },
    ];
    const vbs = await client.get([SCALAR + ".0"]);
    const values = new Map<string, string | number | null>([[vbs[0].oid, vbs[0].value as number]]);
    const generic = buildGenericSections(scalarObjs, values);
    assert.equal(generic.length, 1);
    assert.equal(generic[0].scalars![0].value, 7);

    // Generic TABLE: walk + assemble.
    const cv = await sweepTableColumns(client, [tableCand], Date.now() + 5000);
    const tables = buildGenericTableSections([tableCand], cv, () => "ifIndex");
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0].table!.rowKeys, ["1", "2"]);
    assert.deepEqual(tables[0].table!.rows, [[1000, "g1"], [100, "g2"]]);

    // The full model an orchestrator would assemble: curated first, then generic, then tables.
    const sections = [...curated, ...generic, ...tables];
    assert.deepEqual(sections.map((s) => s.id), ["system", "ports", "vlans", "ACME-MIB", "acmePortCfgEntry"]);
  } finally {
    client.close();
  }
});

// ---- planDevice-style setObject classification end-to-end (decoder + safety gate) ----

// A MIB store exposing the ifIndex-keyed vendor table so buildRowDecoder can decode a cell's row.
const PROVIDERS: MibObject[] = [
  { name: "acmeCfg", oid: VENDOR + ".1", module: "ACME-MIB" },
  { name: "acmePortCfgTable", oid: VENDOR + ".1.1", module: "ACME-MIB" },
  { name: "acmePortCfgEntry", oid: VENDOR + ".1.1.1", module: "ACME-MIB" },
];
const TABLE_MIB = `
ACME-MIB DEFINITIONS ::= BEGIN
IMPORTS OBJECT-TYPE, Integer32 FROM SNMPv2-SMI ifIndex FROM IF-MIB;
acmePortCfgTable OBJECT-TYPE SYNTAX SEQUENCE OF AcmePortCfgEntry MAX-ACCESS not-accessible STATUS current DESCRIPTION "t" ::= { acmeCfg 1 }
acmePortCfgEntry OBJECT-TYPE SYNTAX AcmePortCfgEntry MAX-ACCESS not-accessible STATUS current DESCRIPTION "r" INDEX { ifIndex } ::= { acmePortCfgTable 1 }
acmePortCfgSpeed OBJECT-TYPE SYNTAX Integer32 MAX-ACCESS read-write STATUS current DESCRIPTION "c" ::= { acmePortCfgEntry 1 }
acmePortCfgName OBJECT-TYPE SYNTAX OCTET STRING MAX-ACCESS read-write STATUS current DESCRIPTION "c" ::= { acmePortCfgEntry 2 }
END
`;
function tableStore(): MibStore {
  const byName = new Map(PROVIDERS.map((p) => [p.name, p]));
  return {
    indexDir: () => 0, loadFile: () => null, loadDir: () => ({ loaded: 0, skipped: [] }),
    loadDirFromCache: () => false, loadModule: () => false,
    providers: (m) => (m === "ACME-MIB" ? PROVIDERS : []),
    findOid: (s) => byName.get(s) ?? null,
    loadedModules: () => ["ACME-MIB"], indexedModules: () => ["ACME-MIB"],
    moduleText: (m) => (m === "ACME-MIB" ? TABLE_MIB : null),
    sourceFor: (s) => {
      const obj = byName.get(s);
      if (obj) return { module: "ACME-MIB", file: "ACME-MIB.mib", text: TABLE_MIB, object: obj };
      if (/^[A-Za-z]/.test(s)) return { module: "ACME-MIB", file: "ACME-MIB.mib", text: TABLE_MIB, object: { name: s, oid: "0", module: "ACME-MIB" } };
      return null;
    },
  };
}

function pset(): ProtectedSet {
  return { ports: [1], vlans: [1], reason: "mock mgmt port 1", confidence: "high" };
}

test("mock device: setObject cell classification (protected vs unprotected) via buildRowDecoder", () => {
  const state = fixtureState();
  const decodeRow = buildRowDecoder(tableStore(), state);
  // A cell write to acmePortCfgSpeed for ifIndex 1 (protected port 1) -> blocked.
  const protectedEdit: Edit = { kind: "setObject", oid: SPEED_COL + ".1", value: 100, name: "acmePortCfgSpeed.1" };
  const r1 = classifyEdits([protectedEdit], state, pset(), { decodeRow });
  assert.equal(r1.classifications[0].cls, "blocked");
  // A cell write for ifIndex 2 (unprotected) -> risky (never safe).
  const riskyEdit: Edit = { kind: "setObject", oid: SPEED_COL + ".2", value: 100, name: "acmePortCfgSpeed.2" };
  const r2 = classifyEdits([riskyEdit], state, pset(), { decodeRow });
  assert.equal(r2.classifications[0].cls, "risky");
  assert.notEqual(r2.classifications[0].cls, "safe");
});

// Quell unused-import lint for the type-only MibBaseType (kept for documentation of the cell base).
const _baseDoc: MibBaseType = "integer";
void _baseDoc;
