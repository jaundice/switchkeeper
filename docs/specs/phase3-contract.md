# Phase 3 build contract (generic writes + type-aware editors)

Phase 3 lets a user set any writable vendor object the device's MIBs expose, with editors generated
from the MIB SYNTAX, every write running through the Phase 2 SafetyEngine + the existing
plan→verify→rollback path. Overriding rules carried from Phase 2: **default to the safe side**, a
generic write is **never classified `safe`** (always at least `risky`), writes to IP/SNMP/credential
subtrees are **`blocked`**, and nothing auto-saves to startup.

## Shared types (added to `model.ts`, exported via engine index)

```ts
export type MibBaseType =
  | "integer" | "unsigned" | "enum" | "boolean" | "string" | "oid"
  | "ipaddress" | "counter" | "timeticks" | "bits" | "unknown";

export interface MibEnumValue { label: string; value: number }

// Editor-oriented description of one object's SYNTAX, parsed from the MIB text.
export interface MibSyntax {
  base: MibBaseType;                      // normalized category that picks the editor widget
  snmpType?: number;                      // net-snmp ObjectType code, for building the SET varbind
  enums?: MibEnumValue[];                 // for base "enum"/"boolean"
  range?: { min: number; max: number };  // INTEGER value range, if constrained
  sizeRange?: { min: number; max: number }; // OCTET STRING length range, if constrained
  tc?: string;                            // textual-convention name, if the SYNTAX referenced one
  units?: string;                         // UNITS clause, if present
  description?: string;                   // DESCRIPTION text (trimmed)
  access?: ObjectAccess;                  // MAX-ACCESS (read-write/read-create are editable)
}
```

A new `Edit` kind (append to the union in `model.ts`):

```ts
  | { kind: "setObject"; oid: string; value: string | number; snmpType?: number; name?: string }
```

`oid` is the FULLY-QUALIFIED instance OID being set (e.g. a scalar's `.0`). `name` is optional
(the symbol, for display/audit). `snmpType` is the net-snmp ObjectType code; if omitted the engine
infers it from the resolved MibSyntax.

## Engine (owned by the engine agent — `packages/engine/**` only)

```ts
// mibSyntax.ts  — THE SPIKE: net-snmp's store exposes only base type + maxAccess, so parse the
//   object's OBJECT-TYPE block from its source MIB text for enums/ranges/TC/DESCRIPTION.
export function describeObject(mib: MibStore, symbolOrOid: string): MibSyntax | null;
```

- `describeObject` locates the object's defining module + file via the MibStore, extracts its
  `OBJECT-TYPE … SYNTAX … MAX-ACCESS … DESCRIPTION … ::= { … }` block, and parses:
  - base type + inline `INTEGER { up(1), down(2) }` enums, `INTEGER (0..65535)` ranges,
    `OCTET STRING (SIZE (0..32))` size ranges, `Integer32`, `Unsigned32`/`Gauge32`, `IpAddress`,
    `OBJECT IDENTIFIER`, `TruthValue` → boolean enum true(1)/false(2), etc.
  - one level of TEXTUAL-CONVENTION resolution: if SYNTAX is a named TC, find that TC's definition
    (same module or an imported module the store has) and take its enum/range/base.
  - `MAX-ACCESS`, `UNITS`, `DESCRIPTION`.
  - Map to a `snmpType` (net-snmp ObjectType code) so the apply path can build the varbind.
  - Return null if the object can't be found/parsed (caller falls back to a free-text editor).
- Expose enough on `MibStore` for this (e.g. a method to get an object's module+file+text, or do
  the file read inside `mibSyntax.ts` using the store's existing index). Keep it bounded/safe.

Apply path (`apply.ts`):
- `editToVarbinds` handles `setObject`: build `{ oid, type: snmpType (or inferred from describeObject), value }`.
  Coerce the value to the SNMP type (number for integer/enum/unsigned/timeticks, string/bytes for
  OCTET STRING, dotted string for OID/IpAddress). Reject obviously-wrong values defensively.
- `planChanges` diffs `setObject`: GET the current value for the `before`, the requested value for
  `after` (read-only dry-run; no SET).

SafetyEngine (`safety.ts` — extend `classifyEdits`):
- `setObject` is **never `safe`**. Classify **`blocked`** when the target OID falls in a dangerous
  subtree — at minimum: IP config (`1.3.6.1.2.1.4.` ip, `1.3.6.1.2.1.4.20`/`.22`/`.35` addr/ARP),
  SNMP/admin (`1.3.6.1.6.` snmpModules; `1.3.6.1.2.1.11.` snmp; SNMP community/USM/VACM/target/
  notification), and system control that can drop the link. Otherwise classify **`risky`**.
- Keep a clearly-commented `DANGEROUS_OID_PREFIXES` list so it's auditable and extensible.

Engine index: export `describeObject`, the new types, and ensure `setObject` flows through
`planDevice`/`applyDevice` (they already take `Edit[]`).

Tests (`packages/engine/test/`, node:test): the SYNTAX parser against fixture MIB text covering an
inline enum, an INTEGER range, an OCTET STRING SIZE, a `TruthValue` TC, and a plain `Integer32`;
`classifyEdits` for `setObject` → `risky` on a benign vendor OID and `blocked` on an IP/SNMP OID;
`editToVarbinds` builds a correctly-typed varbind for an enum and a string `setObject`.

## Surfaces (owned by the surfaces agent — server.ts, web-bridge.js, main.cjs, preload.cjs, renderer/*)

- `POST /api/object-meta` body `{ name?: string, oid?: string }` → `{ ok:true, data: MibSyntax|null }`
  using the shared `mibStore()` (no device needed). IPC `switch:object-meta`; web-bridge
  `objectMeta(req)`.
- MCP tool `switch_set_object` `{ host, writeCommunity, oid, value, community?, acknowledge? }` →
  builds one `setObject` edit and calls `applyDevice` (so it goes through the safety gate; risky/
  blocked require `acknowledge`). Description must say writes are gated.
- `setObject` edits flow through the existing `/api/apply` + `switch:apply` unchanged (they take
  `edits[]` + `acknowledge`).
- Renderer (Advanced mode only): in each GENERIC capability section, every `read-write` object gets
  an "Edit" affordance. Clicking fetches `object-meta` and renders the right widget from `MibSyntax.base`:
  enum/boolean → `<select>` of `enums`; integer with `range` → number input bounded to min/max;
  unsigned/integer → number input; string → text (respect `sizeRange` maxlength); show `units` +
  `description` as helper text. Read-only objects stay display-only.
  "Review" runs a dry-run plan (so the SafetyEngine classifies the `setObject` — it will be
  risky/blocked) and routes into the EXISTING Phase 2 gating UI (risky confirm / blocked typed
  confirm, simple mode can't apply). Apply sends the `setObject` edit + the right `acknowledge`.
  Reuse the Phase 1/2 Advanced toggle and the Phase 2 safety review/gating components.

Develop the editor UI against a MOCK `MibSyntax` fixture behind a clearly-commented flag (default
the shipped flag to live / real `object-meta`).

## Hard constraints (both agents)

- ESM, explicit `.ts` import extensions; runs under `node --experimental-strip-types` → NO TS
  `enum`/`namespace`/parameter-properties (use `type` unions / `const` objects).
- Reuse, do not bypass, the Phase 2 SafetyEngine + the existing verify/rollback. A `setObject` must
  be refused without acknowledgement exactly like other risky/blocked edits. Never auto-save.
- Engine agent edits only `packages/engine/**`; surfaces agent edits only the listed surface files.
- Match existing style; comment the "why". Neither agent commits, pushes, or deploys.
