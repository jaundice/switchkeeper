// Phase 2 SafetyEngine. Two responsibilities, both pure / read-only:
//   1. detectProtectedSet() — derive the management path (ports + VLANs we must not strand) from a
//      read-only device read + topology (FDB + LLDP). Conforms to docs/specs/phase2-contract.md.
//   2. classifyEdits() — a PURE classifier mapping each planned Edit to safe/risky/blocked per the
//      contract's classification table.
//
// Overriding principle (contract section 1): DEFAULT TO THE SAFE SIDE. When the management path or an
// edit's effect is uncertain, classify *up* (risky/blocked), never down. detectProtectedSet must
// NEVER return an empty protected set with high confidence.
import type {
  DeviceState,
  Edit,
  FdbEntry,
  LldpNeighbor,
  ProtectedSet,
  EditClassification,
  SafetyReport,
  SafetyClass,
  Port,
} from "./model.ts";

// Heuristic: a bridge port behind which this many distinct MACs are learned is almost certainly an
// uplink/trunk (the management path likely traverses it), not an edge access port.
const UPLINK_FDB_MAC_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Phase 3: generic-write danger list (auditable, extensible)
// ---------------------------------------------------------------------------
// A generic setObject is NEVER "safe". It is "blocked" when its target OID falls under any of these
// subtrees — the standard SNMP/IP/credential management trees where a write can silently strand the
// device or change how it is administered/secured. Each entry is a DOTTED OID PREFIX (matched as a
// subtree: exact OID or any OID that begins with "<prefix>."). Kept here as a clearly-commented
// const so it is auditable in one place and easy to extend per deployment.
//
// NOTE: prefixes intentionally end WITHOUT a trailing dot; isUnderDangerousSubtree appends one so
// "1.3.6.1.2.1.4" matches "1.3.6.1.2.1.4.20.1.1" but NOT a sibling like "1.3.6.1.2.1.40".
export const DANGEROUS_OID_PREFIXES: { prefix: string; why: string }[] = [
  // IP layer (RFC 4293 ip / RFC 1213 ip): addresses, routes, ARP — changing these can drop the
  // management path or repoint the device's own IP.
  { prefix: "1.3.6.1.2.1.4", why: "IP configuration (addresses, routing, ARP)" },
  // SNMP protocol stats/control (RFC 3418 snmp group).
  { prefix: "1.3.6.1.2.1.11", why: "SNMP protocol group (snmp)" },
  // The whole snmpModules subtree: SNMP engine + framework + the credential/admin tables below.
  { prefix: "1.3.6.1.6", why: "SNMP modules (engine/admin/security/notification)" },
  // Explicit credential/admin tables under snmpModules — listed individually so an audit reads
  // exactly which security surfaces are off-limits, even though 1.3.6.1.6 already covers them:
  { prefix: "1.3.6.1.6.3.10", why: "SNMP-FRAMEWORK-MIB (snmpEngine)" },
  { prefix: "1.3.6.1.6.3.11", why: "SNMP-MPD-MIB" },
  { prefix: "1.3.6.1.6.3.12", why: "SNMP-TARGET-MIB (target addresses)" },
  { prefix: "1.3.6.1.6.3.13", why: "SNMP-NOTIFICATION-MIB" },
  { prefix: "1.3.6.1.6.3.15", why: "SNMP-USER-BASED-SM-MIB (USM users/keys)" },
  { prefix: "1.3.6.1.6.3.16", why: "SNMP-VIEW-BASED-ACM-MIB (VACM access control)" },
  { prefix: "1.3.6.1.6.3.18", why: "SNMP-COMMUNITY-MIB (v1/v2c communities)" },
  // System control that can drop the link / reboot (sysName is fine to read; these are write traps):
  // ifAdminStatus column — a generic write here could disable an interface out from under us.
  { prefix: "1.3.6.1.2.1.2.2.1.7", why: "ifAdminStatus (interface enable/disable)" },
];

/** True if `oid` is at or under any dangerous subtree. Subtree match: exact, or prefixed by "<p>.". */
export function isUnderDangerousSubtree(oid: string): { blocked: boolean; why?: string } {
  for (const { prefix, why } of DANGEROUS_OID_PREFIXES) {
    if (oid === prefix || oid.startsWith(prefix + ".")) return { blocked: true, why };
  }
  return { blocked: false };
}

