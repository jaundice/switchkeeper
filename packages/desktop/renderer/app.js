"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let lastState = null;
const pending = new Map(); // bridgePort -> { bridge, vid, orig }   (PVID edits)
const memEdits = new Map(); // vid -> { tagged:Set, untagged:Set }  (membership edits)
const pendingLag = new Map(); // bridgePort -> lagId|null            (LAG edits)

function setStatus(msg, cls) {
  const el = $("status");
  el.textContent = msg;
  el.className = cls || "";
}

function badge(label, on, warn) {
  const cls = warn ? "badge warn" : on ? "badge on" : "badge";
  return `<span class="${cls}">${esc(label)}</span>`;
}

function renderDevice(d) {
  const c = d.capabilities || {};
  const writeBadge = c.qbridgeWrite ? badge("writes: standard", true) : badge("writes: unproven", false, true);
  $("device").style.display = "flex";
  $("device").innerHTML = `
    <span class="model">${esc(d.model || "switch")}</span>
    <span class="kv">host <b>${esc(d.host)}</b></span>
    <a href="#" id="openui" class="openui" title="Open the switch's web UI in your browser">open UI &rarr;</a>
    <span class="kv">vendor <b>${esc(d.vendorEnterprise ?? "?")}</b></span>
    <span class="kv">VLAN cap <b>${esc(c.maxVlans ?? "?")}</b></span>
    <div class="badges">
      ${badge("Q-BRIDGE read", c.qbridgeRead)}
      ${writeBadge}
      ${badge("PVID write", c.pvidWrite)}
      ${badge(c.poe ? "PoE" : "no PoE", c.poe)}
      ${badge("PortList " + (c.portListWidth ?? "?") + "B", true)}
      ${badge("source: " + (c.membershipSource || "?"), true)}
    </div>
    <div id="mibrow" class="mibrow"></div>`;
  const ou = document.getElementById("openui");
  if (ou) ou.onclick = (e) => { e.preventDefault(); window.switchkeeper.openUrl("http://" + d.host); };
  populateMibRow(d);
}

// Show where to download this vendor's MIB, plus an Import control + loaded-module status.
async function populateMibRow(d) {
  const el = document.getElementById("mibrow");
  if (!el) return;
  let links = [], vendor = "", note = "";
  try {
    const r = await window.switchkeeper.mibPointers({ enterprise: d.vendorEnterprise, sysDescr: d.model });
    if (r && r.ok && r.data) { links = r.data.links || []; vendor = r.data.vendor || ""; note = r.data.note || ""; }
  } catch (e) { /* non-fatal */ }
  const linkHtml = links.map((l) => `<a href="#" class="miblink" data-url="${esc(l.url)}">${esc(l.label)}</a>`).join(" · ");
  el.innerHTML =
    `<span class="kv">MIB${vendor ? " (" + esc(vendor) + ")" : ""}:</span> ${linkHtml}` +
    ` <button id="mibimport" class="linkbtn" title="Load a vendor MIB file so Switchkeeper can name its OIDs">Import MIB…</button>` +
    ` <span id="mibstatus" class="empty"></span>` +
    (note ? `<div class="empty mibnote">${esc(note)}</div>` : "");
  el.querySelectorAll(".miblink").forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); window.switchkeeper.openLink(a.getAttribute("data-url")); };
  });
  const status = () => document.getElementById("mibstatus");
  const btn = document.getElementById("mibimport");
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    try {
      const r = await window.switchkeeper.importMib();
      if (r && r.ok && r.data && !r.data.canceled) status().textContent = `loaded ${r.data.imported.length} module(s), ${r.data.modules} total`;
      else if (r && !r.ok) status().textContent = r.error || "import unavailable";
    } finally { btn.disabled = false; }
  };
  try {
    const s = await window.switchkeeper.mibStatus();
    if (s && s.ok && s.data && s.data.loaded) status().textContent = `${s.data.loaded} MIB module(s) loaded`;
  } catch (e) { /* ignore */ }
}

