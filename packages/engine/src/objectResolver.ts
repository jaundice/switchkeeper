// ObjectResolver: the single place that answers "what is the OID, type, and access for
// this object on this device?". Resolution order (per the spec / phase1-contract):
//   1. device MIBs  — mib.findOid(name) against the device's loaded vendor MIBs
//   2. standard      — the oids.ts OID map (works on any compliant switch)
//   3. vendor profile — profiles.ts (only the few overrides a vendor needs)
// Device-MIB hits carry MAX-ACCESS / SYNTAX metadata so later phases can build
// type-aware editors and gate read/write; standard + profile hits don't have that
// metadata (they're just names mapped to OIDs), so type/access are left undefined.
import type { MibStore, MibObject } from "./mib.ts";
import type { ObjectAccess, ResolvedObject } from "./model.ts";
import { OID } from "./oids.ts";

export interface ObjectResolver {
  resolve(name: string): ResolvedObject | null;
}

// net-snmp's MibObject.maxAccess is the numeric SNMPv2-SMI MAX-ACCESS code. Map it to our
// normalised union. accessible-for-notify has no read/write meaning here, so treat it as
// not-accessible for display purposes. Anything else (or absent) is "unknown".
const MAX_ACCESS: Record<number, ObjectAccess> = {
  0: "not-accessible",
  1: "not-accessible", // accessible-for-notify
  2: "read-only",
  3: "read-write",
  4: "read-write", // read-create
};

export function accessFromMaxAccess(maxAccess: number | undefined): ObjectAccess {
  if (maxAccess === undefined) return "unknown";
  return MAX_ACCESS[maxAccess] ?? "unknown";
}

// net-snmp's MibObject.scalarType is its numeric ObjectType (ASN.1 base type the parser
// reduced the SYNTAX to). We can only recover the base type, not the textual SYNTAX/TC name
// (the store doesn't expose it), so this is a best-effort human label.
const SCALAR_TYPE: Record<number, string> = {
  1: "Boolean",
  2: "Integer32",
  3: "BitString",
  4: "OctetString",
  5: "Null",
  6: "ObjectIdentifier",
  64: "IpAddress",
  65: "Counter32",
  66: "Gauge32",
  67: "TimeTicks",
  68: "Opaque",
  70: "Counter64",
};

export function typeFromScalarType(scalarType: number | undefined): string | undefined {
  if (scalarType === undefined) return undefined;
  return SCALAR_TYPE[scalarType];
}

/** Turn a net-snmp MibObject (device-MIB hit) into a ResolvedObject with metadata. */
export function resolvedFromMibObject(obj: MibObject): ResolvedObject {
  return {
    name: obj.name,
    oid: obj.oid,
    module: obj.module,
    source: "device-mib",
    type: typeFromScalarType(obj.scalarType),
    access: accessFromMaxAccess(obj.maxAccess),
  };
}

export function createObjectResolver(mib: MibStore): ObjectResolver {
  // The standard map is keyed by symbol name; strip the trailing scalar instance (".0") so
  // resolve returns the object OID, not an instance, matching the device-MIB/profile shape.
  const standard = OID as Record<string, string>;

  return {
    resolve(name: string): ResolvedObject | null {
      // 1. device MIBs win — they carry the richest metadata for this exact device.
      const fromMib = mib.findOid(name);
      if (fromMib) return resolvedFromMibObject(fromMib);

      // 2. standard baseline (oids.ts).
      const stdOid = standard[name];
      if (typeof stdOid === "string") {
        return {
          name,
          oid: stdOid.replace(/\.0$/, ""),
          module: "standard",
          source: "standard",
        };
      }

      // 3. vendor profile overrides. profiles.ts holds its OIDs as fields on the active
      //    VendorProfile (the VLAN write path, the running->startup save base) rather than as a
      //    name->oid map, and the few named ones it does have (e.g. rlCopyEntryBase) already
      //    live in oids.ts, so they resolve at the standard tier above. The profile tier is kept
      //    as the documented last fallback for when profiles grow a symbol table of their own;
      //    until then there is nothing here that the standard tier hasn't already answered.
      return null;
    },
  };
}
