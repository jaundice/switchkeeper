# Phase 1 build contract (engine ⇆ surfaces)

This pins the boundary between the engine layer and the surfaces/UI layer so they can be built
in parallel. Both sides MUST conform to the type shapes and function signatures below. Read-only
only — Phase 1 introduces **no writes** of any kind.

## Shared types (exported from `@switchkeeper/engine` via `model.ts`)

```ts
export type ObjectAccess = "read-only" | "read-write" | "not-accessible" | "unknown";

// A symbol resolved to an OID + metadata, with provenance.
export interface ResolvedObject {
  name: string;                 // symbol, e.g. "extremePortName" or "ifName"
  oid: string;                  // numeric OID (no trailing instance)
  module: string;               // defining MIB module, or "standard" / a profile name
  source: "device-mib" | "standard" | "profile";
  type?: string;                // human SYNTAX label if known (e.g. "Integer32", "DisplayString")
  access?: ObjectAccess;        // from MIB MAX-ACCESS where known
}

// One displayed value (scalar) or table.
export interface CapabilityValue {
  name: string;                 // label (symbol or friendly name)
  oid: string;                  // fully-qualified OID that was read
  value: string | number | null;
  type?: string;
}
export interface CapabilityTable {
  columns: string[];
  rows: (string | number | null)[][];
}

// A UI section. Only emitted when it actually has content for this device.
export interface CapabilitySection {
  id: string;                   // "system" | "ports" | "vlans" | "poe" | "sensors" | "lldp" | "lag" | "stacking" | <module> for generic
  title: string;                // human title
  kind: "curated" | "generic";  // generic sections are gated behind Advanced mode in the UI
  scalars?: CapabilityValue[];
  table?: CapabilityTable;
}

// The whole adaptive model the UI renders.
export interface CapabilityModel {
  host: string;
  vendor: string;               // profile name or "Unknown"
  mibs: { loaded: number; indexed: number };  // 0/0 if no MIBs loaded
  sections: CapabilitySection[]; // in display order; curated first, then generic
}
```

## Engine functions (owned by the engine agent)

```ts
// objectResolver.ts
export interface ObjectResolver {
  resolve(name: string): ResolvedObject | null; // device-mib → standard (oids.ts) → profile
}
export function createObjectResolver(mib: MibStore): ObjectResolver;

// deviceCapabilities.ts
//  Reads a live device and returns the adaptive model. Builds curated sections from the existing
//  DeviceState (readDevice) and generic sections from readable vendor objects in the MIB store.
//  Falls back gracefully: with no MIBs loaded, only the standard curated sections appear and the
//  result matches today's behaviour. MUST NOT perform any SNMP SET.
export async function readDeviceCapabilities(
  host: string,
  credential: Credential,
  mib: MibStore,
): Promise<CapabilityModel>;
```

Also export a convenience that the surfaces call (mirrors `readDevice`):
`export async function readCapabilities(host, credential, mib): Promise<CapabilityModel>` — or just
`readDeviceCapabilities`. Surfaces will import **`readDeviceCapabilities`** and the types above.

## Surfaces (owned by the surfaces agent)

- HTTP: `POST /api/capabilities` body `{ host, cred }` → `{ ok: true, data: CapabilityModel }`
  (mirror the existing `/api/read` wrapper + `credFromWeb`). The server already builds a shared
  `mibStore()`; pass it in.
- IPC (desktop `main.cjs`): `ipcMain.handle("switch:capabilities", { host, cred }) → { ok, data }`,
  using the desktop's `ensureMibStore()`.
- MCP tool: `switch_capabilities` (input `{ host, community? }`) → `ok(model)`.
- Web bridge (`web-bridge.js`): add `capabilities: (req) => post("/api/capabilities", req)`.
- Renderer (`app.js` + `index.html`): an adaptive view that renders `CapabilityModel.sections`:
  curated sections styled cleanly (key/value for scalars, a table for `table`), generic sections
  rendered the same way but **hidden unless Advanced mode is on**. An "Advanced mode" toggle
  (off by default, visually flagged when on). No edit controls in Phase 1 — display only.

While the engine is being built in parallel, the surfaces agent develops against a **mock**
`CapabilityModel` (hard-coded fixture matching the shapes above) so the UI and endpoints are
complete and testable; final wiring just calls `readDeviceCapabilities`.

## Hard constraints (both agents)

- **ESM with explicit `.ts` import extensions** (e.g. `import { x } from "./model.ts"`).
- Code runs under `node --experimental-strip-types`: **no** TypeScript `enum`, `namespace`,
  parameter properties, or other non-erasable constructs. Use `type` unions, `const` objects,
  plain functions.
- **Read-only**: never call `SnmpClient.set`; do not modify `apply.ts`, `save.ts`, or any write path.
- Engine agent edits only `packages/engine/**`. Surfaces agent edits only
  `packages/mcp/src/server.ts`, `packages/mcp/web/web-bridge.js`, `packages/desktop/main.cjs`,
  `packages/desktop/renderer/{app.js,index.html}`. Do not touch the other side's files.
- Match existing style; comment the "why". Add `node:test` tests under `packages/engine/test/`
  for the engine (resolver fallback + section-building with fixtures — live SNMP is not unit-tested).
- Net-snmp `MibObject` gives `{ name, oid, module, scalarType?, maxAccess? }`. Map `maxAccess`
  to `ObjectAccess`; map `scalarType` to a human `type` label where reasonable.