function vlanTable(vlans) {
  const rows = vlans.map((v) => {
    const u = v.members.untagged.map((p) => `<span class="chip untag">${p}</span>`).join("") || '<span class="empty">-</span>';
    const t = v.members.tagged.map((p) => `<span class="chip tag">${p}</span>`).join("") || '<span class="empty">-</span>';
    return `<tr><td class="num">${v.vid}</td><td>${esc(v.name || "")}</td><td>${u}</td><td>${t}</td></tr>`;
  }).join("");
  return `<h2>VLANs (${vlans.length})</h2>
    <div class="scrollwrap"><table><thead><tr><th>VID</th><th>Name</th><th>Untagged ports</th><th>Tagged ports</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

function vlanName(vid) {
  const v = (lastState?.vlans || []).find((x) => x.vid === vid);
  return v && v.name ? `${vid} ${v.name}` : String(vid);
}

function vlanOptions(selected) {
  const vids = new Set((lastState?.vlans || []).map((v) => v.vid));
  vids.add(1);
  if (selected != null) vids.add(selected);
  return [...vids].sort((a, b) => a - b)
    .map((vid) => `<option value="${vid}"${vid === selected ? " selected" : ""}>${esc(vlanName(vid))}</option>`)
    .join("");
}

function lagOptions(selectedLagId) {
  const lagPorts = (lastState?.ports || []).filter((x) => x.kind === "lag");
  const opts = [`<option value=""${selectedLagId == null ? " selected" : ""}>-</option>`];
  for (const lp of lagPorts) {
    opts.push(`<option value="${lp.bridgePort}"${lp.bridgePort === selectedLagId ? " selected" : ""}>${esc(lp.name)}</option>`);
  }
  return opts.join("");
}

function portRows(ports) {
  const vlans = lastState.vlans;
  return ports.map((p) => {
    const up = p.operStatus === "up";
    const poe = p.poe && p.poe.capable ? (p.poe.adminOn ? p.poe.status || "on" : "off") : "-";
    const b = p.bridgePort;
    const pendingVid = b != null && pending.has(b) ? pending.get(b).vid : undefined;
    const selVid = pendingVid ?? p.pvid;
    const pvidCell = b != null
      ? `<select class="pvid${pendingVid !== undefined ? " changed" : ""}" data-bridge="${b}" data-orig="${p.pvid ?? ""}">${vlanOptions(selVid)}</select>`
      : '<span class="empty">-</span>';
    const vcells = vlans.map((v) => {
      if (b == null) return '<td class="vcell"></td>';
      const s = cellState(b, v.vid);
      const ch = cellChanged(b, v.vid) ? " changed" : "";
      const txt = s === "u" ? "U" : s === "t" ? "T" : "";
      return `<td class="vcell ${s}${ch}" data-port="${b}" data-vid="${v.vid}">${txt}</td>`;
    }).join("");
    return `<tr>
      <td class="num">${b ?? p.ifIndex}</td>
      <td>${esc(p.name)}${p.label ? ` <span class="empty">(${esc(p.label)})</span>` : ""}</td>
      <td><span class="dot ${up ? "up" : "down"}"></span>${up ? "up" : "down"}</td>
      <td>${pvidCell}</td>
      ${vcells}
      <td>${esc(poe)}</td>
      <td>${(p.kind === "physical" && b != null)
        ? `<select class="lag${pendingLag.has(b) ? " changed" : ""}" data-bridge="${b}" data-orig="${p.lagId ?? ""}">${lagOptions(pendingLag.has(b) ? pendingLag.get(b) : (p.lagId ?? null))}</select>`
        : '<span class="empty">-</span>'}</td>
    </tr>`;
  }).join("");
}

function renderPorts(ports) {
  const phys = ports.filter((p) => p.kind === "physical");
  const lags = ports.filter((p) => p.kind === "lag");
  const vhead = lastState.vlans.map((v) => `<th class="vh" title="${esc(v.name || "")}">${v.vid}</th>`).join("");
  const head = `<thead><tr><th>#</th><th>Name</th><th>Link</th><th>PVID</th>${vhead}<th>PoE</th><th>LAG</th></tr></thead>`;
  let html = `<h2>Ports (${phys.length}) &mdash; PVID dropdown, a cell per VLAN (click: blank &rarr; U &rarr; T), and LAG</h2>
    <div class="scrollwrap"><table class="ports">${head}<tbody>${portRows(phys)}</tbody></table></div>`;
  if (lags.length) {
    html += `<h2>Link aggregation (${lags.length})</h2>
      <div class="scrollwrap"><table class="ports">${head}<tbody>${portRows(lags)}</tbody></table></div>`;
  }
  return html;
}

