// Thin promise-based wrapper over net-snmp. Pure-JS dependency (no native build),
// so it runs identically in Electron, a Docker container, and the MCP host.
import snmp from "net-snmp";
import type { Credential } from "./model.ts";

export interface VarBind {
  oid: string;
  type: number;
  value: unknown;
}

export interface SnmpOptions {
  timeoutMs?: number;
  retries?: number;
}

export class SnmpClient {
  private readonly host: string;
  private readonly cred: Credential;
  private readonly opts: Required<SnmpOptions>;
  private readSession: any;
  private writeSession: any;

  constructor(host: string, cred: Credential, opts: SnmpOptions = {}) {
    this.host = host;
    this.cred = cred;
    this.opts = { timeoutMs: opts.timeoutMs ?? 5000, retries: opts.retries ?? 2 };
    this.readSession = this.makeSession("read");
  }

  /** Build a session: SNMPv3 if the credential is v3, otherwise v2c with the right community. */
  private makeSession(role: "read" | "write") {
    const common = { timeout: this.opts.timeoutMs, retries: this.opts.retries };
    if (this.cred.protocol === "snmpV3" && this.cred.v3) {
      const v = this.cred.v3;
      const level = v.privKey
        ? snmp.SecurityLevel.authPriv
        : v.authKey
          ? snmp.SecurityLevel.authNoPriv
          : snmp.SecurityLevel.noAuthNoPriv;
      const user = {
        name: v.user,
        level,
        authProtocol: v.authProtocol === "sha" ? snmp.AuthProtocols.sha : snmp.AuthProtocols.md5,
        authKey: v.authKey,
        privProtocol: v.privProtocol === "aes" ? snmp.PrivProtocols.aes : snmp.PrivProtocols.des,
        privKey: v.privKey,
      };
      return snmp.createV3Session(this.host, user, common);
    }
    const community = role === "write"
      ? (this.cred.writeCommunity ?? "private")
      : (this.cred.readCommunity ?? "public");
    return snmp.createSession(this.host, community, { version: snmp.Version2c, ...common });
  }

  /** GET one or more scalar OIDs. Throws on transport error; per-varbind errors are kept. */
  get(oids: string[]): Promise<VarBind[]> {
    return new Promise((resolve, reject) => {
      this.readSession.get(oids, (err: Error | null, varbinds: any[]) => {
        if (err) return reject(err);
        resolve(varbinds.map(toVarBind));
      });
    });
  }

  /** Walk a subtree (column or scalar table), returning all non-error varbinds. */
  walk(baseOid: string): Promise<VarBind[]> {
    return new Promise((resolve, reject) => {
      const out: VarBind[] = [];
      this.readSession.subtree(
        baseOid,
        20,
        (varbinds: any[]) => {
          for (const vb of varbinds) {
            if (!snmp.isVarbindError(vb)) out.push(toVarBind(vb));
          }
        },
        (err: Error | null) => (err ? reject(err) : resolve(out)),
      );
    });
  }

