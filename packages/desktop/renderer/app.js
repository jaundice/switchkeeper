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

$("connect").addEventListener("click", connect);
$("refresh").addEventListener("click", connect);
$("discoverBtn").addEventListener("click", openDiscover);
$("saveBtn").addEventListener("click", saveConfig);
$("version").addEventListener("change", toggleVersion);
$("host").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
$("community").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