// ---- VLAN membership matrix ----

function origMembers(vid) {
  const v = (lastState?.vlans || []).find((x) => x.vid === vid);
  return { tagged: new Set(v ? v.members.tagged : []), untagged: new Set(v ? v.members.untagged : []) };
}
function workingMembers(vid) {
  return memEdits.get(vid) || origMembers(vid);
}
function cellState(port, vid) {
  const m = workingMembers(vid);
  if (m.untagged.has(port)) return "u";
  if (m.tagged.has(port)) return "t";
  return "";
}
function cellChanged(port, vid) {
  const o = origMembers(vid);
  const orig = o.untagged.has(port) ? "u" : o.tagged.has(port) ? "t" : "";
  return cellState(port, vid) !== orig;
}
function sameMembers(a, b) {
  const eq = (x, y) => x.size === y.size && [...x].every((v) => y.has(v));
  return eq(a.tagged, b.tagged) && eq(a.untagged, b.untagged);
}
function cycleCell(port, vid) {
  let e = memEdits.get(vid);
  if (!e) { const o = origMembers(vid); e = { tagged: new Set(o.tagged), untagged: new Set(o.untagged) }; memEdits.set(vid, e); }
  if (e.untagged.has(port)) { e.untagged.delete(port); e.tagged.add(port); }      // U -> T
  else if (e.tagged.has(port)) { e.tagged.delete(port); }                         // T -> (none)
  else { e.untagged.add(port); }                                                  // (none) -> U
  if (sameMembers(e, origMembers(vid))) memEdits.delete(vid);                      // back to original
}

function renderAll() {
  renderDevice(lastState.device);
  const tp = $("topology");
  if (tp) { tp.style.display = "none"; tp.innerHTML = ""; } // clear stale topology on re-read
  const cp = $("capabilities");
  if (cp) { cp.style.display = "none"; cp.innerHTML = ""; } // clear stale device details on re-read
  $("content").innerHTML = vlanTable(lastState.vlans) + renderPorts(lastState.ports);
  document.querySelectorAll("select.pvid").forEach((sel) => {
    sel.addEventListener("change", () => {
      const bridge = Number(sel.dataset.bridge);
      const orig = Number(sel.dataset.orig);
      const vid = Number(sel.value);
      if (vid === orig) { pending.delete(bridge); sel.classList.remove("changed"); }
      else { pending.set(bridge, { bridge, vid, orig }); sel.classList.add("changed"); }
      renderPending();
    });
  });
  document.querySelectorAll("select.lag").forEach((sel) => {
    sel.addEventListener("change", () => {
      const bridge = Number(sel.dataset.bridge);
      const orig = sel.dataset.orig === "" ? null : Number(sel.dataset.orig);
      const val = sel.value === "" ? null : Number(sel.value);
      if (val === orig) { pendingLag.delete(bridge); sel.classList.remove("changed"); }
      else { pendingLag.set(bridge, val); sel.classList.add("changed"); }
      renderPending();
    });
  });
  document.querySelectorAll("td.vcell").forEach((td) => {
    if (!td.dataset.port) return;
    td.addEventListener("click", () => {
      const port = Number(td.dataset.port);
      const vid = Number(td.dataset.vid);
      cycleCell(port, vid);
      const s = cellState(port, vid);
      td.className = "vcell " + s + (cellChanged(port, vid) ? " changed" : "");
      td.textContent = s === "u" ? "U" : s === "t" ? "T" : "";
      renderPending();
    });
  });
}

