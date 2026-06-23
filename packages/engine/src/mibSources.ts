// Where a user can download the MIB(s) for a switch, keyed on its SNMP enterprise
// number (which discover() already returns as `vendorEnterprise`). We LINK, never host.
//
// Standard IETF/IEEE MIBs ship with Switchkeeper; this points users at the *vendor*
// MIBs they're entitled to from their own vendor. Curated links were current as of
// 2026-06; a generated search link is always appended so even unknown vendors get a
// useful pointer and the registry never goes stale.

export interface MibLink {
  label: string;
  url: string;
}

export interface MibSource {
  vendor: string;
  links: MibLink[];
  note?: string;
}

// Enterprise number -> vendor name + curated official download location(s).
// Vendor<->enterprise mappings are IANA facts; only verified URLs are hard-coded.
const SOURCES: Record<number, MibSource> = {
  9: {
    vendor: "Cisco",
    links: [
      { label: "Cisco public MIBs (GitHub, no login)", url: "https://github.com/cisco/cisco-mibs" },
      { label: "Cisco SNMP Object Navigator", url: "https://www.cisco.com/c/en/us/support/web/tools/snmp/help/index.html" },
    ],
    note: "Also covers Cisco Small Business (SG/SF) switches, which use the Marvell/Radlan stack.",
  },
  11: { vendor: "HP / HPE", links: [] },
  89: {
    vendor: "Radlan / Marvell",
    links: [],
    note: "OEM stack behind many SMB switches (Cisco SB, Netgear ProSafe, Dell, Linksys, Zyxel). Get the MIB from the badge vendor's site.",
  },
  171: { vendor: "D-Link", links: [] },
  207: { vendor: "Allied Telesis", links: [] },
  674: { vendor: "Dell", links: [] },
  890: { vendor: "Zyxel", links: [] },
  1916: { vendor: "Extreme Networks", links: [] },
  1991: { vendor: "Brocade / Foundry", links: [] },
  2011: { vendor: "Huawei", links: [] },
  2636: { vendor: "Juniper Networks", links: [] },
  4413: { vendor: "Broadcom", links: [] },
  4526: {
    vendor: "Netgear",
    links: [
      { label: "Netgear - MIBs for Smart switches", url: "https://kb.netgear.com/24352/MIBs-for-Smart-switches" },
      { label: "Netgear support (pick your model)", url: "https://www.netgear.com/support/" },
    ],
    note: "ProSafe smart switches (Marvell/Radlan). The MIB bundle is on each model's Downloads tab.",
  },
  14823: { vendor: "Aruba (HPE)", links: [] },
  14988: { vendor: "MikroTik", links: [], note: "MikroTik SNMP is largely read-only; writes go via its own API/RouterOS." },
  41112: { vendor: "Ubiquiti", links: [] },
};

/** Build a DuckDuckGo search link for a vendor/model MIB download (universal fallback). */
export function mibSearchUrl(query: string): string {
  return "https://duckduckgo.com/?q=" + encodeURIComponent(query.trim() + " SNMP MIB download");
}

/**
 * Pointers to where the user can get the MIB for a discovered device.
 * Always returns at least a search link, so unknown vendors are still covered.
 */
export function mibPointersFor(enterprise?: number, sysDescr?: string): { vendor: string; note?: string; links: MibLink[] } {
  const src = enterprise != null ? SOURCES[enterprise] : undefined;
  const vendor = src?.vendor ?? (enterprise != null ? `enterprise ${enterprise}` : "your switch vendor");
  const links: MibLink[] = src ? [...src.links] : [];
  const hint = (src?.vendor ? src.vendor + " " : "") + (sysDescr ? sysDescr.split(/\s+/).slice(0, 2).join(" ") + " " : "");
  links.push({ label: "Search for your model's MIB", url: mibSearchUrl(hint + "switch") });
  return { vendor, note: src?.note, links };
}

/** Whether we have a curated (non-search) source for this enterprise. */
export function hasCuratedMibSource(enterprise?: number): boolean {
  return enterprise != null && !!SOURCES[enterprise] && SOURCES[enterprise].links.length > 0;
}