export interface DetectOptions {
  /** MAC of the station the app talks from, if known — lets us pin the exact mgmt access port. */
  sourceMac?: string;
  /** Operator-supplied management VLAN, overriding the heuristic guess. */
  mgmtVlan?: number;
}

// ---------------------------------------------------------------------------
// detectProtectedSet — derive the management path (ports + VLANs)
// ---------------------------------------------------------------------------

export function detectProtectedSet(
  state: DeviceState,
  topo: { fdb: FdbEntry[]; lldp: LldpNeighbor[] },
  opts: DetectOptions = {},
): ProtectedSet {
  const fdb = topo.fdb ?? [];
  const lldp = topo.lldp ?? [];

  const protectedPorts = new Set<number>();
  const reasons: string[] = [];
  // Confidence starts pessimistic; the FDB pin is the only thing that lifts it to "high".
  let confidence: ProtectedSet["confidence"] = "low";

  // 1a. FDB pin: if the app's own source MAC is in the FDB, the bridge port behind it is the mgmt
  //     access port — the single most authoritative signal we have.
  let pinnedPort: number | undefined;
  if (opts.sourceMac) {
    const want = normMac(opts.sourceMac);
    const hit = fdb.find((e) => normMac(e.mac) === want);
    if (hit) {
      pinnedPort = hit.bridgePort;
      protectedPorts.add(hit.bridgePort);
      confidence = "high";
      reasons.push(`management station ${want} learned on port ${hit.bridgePort} (FDB)`);
    }
  }

  // 1b. Uplink ports: a port with many distinct FDB MACs, or one with an LLDP switch/router
  //     neighbour, carries traffic for many stations — the management path likely traverses it.
  const uplinks = detectUplinkPorts(fdb, lldp);
  for (const p of uplinks.ports) protectedPorts.add(p);
  if (uplinks.ports.length) reasons.push(uplinks.reason);

  // 1c. Conservative fallback: if nothing could be pinned (no source MAC hit) and no uplink was
  //     found, protect ALL uplink-looking ports we can infer — i.e. any port that learned more
  //     than one MAC, or, failing that, every bridge port. Better to over-protect than strand.
  if (protectedPorts.size === 0) {
    const fallback = conservativeFallbackPorts(state, fdb);
    for (const p of fallback) protectedPorts.add(p);
    reasons.push(
      `no management station or uplink could be pinned — conservatively protecting ${fallback.length} candidate port(s)`,
    );
    confidence = "low";
  }

  // 2. Management VLAN: PVID of the pinned mgmt access port -> opts.mgmtVlan -> most common PVID ->
  //    VLAN 1. Confidence drops as we go down this list.
  const vlanResult = detectMgmtVlan(state, pinnedPort, opts);
  reasons.push(vlanResult.reason);
  // The VLAN guess can only lower confidence below an FDB-pinned "high", never raise it.
  if (vlanResult.confidence === "low" && confidence !== "low") {
    confidence = confidence === "high" ? "medium" : confidence;
  }

  return {
    ports: [...protectedPorts].sort((a, b) => a - b),
    vlans: vlanResult.vlans,
    reason: reasons.join("; "),
    confidence,
  };
}

/** Uplink ports = bridge ports with many FDB MACs OR an LLDP switch/router neighbour. */
function detectUplinkPorts(
  fdb: FdbEntry[],
  lldp: LldpNeighbor[],
): { ports: number[]; reason: string } {
  const out = new Set<number>();
  const why: string[] = [];

  // Many-MACs heuristic.
  const macsByPort = countDistinctMacsByPort(fdb);
  for (const [port, n] of macsByPort) {
    if (n >= UPLINK_FDB_MAC_THRESHOLD) {
      out.add(port);
      why.push(`port ${port} (${n} MACs learned — likely an uplink)`);
    }
  }

  // LLDP switch/router neighbour heuristic. localPort here is the bridge port number reported by
  // LLDP-MIB's local-port index (matches dot1dBasePort on these devices).
  for (const n of lldp) {
    if (looksLikeInfraNeighbour(n)) {
      out.add(n.localPort);
      const who = n.remoteSysName ? ` (neighbour ${n.remoteSysName})` : "";
      why.push(`port ${n.localPort} has an LLDP switch/router neighbour${who}`);
    }
  }

  return { ports: [...out].sort((a, b) => a - b), reason: why.join(", ") };
}