function renderPending(msg, cls) {
  const bar = $("pending");
  const total = pending.size + memEdits.size + pendingLag.size;
  if (total === 0 && !msg) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  const parts = [
    ...[...pending.values()].map((p) => `g${p.bridge}->VLAN ${p.vid}`),
    ...[...memEdits.keys()].map((vid) => `VLAN ${vid} members`),
    ...[...pendingLag.entries()].map(([b, lag]) => `g${b}->${lag == null ? "no LAG" : "LAG " + lag}`),
  ];
  bar.style.display = "flex";
  bar.innerHTML = `
    <span class="count">${total} pending</span>
    <span class="msg ${cls || ""}">${esc(msg || parts.join(", "))}</span>
    <span class="spacer"></span>
    <button id="discard" class="secondary">Discard</button>
    <button id="apply">Apply changes</button>`;
  $("apply").addEventListener("click", applyPending);
  $("discard").addEventListener("click", () => { pending.clear(); memEdits.clear(); pendingLag.clear(); renderAll(); renderPending(); });
}

async function applyPending() {
  if (pending.size === 0 && memEdits.size === 0 && pendingLag.size === 0) return;
  const host = $("host").value.trim();
  const cred = getCred();
  if (cred.version === "v2c" && !cred.writeCommunity) { renderPending("enter a write community to apply", "bad"); return; }
  if (cred.version === "v3" && !cred.v3.user) { renderPending("enter a v3 user to apply", "bad"); return; }
  const edits = [
    ...[...pending.values()].map((p) => ({ kind: "setPvid", bridgePort: p.bridge, vid: p.vid })),
    ...[...memEdits.entries()].map(([vid, e]) => ({ kind: "setVlanMembership", vid, tagged: [...e.tagged], untagged: [...e.untagged] })),
    ...[...pendingLag.entries()].map(([bridge, lagId]) => ({ kind: "setLag", bridgePort: bridge, lagId })),
  ];
  $("apply").disabled = true;
  renderPending("applying " + edits.length + " change(s)...");
  const res = await window.switchkeeper.apply({ host, cred, edits });
  if (!res.ok) { renderPending("apply error: " + res.error, "bad"); return; }
  const cs = res.data.changeSet || {};
  if (cs.status === "verified") {
    pending.clear();
    setStatus("applied " + edits.length + " change(s)");
    await connect();
  } else {
    const firstErr = (cs.results || []).find((r) => !r.ok);
    let why = firstErr ? (firstErr.error || "verify failed") : cs.status;
    if (/time/i.test(why)) why = "write timed out - writes must come from the management host (.2), not this PC";
    renderPending("apply " + cs.status + ": " + why, "bad");
  }
}

function getCred() {
  if ($("version").value === "v3") {
    return {
      version: "v3",
      v3: {
        user: $("v3user").value.trim(),
        authProto: $("v3authproto").value || undefined,
        authKey: $("v3authkey").value || undefined,
        privProto: $("v3privproto").value || undefined,
        privKey: $("v3privkey").value || undefined,
      },
    };
  }
  return {
    version: "v2c",
    community: $("community").value.trim() || "public",
    writeCommunity: $("wcommunity").value.trim() || undefined,
  };
}

function toggleVersion() {
  const v3 = $("version").value === "v3";
  $("v3bar").style.display = v3 ? "flex" : "none";
  $("community").style.display = v3 ? "none" : "";
  $("wcommunity").style.display = v3 ? "none" : "";
}

async function connect() {
  const host = $("host").value.trim();
  $("connect").disabled = true;
  $("refresh").disabled = true;
  setStatus("reading " + host + " ...", "spin");
  try {
    const res = await window.switchkeeper.read({ host, cred: getCred() });
    if (!res.ok) {
      setStatus("error", "error");
      $("content").innerHTML = `<p class="error">Could not read switch: ${esc(res.error)}</p>`;
      return;
    }
    lastState = res.state;
    pending.clear();
    memEdits.clear();
    pendingLag.clear();
    renderAll();
    renderPending();
    const t = new Date(lastState.readAt).toLocaleTimeString();
    setStatus(`read ${lastState.ports.length} ports, ${lastState.vlans.length} VLANs at ${t}`);
  } catch (e) {
    setStatus("error", "error");
    $("content").innerHTML = `<p class="error">${esc((e && e.message) || e)}</p>`;
  } finally {
    $("connect").disabled = false;
    $("refresh").disabled = false;
  }
}