  /**
   * GETBULK walk of a subtree (v2c). Far fewer round-trips than the GETNEXT walk(): each PDU asks
   * the agent for up to `maxRepetitions` successor varbinds at once, so a 50-row column comes back
   * in ~2 PDUs instead of ~50. Returns all non-error varbinds under baseOid, in OID order.
   *
   * Why a hand-rolled loop instead of net-snmp's subtree(): subtree() uses GETNEXT one varbind at a
   * time; getBulk() exposes the repetition count that makes a table load cheap. We page until the
   * agent walks out of the subtree (an OID no longer under baseOid) or signals endOfMibView.
   * Read-only: issues only GETBULK requests on the read session, never a SET.
   */
  walkBulk(baseOid: string, maxRepetitions = 20): Promise<VarBind[]> {
    const base = baseOid.endsWith(".") ? baseOid.slice(0, -1) : baseOid;
    // Guard: a bulk PDU can carry a varbind with no/empty oid (terminating/edge cases). Treating an
    // undefined oid as a string crashed the whole process from inside the socket callback, so check
    // the type explicitly and treat anything non-string as "not under base" (ends the walk).
    const underBase = (oid?: string): boolean =>
      typeof oid === "string" && (oid === base || oid.startsWith(base + "."));
    return new Promise((resolve, reject) => {
      const out: VarBind[] = [];
      const step = (from: string) => {
        // getBulk(oids, nonRepeaters, maxRepetitions, cb): 0 non-repeaters, page of maxRepetitions.
        this.readSession.getBulk([from], 0, maxRepetitions, (err: Error | null, varbinds: any[]) => {
          // The callback runs in net-snmp's socket handler, OUTSIDE this Promise's try scope: any
          // throw here would be an uncaught exception that kills the process. Wrap defensively and
          // turn failures into a rejection (column() then falls back to the GETNEXT walk).
          try {
            if (err) return reject(err);
            let last = from;
            let done = false;
            for (const vb of varbinds || []) {
              // endOfMibView (130) ends the walk; other per-varbind errors (noSuchObject/Instance) are
              // skipped but we keep paging from the last good OID.
              if (snmp.isVarbindError(vb)) {
                if (vb.type === 130) { done = true; break; }
                continue;
              }
              if (!vb || typeof vb.oid !== "string") continue; // malformed varbind -> skip, keep paging
              if (!underBase(vb.oid)) { done = true; break; }
              out.push(toVarBind(vb));
              last = vb.oid;
            }
            // No progress (agent returned nothing new under base) -> stop, else page from the last OID.
            if (done || !varbinds || varbinds.length === 0 || last === from) return resolve(out);
            step(last);
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      };
      step(base);
    });
  }

  /**
   * Walk a single table column and return a map of row-index (the OID suffix after the column base)
   * -> value. `opts.bulk` (default true) uses the GETBULK walk for far fewer round-trips, falling
   * back to the GETNEXT walk() if the device errors on bulk (some old/locked agents reject GETBULK
   * or cap the PDU). Read-only; per-row keying is identical regardless of which walk produced it.
   */
  async column(columnOid: string, opts: { bulk?: boolean } = {}): Promise<Map<string, VarBind>> {
    const useBulk = opts.bulk ?? true;
    let vbs: VarBind[];
    if (useBulk) {
      try {
        vbs = await this.walkBulk(columnOid);
      } catch {
        // Device rejected/failed GETBULK -> fall back to the serial GETNEXT walk. Same result shape.
        vbs = await this.walk(columnOid);
      }
    } else {
      vbs = await this.walk(columnOid);
    }
    const map = new Map<string, VarBind>();
    const prefix = columnOid.endsWith(".") ? columnOid : columnOid + ".";
    for (const vb of vbs) {
      if (vb.oid.startsWith(prefix)) map.set(vb.oid.slice(prefix.length), vb);
    }
    return map;
  }

  /** SET varbinds using the write community. Caller supplies snmp.ObjectType + value. */
  set(varbinds: { oid: string; type: number; value: unknown }[]): Promise<VarBind[]> {
    if (!this.writeSession) {
      if (this.cred.protocol !== "snmpV3" && !this.cred.writeCommunity) {
        throw new Error("no write community configured");
      }
      this.writeSession = this.makeSession("write");
    }
    return new Promise((resolve, reject) => {
      this.writeSession.set(varbinds, (err: Error | null, vbs: any[]) => {
        if (err) return reject(err);
        resolve(vbs.map(toVarBind));
      });
    });
  }

  close(): void {
    try { this.readSession?.close(); } catch { /* ignore */ }
    try { this.writeSession?.close(); } catch { /* ignore */ }
  }
}

function toVarBind(vb: any): VarBind {
  return { oid: vb.oid, type: vb.type, value: vb.value };
}

// Re-export the bits of net-snmp callers need for typed sets.
export const ObjectType = snmp.ObjectType;
// Value helpers live in util.ts (net-snmp-free); re-exported here for existing importers.
export { asString, asInt, asBuffer } from "./util.ts";