/**
 * Conservative fallback when nothing could be pinned. Prefer ports that learned >1 MAC (multi-MAC
 * ports are the likeliest uplinks). If none qualify, protect every bridge port — stranding any of
 * them could be the management path, so we refuse to guess "safe".
 */
function conservativeFallbackPorts(state: DeviceState, fdb: FdbEntry[]): number[] {
  const macsByPort = countDistinctMacsByPort(fdb);
  const multi = [...macsByPort].filter(([, n]) => n > 1).map(([p]) => p);
  if (multi.length) return multi.sort((a, b) => a - b);
  const allBridge = state.ports
    .map((p) => p.bridgePort)
    .filter((bp): bp is number => bp !== undefined);
  return [...new Set(allBridge)].sort((a, b) => a - b);
}

/** Management VLAN derivation with honest confidence (see contract protected-set derivation). */
function detectMgmtVlan(
  state: DeviceState,
  pinnedPort: number | undefined,
  opts: DetectOptions,
): { vlans: number[]; reason: string; confidence: "high" | "medium" | "low" } {
  // PVID/untagged VLAN of the pinned mgmt access port (most authoritative).
  if (pinnedPort !== undefined) {
    const p = portByBridge(state, pinnedPort);
    const vid = p?.pvid ?? p?.untaggedVlan;
    if (vid !== undefined) {
      return { vlans: [vid], reason: `mgmt VLAN ${vid} = PVID of mgmt port ${pinnedPort}`, confidence: "high" };
    }
  }
  // Operator override.
  if (opts.mgmtVlan !== undefined) {
    return { vlans: [opts.mgmtVlan], reason: `mgmt VLAN ${opts.mgmtVlan} (operator-supplied)`, confidence: "high" };
  }
  // Most common PVID across ports.
  const common = mostCommonPvid(state.ports);
  if (common !== undefined) {
    return { vlans: [common], reason: `mgmt VLAN ${common} (most common PVID — guessed)`, confidence: "low" };
  }
  // Last resort: VLAN 1.
  return { vlans: [1], reason: "mgmt VLAN 1 (default fallback — no PVID data)", confidence: "low" };
}

// ---------------------------------------------------------------------------
// classifyEdits — PURE classifier (no I/O), implements the contract table exactly
// ---------------------------------------------------------------------------

export function classifyEdits(
  edits: Edit[],
  state: DeviceState,
  protectedSet: ProtectedSet,
): SafetyReport {
  const P = new Set(protectedSet.ports);
  const V = new Set(protectedSet.vlans);
  const classifications = edits.map((edit) => classifyOne(edit, state, P, V));
  return { protectedSet, classifications, worst: worstOf(classifications) };
}