// ---- Discover panel ----

async function openDiscover() {
  const panel = $("discoverPanel");
  if (panel.style.display !== "none") { panel.style.display = "none"; return; }
  panel.style.display = "block";
  panel.innerHTML = "<h3>Discover switches</h3><p class='hint'>loading interfaces...</p>";
  const res = await window.switchkeeper.interfaces();
  if (!res.ok) { panel.innerHTML = `<h3>Discover switches</h3><p class="error">${esc(res.error)}</p>`; return; }
  renderDiscover(res.data);
}

function renderDiscover(ifaces) {
  const rows = ifaces.map((i) => `
    <label class="row">
      <input type="checkbox" class="ifsel" data-subnet="${esc(i.subnet)}" ${i.subnet.startsWith("192.168.") ? "checked" : ""}>
      <span><b>${esc(i.name)}</b></span>
      <span class="sub">${esc(i.address)} &nbsp; ${esc(i.subnet)}</span>
    </label>`).join("");
  $("discoverPanel").innerHTML = `
    <h3>Discover switches <span class="sub" style="font-weight:400">(uses the SNMP credentials in the bar above)</span></h3>
    <div class="row"><input id="scanManual" placeholder="extra subnet e.g. 10.0.0.0/24" style="width:240px"></div>
    ${rows || "<p class='hint'>no usable interfaces found.</p>"}
    <div class="row"><button id="scanBtn">Scan</button> <span id="scanStatus" class="sub"></span></div>
    <div id="scanResults"></div>`;
  $("scanBtn").addEventListener("click", doScan);
}

function appendResult(d) {
  const div = document.createElement("div");
  div.className = "res";
  div.innerHTML = `
    <span class="ip">${esc(d.host)}</span>
    <span class="sub">[${esc(d.vendorEnterprise ?? "?")}] ${esc(d.vendor || "")}</span>
    <span>${esc(d.model || "")}</span>
    <span class="spacer"></span>
    <button class="manage secondary">Manage</button>`;
  div.querySelector(".manage").addEventListener("click", () => {
    $("host").value = d.host;
    $("discoverPanel").style.display = "none";
    connect();
  });
  $("scanResults").appendChild(div);
}

async function doScan() {
  const subs = [...document.querySelectorAll(".ifsel:checked")].map((c) => c.dataset.subnet);
  const manual = $("scanManual").value.trim();
  if (manual) subs.push(manual);
  if (subs.length === 0) { $("scanStatus").textContent = "select an interface or enter a subnet"; return; }
  const cred = getCred();
  $("scanBtn").disabled = true;
  $("scanResults").innerHTML = "";
  let count = 0;
  const seen = new Set();
  // Devices stream in live; append each (de-duped) rather than replacing.
  const off = window.switchkeeper.onScanDevice((d) => {
    if (seen.has(d.host)) return;
    seen.add(d.host);
    count++;
    appendResult(d);
    $("scanStatus").textContent = "scanning... found " + count;
  });
  $("scanStatus").textContent = "scanning " + subs.join(", ") + " ...";
  const res = await window.switchkeeper.scan({ specs: subs.join(","), cred });
  if (off) off();
  $("scanBtn").disabled = false;
  if (!res.ok) { $("scanStatus").textContent = "error: " + res.error; return; }
  $("scanStatus").textContent = "found " + count + " device(s)";
  if (count === 0) {
    $("scanResults").innerHTML = "<p class='hint'>no SNMP devices answered on those subnets (try a different community).</p>";
  }
}

async function saveConfig() {
  if (!lastState) { setStatus("read a switch first"); return; }
  const cred = getCred();
  if (cred.version === "v2c" && !cred.writeCommunity) { setStatus("need a write community to save", "error"); return; }
  if (cred.version === "v3" && !cred.v3.user) { setStatus("need a v3 user to save", "error"); return; }
  setStatus("saving config...", "spin");
  const res = await window.switchkeeper.save({ host: $("host").value.trim(), cred });
  if (!res.ok) { setStatus("save error: " + res.error, "error"); return; }
  const s = res.data && res.data.save;
  if (s && s.ok) setStatus("config saved to startup");
  else if (s && s.supported === false) setStatus("SNMP save not available here - use 'open UI' then Maintenance > Save Configuration");
  else setStatus("save: " + (s ? s.message : "no result"), "error");
}

// --- Topology: LLDP neighbours + forwarding database (MAC -> port) ---
function portLabel(num) {
  const p = (lastState?.ports || []).find((x) => x.bridgePort === num || x.ifIndex === num);
  return p ? esc(p.name) + (p.label ? " (" + esc(p.label) + ")" : "") : "#" + num;
}

async function loadTopology() {
  if (!lastState) { setStatus("read a switch first"); return; }
  const panel = $("topology");
  if (panel.style.display === "block") { panel.style.display = "none"; return; } // toggle off
  setStatus("reading topology...", "spin");
  const res = await window.switchkeeper.topology({ host: $("host").value.trim(), cred: getCred() });
  if (!res || !res.ok) { setStatus("topology error: " + ((res && res.error) || "no result"), "error"); return; }
  renderTopology(res.data || { lldp: [], fdb: [] });
  panel.style.display = "block";
  setStatus("topology loaded");
}

function renderTopology(data) {
  const lldp = data.lldp || [];
  const fdb = data.fdb || [];
  const lldpRows = lldp.map((n) =>
    `<tr><td>${portLabel(n.localPort)}</td><td>${esc(n.remoteSysName || "")}</td>` +
    `<td>${esc(n.remotePortDesc || n.remotePortId || "")}</td><td class="mono">${esc(n.remoteChassisId || "")}</td></tr>`
  ).join("") || `<tr><td colspan="4" class="empty">no LLDP neighbours reported</td></tr>`;

  const byPort = new Map();
  for (const e of fdb) byPort.set(e.bridgePort, (byPort.get(e.bridgePort) || 0) + 1);
  const hint = [...byPort.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([port, c]) => `<span class="chip">${portLabel(port)}: ${c} MAC${c === 1 ? "" : "s"}</span>`).join("")
    || "<span class='empty'>no MACs learned</span>";

  const cap = 300;
  const macRows = fdb.slice(0, cap).map((e) =>
    `<tr><td class="mono">${esc(e.mac)}</td><td>${e.vlan ?? ""}</td><td>${portLabel(e.bridgePort)}</td></tr>`
  ).join("") || `<tr><td colspan="3" class="empty">forwarding database empty</td></tr>`;

  $("topology").innerHTML =
    `<h2>LLDP neighbours (${lldp.length})</h2>` +
    `<div class="scrollwrap"><table><thead><tr><th>Local port</th><th>Neighbour</th><th>Remote port</th><th>Chassis</th></tr></thead><tbody>${lldpRows}</tbody></table></div>` +
    `<h2>Forwarding database (${fdb.length} MAC${fdb.length === 1 ? "" : "s"})</h2>` +
    `<div class="hint">Likely uplinks (most MACs): ${hint}</div>` +
    `<div class="scrollwrap"><table><thead><tr><th>MAC</th><th>VLAN</th><th>Port</th></tr></thead><tbody>${macRows}</tbody></table></div>` +
    (fdb.length > cap ? `<div class="empty">showing first ${cap} of ${fdb.length}</div>` : "");
}

// ====================================================================================
// Device details / Capabilities (MIB-driven adaptive view) — Phase 1, READ-ONLY.
// Renders CapabilityModel.sections in order: curated sections always show; generic
// sections (kind:"generic") are hidden unless Advanced mode is ON. No edit controls.
// ====================================================================================

// --- INTEGRATION FLAG ----------------------------------------------------------------
// Set to true to render the bundled MOCK_CAPABILITIES fixture (UI dev without a device);
// false calls the live window.switchkeeper.capabilities(). Live is the shipped default.
const CAPS_USE_MOCK = false;
// -------------------------------------------------------------------------------------

// Advanced mode: off by default, persisted in-memory for the session only (per spec).
let advancedMode = false;