function classifyOne(
  edit: Edit,
  state: DeviceState,
  P: Set<number>,
  V: Set<number>,
): EditClassification {
  switch (edit.kind) {
    case "setPortAdmin": {
      if (edit.up) return cls(edit, "safe", `brings port (ifIndex ${edit.ifIndex}) up — never disconnects`);
      // Disabling a port: resolve ifIndex -> bridgePort to test membership of the protected set.
      const port = state.ports.find((p) => p.ifIndex === edit.ifIndex);
      if (!port || port.bridgePort === undefined) {
        return cls(edit, "risky", `cannot resolve ifIndex ${edit.ifIndex} to a bridge port — effect uncertain`);
      }
      if (P.has(port.bridgePort)) {
        return cls(edit, "blocked", `disables the management port ${port.bridgePort} (${port.name})`);
      }
      return cls(edit, "safe", `disables port ${port.bridgePort} (${port.name}), not a management port`);
    }

    case "setPvid": {
      if (!portByBridge(state, edit.bridgePort)) {
        return cls(edit, "risky", `bridge port ${edit.bridgePort} not found in state — effect uncertain`);
      }
      // blocked: moving the mgmt port's PVID OFF a management VLAN.
      if (P.has(edit.bridgePort) && !V.has(edit.vid)) {
        return cls(edit, "blocked", `moves management port ${edit.bridgePort} to VLAN ${edit.vid} (not a management VLAN)`);
      }
      return cls(edit, "safe", `sets PVID of port ${edit.bridgePort} to ${edit.vid}`);
    }

    case "setVlanMembership": {
      const v = state.vlans.find((x) => x.vid === edit.vid);
      if (!v) {
        return cls(edit, "risky", `VLAN ${edit.vid} not found in state — membership effect uncertain`);
      }
      const egress = new Set<number>([...edit.tagged, ...edit.untagged]);
      const protectedPorts = [...P];
      if (V.has(edit.vid)) {
        // blocked: a protected port is dropped from this management VLAN's egress.
        const wasMember = (bp: number) => v.members.tagged.includes(bp) || v.members.untagged.includes(bp);
        const dropped = protectedPorts.filter((bp) => wasMember(bp) && !egress.has(bp));
        if (dropped.length) {
          return cls(edit, "blocked", `drops management port(s) ${dropped.join(", ")} from management VLAN ${edit.vid}`);
        }
        return cls(edit, "safe", `edits management VLAN ${edit.vid} without dropping any management port`);
      }
      // Non-management VLAN: risky if a protected port's tagging changes here, else safe.
      const wasTagged = (bp: number) => v.members.tagged.includes(bp);
      const wasUntagged = (bp: number) => v.members.untagged.includes(bp);
      const nowTagged = (bp: number) => edit.tagged.includes(bp);
      const nowUntagged = (bp: number) => edit.untagged.includes(bp);
      const changed = protectedPorts.filter(
        (bp) => wasTagged(bp) !== nowTagged(bp) || wasUntagged(bp) !== nowUntagged(bp),
      );
      if (changed.length) {
        return cls(edit, "risky", `changes tagging of management port(s) ${changed.join(", ")} on VLAN ${edit.vid}`);
      }
      return cls(edit, "safe", `edits non-management VLAN ${edit.vid}`);
    }

    case "deleteVlan": {
      if (V.has(edit.vid)) {
        return cls(edit, "blocked", `deletes the management VLAN ${edit.vid}`);
      }
      // Per the contract table, deleting a non-management VLAN is risky (ports lose it).
      return cls(edit, "risky", `deletes VLAN ${edit.vid} (member ports lose it)`);
    }

    case "setLag": {
      if (P.has(edit.bridgePort)) {
        return cls(edit, "risky", `changes LAG membership of management port ${edit.bridgePort}`);
      }
      // Unresolvable bridge port still classifies risky (uncertain) — never down.
      if (!portByBridge(state, edit.bridgePort)) {
        return cls(edit, "risky", `bridge port ${edit.bridgePort} not found in state — LAG effect uncertain`);
      }
      return cls(edit, "safe", `changes LAG membership of port ${edit.bridgePort}`);
    }

    case "setPoe": {
      if (edit.on) return cls(edit, "safe", `enables PoE on port ${edit.bridgePort}`);
      if (P.has(edit.bridgePort)) {
        return cls(edit, "risky", `disables PoE on management port ${edit.bridgePort} (may power a downstream device)`);
      }
      if (!portByBridge(state, edit.bridgePort)) {
        return cls(edit, "risky", `bridge port ${edit.bridgePort} not found in state — PoE effect uncertain`);
      }
      return cls(edit, "safe", `disables PoE on port ${edit.bridgePort}`);
    }

    case "createVlan":
      return cls(edit, "safe", `creates VLAN ${edit.vid}`);

    case "setPortLabel":
      return cls(edit, "safe", `relabels port (ifIndex ${edit.ifIndex})`);

    case "setObject": {
      // A generic write to an arbitrary vendor object is NEVER "safe" (contract): we can't reason
      // about its effect the way we can for the curated edits above. Blocked if it targets a known
      // dangerous subtree (IP/SNMP/credential/admin), otherwise risky — which forces an explicit
      // acknowledgement through the same Phase 2 gate as any other risky edit.
      const danger = isUnderDangerousSubtree(edit.oid);
      const what = edit.name ? `${edit.name} (${edit.oid})` : edit.oid;
      if (danger.blocked) {
        return cls(edit, "blocked", `writes ${what} in a protected subtree: ${danger.why}`);
      }
      return cls(edit, "risky", `generic write to ${what} — effect not curated, proceed with care`);
    }
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function cls(edit: Edit, c: SafetyClass, reason: string): EditClassification {
  return { edit, cls: c, reason };
}

const SEVERITY: Record<SafetyClass, number> = { safe: 0, risky: 1, blocked: 2 };

/** worst = max severity across all classifications ("safe" when there are none). */
export function worstOf(classifications: EditClassification[]): SafetyClass {
  let worst: SafetyClass = "safe";
  for (const c of classifications) if (SEVERITY[c.cls] > SEVERITY[worst]) worst = c.cls;
  return worst;
}

function portByBridge(state: DeviceState, bridgePort?: number): Port | undefined {
  return bridgePort === undefined ? undefined : state.ports.find((p) => p.bridgePort === bridgePort);
}

function countDistinctMacsByPort(fdb: FdbEntry[]): Map<number, number> {
  const byPort = new Map<number, Set<string>>();
  for (const e of fdb) {
    let s = byPort.get(e.bridgePort);
    if (!s) byPort.set(e.bridgePort, (s = new Set()));
    s.add(normMac(e.mac));
  }
  const counts = new Map<number, number>();
  for (const [p, s] of byPort) counts.set(p, s.size);
  return counts;
}

/** An LLDP neighbour whose advertised port id/desc/name reads like switch or router infra. */
function looksLikeInfraNeighbour(n: LldpNeighbor): boolean {
  const hay = [n.remoteSysName, n.remotePortId, n.remotePortDesc].filter(Boolean).join(" ").toLowerCase();
  // Conservative match: anything that smells like another switch/router (which means this local
  // port is an inter-switch link the management path may traverse).
  return /switch|router|gateway|core|uplink|trunk|sw\d|rtr|gw\b|ether/.test(hay);
}

function mostCommonPvid(ports: Port[]): number | undefined {
  const counts = new Map<number, number>();
  for (const p of ports) if (p.pvid !== undefined) counts.set(p.pvid, (counts.get(p.pvid) ?? 0) + 1);
  let best: number | undefined;
  let bestN = 0;
  for (const [vid, n] of counts) if (n > bestN) { best = vid; bestN = n; }
  return best;
}

/** Normalise a MAC to lowercase colon-hex for robust comparison (handles dashes / no separators). */
function normMac(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (hex.length !== 12) return mac.toLowerCase();
  return hex.match(/.{2}/g)!.join(":");
}

// ---------------------------------------------------------------------------
// Apply-gate decision (pure) — factored out so the gate can be unit-tested without a live device.
// ---------------------------------------------------------------------------

export interface Acknowledge {
  allowRisky?: boolean;
  allowBlocked?: boolean;
}

/**
 * Decide whether to REFUSE an apply, given the safety report and the caller's acknowledgement.
 * Pure: the apply path calls this BEFORE sending any SET. Blocked needs allowBlocked; risky needs
 * allowRisky. Blocked is reported first (the more severe condition).
 */
export function gateDecision(
  report: SafetyReport,
  ack: Acknowledge = {},
): { refuse: boolean; reason?: string } {
  const hasBlocked = report.classifications.some((c) => c.cls === "blocked");
  const hasRisky = report.classifications.some((c) => c.cls === "risky");
  if (hasBlocked && !ack.allowBlocked) {
    const which = report.classifications.filter((c) => c.cls === "blocked").map((c) => c.reason);
    return { refuse: true, reason: `refusing: ${which.length} blocked edit(s) require acknowledge.allowBlocked — ${which.join("; ")}` };
  }
  if (hasRisky && !ack.allowRisky) {
    const which = report.classifications.filter((c) => c.cls === "risky").map((c) => c.reason);
    return { refuse: true, reason: `refusing: ${which.length} risky edit(s) require acknowledge.allowRisky — ${which.join("; ")}` };
  }
  return { refuse: false };
}