// A realistic CapabilityModel fixture matching the Phase-1 contract shape:
// one curated scalar section (system), one curated table section (ports), one generic section.
const MOCK_CAPABILITIES = {
  host: "192.168.1.10",
  vendor: "Netgear",
  mibs: { loaded: 7, indexed: 312 },
  sections: [
    {
      id: "system",
      title: "System & Inventory",
      kind: "curated",
      scalars: [
        { name: "sysName", oid: "1.3.6.1.2.1.1.5.0", value: "core-sw-01", type: "DisplayString" },
        { name: "sysDescr", oid: "1.3.6.1.2.1.1.1.0", value: "Netgear GS748Tv5 ProSafe 48-port", type: "DisplayString" },
        { name: "model", oid: "1.3.6.1.2.1.47.1.1.1.1.13.1", value: "GS748Tv5", type: "DisplayString" },
        { name: "serialNumber", oid: "1.3.6.1.2.1.47.1.1.1.1.11.1", value: "4ML1234A56789", type: "DisplayString" },
        { name: "firmwareVersion", oid: "1.3.6.1.2.1.47.1.1.1.1.10.1", value: "6.3.1.18", type: "DisplayString" },
        { name: "sysUpTime", oid: "1.3.6.1.2.1.1.3.0", value: "41 days, 02:13:55", type: "TimeTicks" },
      ],
    },
    {
      id: "ports",
      title: "Ports",
      kind: "curated",
      table: {
        columns: ["ifIndex", "Name", "Admin", "Oper", "Speed (Mb/s)"],
        rows: [
          [1, "g1", "up", "up", 1000],
          [2, "g2", "up", "down", null],
          [3, "g3", "down", "down", null],
          [48, "g48 (uplink)", "up", "up", 1000],
        ],
      },
    },
    {
      id: "POWER-ETHERNET-MIB",
      title: "PoE (Power-over-Ethernet)",
      kind: "curated",
      scalars: [
        { name: "pethMainPseUsageThreshold", oid: "1.3.6.1.2.1.105.1.3.1.1.4.1", value: 90, type: "Integer32" },
        { name: "pethMainPseConsumptionPower", oid: "1.3.6.1.2.1.105.1.3.1.1.4.1", value: 73, type: "Gauge32" },
      ],
    },
    {
      // Generic catch-all section: rendered identically but gated behind Advanced mode.
      id: "NETGEAR-FAN-MIB",
      title: "Vendor objects · NETGEAR-FAN-MIB",
      kind: "generic",
      table: {
        columns: ["fanIndex", "fanDescription", "fanState", "fanSpeedRpm"],
        rows: [
          [1, "Fan tray 1", "operational", 4200],
          [2, "Fan tray 2", "operational", 4180],
        ],
      },
    },
    {
      id: "NETGEAR-ENVIRONMENT-MIB",
      title: "Vendor objects · NETGEAR-ENVIRONMENT-MIB",
      kind: "generic",
      scalars: [
        { name: "ngTemperatureCelsius", oid: "1.3.6.1.4.1.4526.10.43.1.6.1.3.1", value: 38, type: "Integer32" },
        { name: "ngPsuStatus", oid: "1.3.6.1.4.1.4526.10.43.1.5.1.4.1", value: "ok", type: "DisplayString" },
      ],
    },
  ],
};

let lastCaps = null; // cache so the Advanced toggle can re-render without re-fetching

function capScalarTable(scalars) {
  const rows = (scalars || []).map((s) => {
    const v = s.value === null || s.value === undefined || s.value === ""
      ? '<span class="empty">-</span>' : esc(s.value);
    const t = s.type ? ` <span class="empty">(${esc(s.type)})</span>` : "";
    return `<tr><th title="${esc(s.oid || "")}">${esc(s.name)}</th><td class="val">${v}</td></tr>`;
  }).join("");
  return `<table class="kv-table"><tbody>${rows}</tbody></table>`;
}

function capDataTable(table) {
  const head = (table.columns || []).map((c) => `<th>${esc(c)}</th>`).join("");
  const body = (table.rows || []).map((row) =>
    "<tr>" + (row || []).map((cell) =>
      (cell === null || cell === undefined || cell === "")
        ? '<td class="empty">-</td>'
        : (typeof cell === "number" ? `<td class="num">${esc(cell)}</td>` : `<td>${esc(cell)}</td>`)
    ).join("") + "</tr>"
  ).join("");
  return `<div class="scrollwrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderCapabilities(model) {
  lastCaps = model;
  const panel = $("capabilities");
  const sections = model.sections || [];
  const generic = sections.filter((s) => s.kind === "generic");
  // Curated sections always render; generic ones only when Advanced mode is on.
  const visible = sections.filter((s) => s.kind !== "generic" || advancedMode);

  const sectionHtml = visible.map((s) => {
    const gtag = s.kind === "generic" ? ` <span class="gtag">generic</span>` : "";
    let inner = "";
    if (s.scalars && s.scalars.length) inner += capScalarTable(s.scalars);
    if (s.table) inner += capDataTable(s.table);
    if (!inner) inner = '<p class="empty">no values reported</p>';
    return `<div class="capsection"><h2>${esc(s.title)}${gtag}</h2>${inner}</div>`;
  }).join("");

  const advClass = advancedMode ? "advtoggle on" : "advtoggle";
  const hiddenNote = (!advancedMode && generic.length)
    ? `<span class="sum">${generic.length} vendor section${generic.length === 1 ? "" : "s"} hidden</span>` : "";
  const mibs = model.mibs || { loaded: 0, indexed: 0 };

  panel.innerHTML =
    `<div class="capbar">
       <span class="sum">vendor <b>${esc(model.vendor || "Unknown")}</b></span>
       <span class="sum">MIBs loaded <b>${esc(mibs.loaded ?? 0)}</b> · indexed <b>${esc(mibs.indexed ?? 0)}</b></span>
       ${hiddenNote}
       <span class="spacer"></span>
       <label class="${advClass}" title="Show generic vendor objects exposed by the device's MIBs (read-only)">
         <input type="checkbox" id="advChk" ${advancedMode ? "checked" : ""}> Advanced mode
       </label>
     </div>` +
    (advancedMode ? `<div class="advbanner">Advanced mode ON — showing all generic vendor objects the MIBs expose (read-only).</div>` : "") +
    (sections.length ? sectionHtml : `<p class="empty" style="margin-top:14px">No capability sections${mibs.loaded ? "" : " (no MIBs loaded — import the device's MIBs to see vendor objects)"}.</p>`);

  const chk = $("advChk");
  if (chk) chk.addEventListener("change", () => { advancedMode = chk.checked; renderCapabilities(lastCaps); });
}

async function loadCapabilities() {
  const panel = $("capabilities");
  if (panel.style.display === "block") { panel.style.display = "none"; return; } // toggle off
  setStatus("reading device details...", "spin");
  try {
    let model;
    if (CAPS_USE_MOCK) {
      // Mock path — lets the full UI render before the engine lands. Flip CAPS_USE_MOCK above.
      model = { ...MOCK_CAPABILITIES, host: $("host").value.trim() || MOCK_CAPABILITIES.host };
    } else {
      const res = await window.switchkeeper.capabilities({ host: $("host").value.trim(), cred: getCred() });
      if (!res || !res.ok) { setStatus("details error: " + ((res && res.error) || "no result"), "error"); return; }
      model = res.data || { host: "", vendor: "", mibs: { loaded: 0, indexed: 0 }, sections: [] };
    }
    renderCapabilities(model);
    panel.style.display = "block";
    setStatus("device details loaded" + (CAPS_USE_MOCK ? " (mock)" : ""));
  } catch (e) {
    setStatus("details error: " + ((e && e.message) || e), "error");
  }
}

$("connect").addEventListener("click", connect);
$("refresh").addEventListener("click", connect);
$("topoBtn").addEventListener("click", loadTopology);
$("capBtn").addEventListener("click", loadCapabilities);
$("discoverBtn").addEventListener("click", openDiscover);
$("saveBtn").addEventListener("click", saveConfig);
$("version").addEventListener("change", toggleVersion);
$("host").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
$("community").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
