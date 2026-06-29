"use strict";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let lastState = null;
const pending = new Map(); // bridgePort -> { bridge, vid, orig }   (PVID edits)
const memEdits = new Map(); // vid -> { tagged:Set, untagged:Set }  (membership edits)
const pendingLag = new Map(); // bridgePort -> lagId|null            (LAG edits)
// Phase 3: at most one generic-object write is staged at a time. Shape mirrors the engine Edit:
// { kind:"setObject", oid, value, snmpType?, name? }. It rides the SAME review/gating/apply path
// as the grid edits (collectEdits includes it; the SafetyEngine classifies it risky/blocked).
let pendingSetObject = null;

// ====================================================================================
// Phase 2: write-safety gating (consumes ChangeSet.safety from the plan path).
// The flow is: edit -> "Review & apply" runs a dry-run plan -> we render each edit's
// classification + the protected-set summary -> Apply is gated per the spec (simple vs
// advanced mode, risky confirm checkbox, blocked typed confirm) -> after a reachable
// apply, a SEPARATE "Save to startup" action appears. Nothing is ever auto-saved.
// ====================================================================================

// --- INTEGRATION FLAG ----------------------------------------------------------------
// While the engine's SafetyEngine lands in parallel, set this true to inject MOCK_SAFETY
// into the plan result so the full gating UI can be exercised without a live classifier.
// SHIPPED DEFAULT IS false (use the engine's real changeSet.safety). Flip to true for UI dev.
const SAFETY_USE_MOCK = false;
// -------------------------------------------------------------------------------------

// Mock SafetyReport: one safe, one risky, one blocked edit + a sample protected set.
// Matches the contract shape (protectedSet / classifications[{edit,cls,reason}] / worst).
const MOCK_SAFETY = {
  protectedSet: {
    ports: [5],
    vlans: [1],
    reason: "Source MAC found in FDB behind bridge port 5; mgmt VLAN = PVID of that port (1).",
    confidence: "high",
  },
  classifications: [
    { edit: { kind: "setPortLabel", ifIndex: 12, label: "AP-lobby" }, cls: "safe",
      reason: "Renames an access port; does not touch the management path." },
    { edit: { kind: "setLag", bridgePort: 5, lagId: 2 }, cls: "risky",
      reason: "Adds the management access port (port 5) to a LAG; may briefly disrupt the switch." },
    { edit: { kind: "setPortAdmin", ifIndex: 5, up: false }, cls: "blocked",
      reason: "Admin-down of port 5 — the port the app reaches the switch through." },
  ],
  worst: "blocked",
};

// Diff / change history: an in-session log of applied change-sets (no persistence per the contract).
// Each entry: { ts (ISO), host, items:[{ label, before, after, cls }], status, reachableAfter }.
// `before`/`after`/`cls` are best-effort from the reviewed plan + the model; the panel below renders
// it collapsibly. Populated in applyEdits() right after a successful apply.
const changeHistory = [];

// Captured between the plan (review) and apply steps:
let lastPlanSafety = null; // SafetyReport from the most recent dry-run plan (or null)
let lastApply = null;      // { reachableAfter } from the most recent successful apply (or null)
let blockedConfirmText = ""; // what the user has typed into the blocked typed-confirm box

// The token the user must type to release blocked edits: prefer an affected protected port
// name (clearer for operators), else the literal "DISCONNECT".
function blockedConfirmToken(safety) {
  const ps = safety && safety.protectedSet;
  const port = ps && Array.isArray(ps.ports) && ps.ports.length ? ps.ports[0] : null;
  if (port != null) {
    const p = (lastState?.ports || []).find((x) => x.bridgePort === port || x.ifIndex === port);
    if (p && p.name) return String(p.name);
  }
  return "DISCONNECT";
}

// Short human label for an edit, for the classification list.
function editLabel(e) {
  if (!e || !e.kind) return "edit";
  switch (e.kind) {
    case "setPvid": return `Set PVID of port ${e.bridgePort} to VLAN ${e.vid}`;
    case "setVlanMembership": return `Change VLAN ${e.vid} membership`;
    case "setPortAdmin": return `${e.up ? "Enable" : "Disable"} port ${e.ifIndex}`;
    case "setPortLabel": return `Label port ${e.ifIndex} "${e.label}"`;
    case "setPoe": return `PoE ${e.on ? "on" : "off"} for port ${e.bridgePort}`;
    case "setLag": return e.lagId == null ? `Remove port ${e.bridgePort} from LAG` : `Add port ${e.bridgePort} to LAG ${e.lagId}`;
    case "createVlan": return `Create VLAN ${e.vid}${e.name ? ` (${e.name})` : ""}`;
    case "deleteVlan": return `Delete VLAN ${e.vid}`;
    case "setObject": return `Set ${e.name ? e.name : e.oid} = ${e.value}`;
    default: return e.kind;
  }
}

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

// Collect the working edits into the engine Edit[] shape.
function collectEdits() {
  return [
    ...[...pending.values()].map((p) => ({ kind: "setPvid", bridgePort: p.bridge, vid: p.vid })),
    ...[...memEdits.entries()].map(([vid, e]) => ({ kind: "setVlanMembership", vid, tagged: [...e.tagged], untagged: [...e.untagged] })),
    ...[...pendingLag.entries()].map(([bridge, lagId]) => ({ kind: "setLag", bridgePort: bridge, lagId })),
    // Phase 3: a staged generic-object write rides the same path. Drop undefined snmpType/name so the
    // engine infers the SNMP type from the MIB SYNTAX when the meta didn't carry one.
    ...(pendingSetObject ? [pruneEdit({
      kind: "setObject", oid: pendingSetObject.oid, value: pendingSetObject.value,
      snmpType: pendingSetObject.snmpType, name: pendingSetObject.name,
    })] : []),
  ];
}

// Drop keys whose value is undefined/null so the JSON edit stays minimal (engine infers them).
function pruneEdit(e) {
  const out = {};
  for (const k of Object.keys(e)) if (e[k] !== undefined && e[k] !== null) out[k] = e[k];
  return out;
}

// Total count of staged edits across all editors (grid + generic object).
function pendingTotal() {
  return pending.size + memEdits.size + pendingLag.size + (pendingSetObject ? 1 : 0);
}

function clearPendingState() {
  pending.clear(); memEdits.clear(); pendingLag.clear();
  pendingSetObject = null;
  lastPlanSafety = null; blockedConfirmText = "";
}

// The bottom bar. Without a safety review it shows pending count + "Review & apply"; once a plan
// has been reviewed it expands to the classification list + gated Apply (and, after a reachable
// apply, the separate Save-to-startup action).
function renderPending(msg, cls) {
  const bar = $("pending");
  const total = pendingTotal();
  // The bar stays visible while there are edits, a review is open, or a save is offered.
  if (total === 0 && !msg && !lastPlanSafety && !lastApply) { bar.style.display = "none"; bar.innerHTML = ""; return; }
  const parts = [
    ...[...pending.values()].map((p) => `g${p.bridge}->VLAN ${p.vid}`),
    ...[...memEdits.keys()].map((vid) => `VLAN ${vid} members`),
    ...[...pendingLag.entries()].map(([b, lag]) => `g${b}->${lag == null ? "no LAG" : "LAG " + lag}`),
    ...(pendingSetObject ? [`${pendingSetObject.name || pendingSetObject.oid}=${pendingSetObject.value}`] : []),
  ];
  bar.style.display = "flex";
  bar.style.flexWrap = "wrap";

  // Post-apply save offer (separate, deliberate action; only after a successful apply).
  if (lastApply && total === 0 && !lastPlanSafety) {
    renderSaveOffer(bar, msg, cls);
    return;
  }

  // Review open: show the safety panel + gated apply.
  if (lastPlanSafety) {
    renderReviewBar(bar, msg, cls);
    return;
  }

  // Default: edits pending, no review yet.
  bar.innerHTML = `
    <span class="count">${total} pending</span>
    <span class="msg ${cls || ""}">${esc(msg || parts.join(", "))}</span>
    <span class="spacer"></span>
    <button id="discard" class="secondary">Discard</button>
    <button id="review">Review &amp; apply</button>`;
  $("review").addEventListener("click", reviewPending);
  $("discard").addEventListener("click", () => { clearPendingState(); renderAll(); renderPending(); });
}

// Render the protected-set one-liner, e.g. "Management path: port 5, VLAN 1 (confidence: high)".
function protectedSummary(safety) {
  const ps = (safety && safety.protectedSet) || {};
  const ports = (ps.ports || []).map((p) => `port ${p}`);
  const vlans = (ps.vlans || []).map((v) => `VLAN ${v}`);
  const bits = [...ports, ...vlans];
  const path = bits.length ? bits.join(", ") : "not determined";
  const conf = ps.confidence ? ` <span class="conf">(confidence: ${esc(ps.confidence)})</span>` : "";
  const reason = ps.reason ? `<div class="conf" title="${esc(ps.reason)}">${esc(ps.reason)}</div>` : "";
  return `<div class="protset"><b>Management path:</b> ${esc(path)}${conf}${reason}</div>`;
}

// Render the per-edit classification list (colour + reason). Safe rows are deliberately calm.
function classificationList(safety) {
  const cls = (safety && safety.classifications) || [];
  if (!cls.length) return '<p class="empty">No edits to classify.</p>';
  const rows = cls.map((c) => {
    const k = c.cls === "blocked" ? "blocked" : c.cls === "risky" ? "risky" : "safe";
    return `<li class="clsrow ${k}">
      <span class="tag">${esc(k)}</span>
      <span class="desc">${esc(editLabel(c.edit))}</span>
      <span class="why">— ${esc(c.reason || "")}</span>
    </li>`;
  }).join("");
  return `<ul class="clslist">${rows}</ul>`;
}

// Decide whether Apply may proceed, given the mode and the user's confirmations.
// Returns { enabled, hint, acknowledge }.
function gateDecision(safety) {
  const worst = (safety && safety.worst) || "safe";
  const hasRisky = worst === "risky" || worst === "blocked";
  const hasBlocked = worst === "blocked";

  if (!advancedMode) {
    // Simple mode: only fully-safe change-sets may apply.
    if (worst === "safe") return { enabled: true, hint: "", acknowledge: undefined };
    return { enabled: false, hint: "Enable Advanced mode to apply risky changes", acknowledge: undefined };
  }

  // Advanced mode: risky needs the confirm checkbox; blocked needs the typed token (and checkbox).
  const riskyOk = !hasRisky || $("ackRisky")?.checked;
  const token = blockedConfirmToken(safety);
  const blockedOk = !hasBlocked || (blockedConfirmText.trim() === token);
  const enabled = riskyOk && blockedOk;
  let hint = "";
  if (!riskyOk) hint = "Tick the box to confirm you understand the risk";
  else if (!blockedOk) hint = `Type "${token}" to confirm the blocked change`;
  // Plain-safe sets send no acknowledge at all; otherwise set only the flags the situation needs
  // (and only because the gate above already required the matching confirmation to be enabled).
  let acknowledge;
  if (hasRisky || hasBlocked) {
    acknowledge = {};
    if (hasRisky) acknowledge.allowRisky = true;
    if (hasBlocked) acknowledge.allowBlocked = true;
  }
  return { enabled, hint, acknowledge };
}

function renderReviewBar(bar, msg, cls) {
  const safety = lastPlanSafety;
  const worst = (safety && safety.worst) || "safe";
  const hasRisky = worst === "risky" || worst === "blocked";
  const hasBlocked = worst === "blocked";
  const token = blockedConfirmToken(safety);
  const decision = gateDecision(safety);

  // Gate controls only when Advanced mode is on (simple mode never offers a risky/blocked apply).
  let gateHtml = "";
  if (advancedMode && hasRisky) {
    gateHtml += `<div class="gate"><label>
      <input type="checkbox" id="ackRisky" ${$("ackRisky")?.checked ? "checked" : ""}>
      I understand this may disrupt the switch</label></div>`;
  }
  if (advancedMode && hasBlocked) {
    gateHtml += `<div class="gate blocked">
      <span class="glabel">This severs the management path. Type <b>${esc(token)}</b> to confirm:</span>
      <input type="text" id="ackBlocked" autocomplete="off" placeholder="${esc(token)}" value="${esc(blockedConfirmText)}">
    </div>`;
  }
  const hint = decision.hint || msg || "";

  // Reuse the Phase-1 Advanced-mode toggle here too, so the operator can flip it without leaving
  // the review (it shares the same `advancedMode` state as the Details panel).
  const advClass = advancedMode ? "advtoggle on" : "advtoggle";

  bar.innerHTML =
    `<div class="safety" style="width:100%">
       ${protectedSummary(safety)}
       ${classificationList(safety)}
       ${gateHtml}
     </div>
     <label class="${advClass}" title="Advanced mode is required to apply risky or blocked changes">
       <input type="checkbox" id="advChkBar" ${advancedMode ? "checked" : ""}> Advanced mode
     </label>
     <span class="msg ${cls || ""}">${esc(hint)}</span>
     <span class="spacer"></span>
     <button id="back" class="secondary">Back</button>
     <button id="apply" class="${hasBlocked ? "danger" : ""}" ${decision.enabled ? "" : "disabled"}>Apply</button>`;

  const adv = $("advChkBar");
  if (adv) adv.addEventListener("change", () => {
    advancedMode = adv.checked;
    blockedConfirmText = ""; // re-arm the typed confirm when the mode flips
    if (lastCaps) renderCapabilities(lastCaps); // keep the Details panel toggle in sync
    renderPending();
  });
  const r = $("ackRisky");
  if (r) r.addEventListener("change", () => renderPending());
  const b = $("ackBlocked");
  if (b) b.addEventListener("input", () => { blockedConfirmText = b.value; updateApplyEnabled(); });
  $("back").addEventListener("click", () => { lastPlanSafety = null; blockedConfirmText = ""; renderPending(); });
  $("apply").addEventListener("click", () => applyEdits(decision.acknowledge));
}

// Cheap re-evaluation of the Apply button without re-rendering (keeps text-box focus/caret).
function updateApplyEnabled() {
  const btn = $("apply");
  if (!btn || !lastPlanSafety) return;
  const decision = gateDecision(lastPlanSafety);
  btn.disabled = !decision.enabled;
}

// Step 1: dry-run plan to obtain the SafetyReport, then open the review panel.
async function reviewPending() {
  if (pendingTotal() === 0) return;
  const host = $("host").value.trim();
  const cred = getCred();
  if (cred.version === "v2c" && !cred.writeCommunity) { renderPending("enter a write community to apply", "bad"); return; }
  if (cred.version === "v3" && !cred.v3.user) { renderPending("enter a v3 user to apply", "bad"); return; }
  const edits = collectEdits();
  renderPending("checking safety...", "");
  const res = await window.switchkeeper.plan({ host, cred, edits });
  if (!res.ok) { renderPending("plan error: " + res.error, "bad"); return; }
  const cs = (res.data && res.data.changeSet) || {};
  // Live: use the engine's safety report. Mock: inject the fixture so the gating UI is exercisable
  // before the SafetyEngine lands (flip SAFETY_USE_MOCK at the top of this file).
  lastPlanSafety = SAFETY_USE_MOCK ? MOCK_SAFETY : (cs.safety || null);
  if (!lastPlanSafety) {
    // No classifier present and not mocking: treat as unknown -> require Advanced (fail safe).
    lastPlanSafety = { protectedSet: { ports: [], vlans: [], reason: "no safety report from engine", confidence: "low" },
      classifications: edits.map((e) => ({ edit: e, cls: "risky", reason: "unclassified (engine returned no safety report)" })),
      worst: edits.length ? "risky" : "safe" };
  }
  blockedConfirmText = "";
  renderPending();
}

// Step 2: apply with the right acknowledge flags. acknowledge is undefined for plain-safe sets.
async function applyEdits(acknowledge) {
  const host = $("host").value.trim();
  const cred = getCred();
  const edits = collectEdits();
  if (!edits.length) return;
  $("apply").disabled = true;
  renderPending("applying " + edits.length + " change(s)...");
  const res = await window.switchkeeper.apply({ host, cred, edits, acknowledge });
  if (!res.ok) { lastPlanSafety && renderReviewBar($("pending"), "apply error: " + res.error, "bad"); return; }
  const data = res.data || {};
  const cs = data.changeSet || {};
  if (cs.status === "verified") {
    const n = edits.length;
    // Apply succeeded. Record reachability so the (separate) Save-to-startup action can gate on it.
    lastApply = { reachableAfter: data.reachableAfter === true };
    // Diff / change history: snapshot what just landed BEFORE clearPendingState() wipes the staging
    // state. Classification comes from the reviewed plan (lastPlanSafety); before/after are best-effort.
    recordHistory(edits, cs, data.reachableAfter === true);
    clearPendingState();
    setStatus("applied " + n + " change(s)");
    await connect();           // re-read (rebuilds the grid + pending bar)
    renderPending();           // re-show the save offer (connect() called renderPending with no edits)
  } else {
    const firstErr = (cs.results || []).find((r) => !r.ok);
    let why = firstErr ? (firstErr.error || "verify failed") : cs.status;
    if (/time/i.test(why)) why = "write timed out - writes must come from the management host (.2), not this PC";
    renderPending("apply " + cs.status + ": " + why, "bad");
  }
}

// Separate, deliberate "Save to startup" offer shown only after a successful apply.
// The button is disabled unless the apply reported reachableAfter === true (per the contract).
function renderSaveOffer(bar, msg, cls) {
  const reachable = lastApply && lastApply.reachableAfter === true;
  const note = reachable
    ? "Changes are in running config only. Save them to startup to keep them permanently."
    : "Switch not confirmed reachable after the change — saving is disabled so a reboot recovers.";
  bar.innerHTML =
    `<span class="count ok">applied</span>
     <span class="msg savehint ${cls || ""}">${esc(msg || note)}</span>
     <span class="spacer"></span>
     <button id="dismissSave" class="secondary">Dismiss</button>
     <button id="saveStartup" class="savestartup" ${reachable ? "" : "disabled"}
       title="${reachable ? "Persist running config to startup" : "Disabled until the switch is confirmed reachable"}">Save to startup</button>`;
  $("dismissSave").addEventListener("click", () => { lastApply = null; renderPending(); });
  const sb = $("saveStartup");
  if (sb) sb.addEventListener("click", saveToStartup);
}

// Persist running config to startup — gated on a successful, reachable apply + a confirm.
async function saveToStartup() {
  if (!lastApply || lastApply.reachableAfter !== true) return;
  if (!window.confirm("Keep changes permanently? This saves the running config to startup.")) return;
  const cred = getCred();
  $("saveStartup").disabled = true;
  renderPending("saving to startup...");
  const res = await window.switchkeeper.save({ host: $("host").value.trim(), cred });
  if (!res.ok) { renderSaveOffer($("pending"), "save error: " + res.error, "bad"); return; }
  const s = res.data && res.data.save;
  lastApply = null;
  if (s && s.ok) { renderPending(); setStatus("config saved to startup"); }
  else if (s && s.supported === false) { renderPending(); setStatus("SNMP save not available here - use 'open UI' then Maintenance > Save Configuration"); }
  else { renderPending(); setStatus("save: " + (s ? s.message : "no result"), "error"); }
}

// Build a history entry from the just-applied edits + the reviewed plan's classifications, and push it.
// `before` is read from the current model (scalars) where we can find it; grid edits don't have a
// single before/after value so we record the human label only. After re-render the History panel shows it.
function recordHistory(edits, changeSet, reachableAfter) {
  const cls = (lastPlanSafety && lastPlanSafety.classifications) || [];
  // Match a classification to an edit by reference first, else by a structural label match.
  const clsFor = (e) => {
    const byRef = cls.find((c) => c.edit === e);
    if (byRef) return byRef.cls;
    const lbl = editLabel(e);
    const byLabel = cls.find((c) => editLabel(c.edit) === lbl);
    return byLabel ? byLabel.cls : "";
  };
  const items = edits.map((e) => {
    let before = "";
    let after = "";
    if (e.kind === "setObject") {
      before = currentObjectValue(e.oid, e.name);
      after = e.value;
    }
    return { label: editLabel(e), before, after, cls: clsFor(e) };
  });
  changeHistory.unshift({
    ts: new Date().toISOString(),
    host: $("host").value.trim(),
    items,
    status: (changeSet && changeSet.status) || "verified",
    reachableAfter,
  });
}

// Look up a scalar's (or table cell's) current value from the capability model by OID/name, for the
// "before" column of the history diff. The model carries the pre-apply value (history is recorded
// before the re-read), so this is the value the operator changed FROM. Returns "" if not found.
function currentObjectValue(oid, name) {
  const baseOid = String(oid || "").replace(/\.0$/, "");
  for (const s of (lastCaps?.sections || [])) {
    for (const sc of (s.scalars || [])) {
      if ((name && sc.name === name) || (oid && (sc.oid === oid || sc.oid === baseOid))) {
        return sc.value == null ? "" : String(sc.value);
      }
    }
  }
  return "";
}

// Collapsible "History" panel: renders the in-session change log. Empty until a successful apply.
// Lives in the #history container (toggled from the header History button). No persistence.
function renderHistory() {
  const panel = $("history");
  if (!panel) return;
  if (!changeHistory.length) {
    panel.innerHTML = `<h2>Change history</h2><p class="empty">No changes applied this session.</p>`;
    return;
  }
  const sets = changeHistory.map((h) => {
    const when = new Date(h.ts).toLocaleString();
    const rows = h.items.map((it) => {
      const k = it.cls === "blocked" ? "blocked" : it.cls === "risky" ? "risky" : "safe";
      const tag = it.cls ? `<span class="tag ${k}">${esc(it.cls)}</span>` : "";
      const diff = (it.before !== "" || it.after !== "")
        ? `<span class="hdiff"><span class="empty">${esc(it.before || "∅")}</span> → <b>${esc(it.after || "∅")}</b></span>` : "";
      return `<li class="hitem">${tag}<span class="hlabel">${esc(it.label)}</span> ${diff}</li>`;
    }).join("");
    const reach = h.reachableAfter ? "reachable" : "reachability unconfirmed";
    return `<div class="hset">
        <div class="hhead"><b>${esc(when)}</b> · ${esc(h.host)} · <span class="ok">${esc(h.status)}</span>
          <span class="empty">(${esc(reach)})</span></div>
        <ul class="hlist">${rows}</ul>
      </div>`;
  }).join("");
  panel.innerHTML = `<h2>Change history (${changeHistory.length} apply${changeHistory.length === 1 ? "" : " events"})</h2>${sets}`;
}

function toggleHistory() {
  const panel = $("history");
  if (!panel) return;
  if (panel.style.display === "block") { panel.style.display = "none"; return; }
  renderHistory();
  panel.style.display = "block";
}

// Snapshot / export: download the current capability model (curated + scalars + any loaded tables)
// plus host + ISO timestamp as a JSON file, via a client-side Blob + anchor download. The loaded-table
// cache (loadedTables) is merged back into each section so a table the operator expanded is exported
// with its rows; un-loaded lazy stubs export as stubs (rows omitted). Read-only; no device traffic.
function exportSnapshot() {
  if (!lastCaps) { setStatus("open Details first to export the capability model", "error"); return; }
  // Deep-ish clone so we can fold loaded rows in without mutating the live model.
  const model = JSON.parse(JSON.stringify(lastCaps));
  for (const s of (model.sections || [])) {
    const loaded = loadedTables.get(s.id);
    if (loaded && s.table) s.table = JSON.parse(JSON.stringify(loaded)); // export the rows the user loaded
  }
  const snapshot = {
    tool: "switchkeeper",
    exportedAt: new Date().toISOString(),
    host: model.host || $("host").value.trim(),
    vendor: model.vendor || null,
    mibs: model.mibs || null,
    capabilities: model.sections || [],
  };
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = snapshot.exportedAt.replace(/[:.]/g, "-");
  const host = (snapshot.host || "device").replace(/[^a-zA-Z0-9._-]/g, "_");
  a.href = url;
  a.download = `switchkeeper-${host}-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url); // free the blob once the download has been kicked off
  setStatus("exported capability snapshot");
}

// ====================================================================================
// Credential caching (convenience for this trusted-LAN tool).
//
// SECURITY NOTE: SNMP community strings (and v3 keys) are credentials, and these are stored
// in plaintext in window.localStorage. That is an intentional convenience trade-off for a
// LAN admin tool run on the operator's own machine — there is a clearly-labelled "Remember
// credentials" opt-out (default ON) that disables persistence and wipes the host's stored
// entry. We never log credential values.
//
// Shape:
//   localStorage "sk.creds"    = { "<host>": { version, community?, writeCommunity?, v3?:{...} } }
//   localStorage "sk.lastHost" = "<host>"            (prefilled into the host field on load)
//   localStorage "sk.remember" = "1" | "0"           (the checkbox state)
// ====================================================================================
const CREDS_KEY = "sk.creds";
const LAST_HOST_KEY = "sk.lastHost";
const REMEMBER_KEY = "sk.remember";

// Tolerate environments without localStorage (or where access throws, e.g. blocked storage).
function lsGet(key) {
  try { return window.localStorage ? window.localStorage.getItem(key) : null; }
  catch (_e) { return null; }
}
function lsSet(key, val) {
  try { if (window.localStorage) window.localStorage.setItem(key, val); } catch (_e) { /* ignore */ }
}
function lsRemove(key) {
  try { if (window.localStorage) window.localStorage.removeItem(key); } catch (_e) { /* ignore */ }
}

function loadCredsMap() {
  const raw = lsGet(CREDS_KEY);
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch (_e) {
    return {}; // corrupt/legacy value — start fresh rather than throw
  }
}
function saveCredsMap(map) {
  lsSet(CREDS_KEY, JSON.stringify(map || {}));
}

function rememberOn() {
  const chk = $("remember");
  return chk ? chk.checked : true;
}

// Persist the current host's credentials (or, when "Remember" is off, ensure they're not kept).
function saveCurrentCreds() {
  const host = $("host").value.trim();
  if (host) lsSet(LAST_HOST_KEY, host);
  if (!rememberOn()) { forgetHost(host); return; }
  if (!host) return;
  const map = loadCredsMap();
  map[host] = getCred(); // {version, community?, writeCommunity?, v3?}
  saveCredsMap(map);
}

// Remove a single host's stored credentials (used on opt-out).
function forgetHost(host) {
  if (!host) return;
  const map = loadCredsMap();
  if (host in map) { delete map[host]; saveCredsMap(map); }
}

// Prefill the version/community/write-community (+ v3) fields for a known host from the cache.
function prefillCredsForHost(host) {
  if (!host) return;
  const c = loadCredsMap()[host];
  if (!c) return;
  $("version").value = c.version === "v3" ? "v3" : "v2c";
  toggleVersion();
  if (c.version === "v3") {
    const v3 = c.v3 || {};
    $("v3user").value = v3.user || "";
    $("v3authproto").value = v3.authProto || "";
    $("v3authkey").value = v3.authKey || "";
    $("v3privproto").value = v3.privProto || "";
    $("v3privkey").value = v3.privKey || "";
  } else {
    if (c.community != null) $("community").value = c.community;
    $("wcommunity").value = c.writeCommunity || "";
  }
}

// On load: restore the checkbox state, prefill the last-used host, and (if known) its creds.
function initCredCache() {
  const chk = $("remember");
  if (chk) {
    const pref = lsGet(REMEMBER_KEY);
    chk.checked = pref == null ? true : pref === "1"; // default ON
    chk.addEventListener("change", () => {
      lsSet(REMEMBER_KEY, chk.checked ? "1" : "0");
      // Turning the opt-out off should immediately drop the current host's stored creds.
      if (!chk.checked) forgetHost($("host").value.trim());
      else saveCurrentCreds();
    });
  }
  const last = lsGet(LAST_HOST_KEY);
  if (last && !$("host").value.trim()) $("host").value = last;
  prefillCredsForHost($("host").value.trim());
  // Prefill when the host field changes to a known host.
  const hostEl = $("host");
  if (hostEl) {
    hostEl.addEventListener("change", () => prefillCredsForHost(hostEl.value.trim()));
    hostEl.addEventListener("blur", () => prefillCredsForHost(hostEl.value.trim()));
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
  // Cache the credentials on Read (respects the "Remember" opt-out; also records last host).
  saveCurrentCreds();
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

// Search/filter: a case-insensitive substring filter over the generic sections' objects/rows (by
// name/oid/value). Held in-session; applied in renderCapabilities so a big device stays navigable.
// Empty string = no filter (everything shows). Curated sections are NOT filtered (they're small +
// always-relevant); the filter targets the potentially-huge generic vendor sections.
let capFilter = "";

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
      // Phase 4 fixture: a generic editable TABLE — read-write "Port priority" column carries
      // columnMeta/rowKeys, so each cell in it gets an "Edit" affordance (Advanced mode only).
      // The other columns are read-only (or lack meta) and stay display-only. rowKeys are the ifIndex
      // instance suffixes; the engine's row decoder maps these back to ports for safety gating.
      id: "EXTREME-PORT-MIB",
      title: "Vendor objects · per-port settings",
      kind: "generic",
      table: {
        columns: ["ifIndex", "Name", "Load-share group", "Port priority"],
        rows: [
          [1, "g1", 0, 128],
          [2, "g2", 0, 128],
          [5, "g5 (mgmt)", 0, 128],
          [49, "g49 (uplink)", 1, 64],
        ],
        index: "ifIndex",
        rowKeys: ["1", "2", "5", "49"],
        columnMeta: [
          { name: "ifIndex", oid: "1.3.6.1.2.1.2.2.1.1", access: "read-only", base: "integer" },
          { name: "ifName", oid: "1.3.6.1.2.1.31.1.1.1.1", access: "read-only", base: "string" },
          { name: "extremePortLoadShareGroupId", oid: "1.3.6.1.4.1.1916.1.2.4.1.1.1", access: "read-only", base: "integer" },
          // The one editable column. Mock object-meta for this symbol is in MOCK_SYNTAX below.
          { name: "extremePortPriority", oid: "1.3.6.1.4.1.1916.1.2.4.1.1.5", access: "read-write", base: "integer" },
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

// Lazy-tables refactor: generic table sections now arrive as STUBS (table.lazy === true: columnMeta +
// index present, rows:[]). We fetch a table's rows on demand when the user expands it, then cache the
// loaded table per entry id for the session so re-expanding (or an Advanced-toggle re-render) doesn't
// re-fetch. The loaded table is the SAME shape as a curated/eager table (rows + rowKeys filled, lazy
// absent) so capDataTable renders it — and wires the existing per-cell editor — unchanged.
const loadedTables = new Map(); // entry id -> loaded CapabilityTable (rows + rowKeys, lazy:false)
const expandedTables = new Set(); // entry ids the user has expanded (so re-renders keep them open)

// --- Search/filter helpers -----------------------------------------------------------------------
// A scalar matches the filter if its name, oid, or value contains the (lower-cased) needle.
function scalarMatches(s, needle) {
  if (!needle) return true;
  return [s.name, s.oid, s.value].some((v) => String(v ?? "").toLowerCase().includes(needle));
}
// A table row matches if any cell (or the row's instance key) contains the needle.
function rowMatches(row, key, needle) {
  if (!needle) return true;
  if (key != null && String(key).toLowerCase().includes(needle)) return true;
  return (row || []).some((c) => String(c ?? "").toLowerCase().includes(needle));
}

// Return a filtered shallow copy of a section for the generic-section filter. Curated sections pass
// through untouched. For a generic section we drop non-matching scalars and non-matching table rows
// (keeping rowKeys aligned). A loaded table is filtered too. Returns null if NOTHING in the section
// matches (so renderCapabilities can omit the empty section). The filter never mutates the model.
function filterSection(section, needle) {
  if (!needle || section.kind !== "generic") return section;
  const out = { ...section };
  let any = false;
  if (Array.isArray(section.scalars)) {
    out.scalars = section.scalars.filter((s) => scalarMatches(s, needle));
    if (out.scalars.length) any = true;
  }
  // Filter the table the user actually sees: the loaded one if present, else the section's own.
  const baseTable = loadedTables.get(section.id) || section.table;
  if (baseTable && Array.isArray(baseTable.rows) && baseTable.rows.length) {
    const keys = Array.isArray(baseTable.rowKeys) ? baseTable.rowKeys : null;
    const rows = [];
    const rowKeys = [];
    baseTable.rows.forEach((row, i) => {
      const key = keys ? keys[i] : null;
      if (rowMatches(row, key, needle)) { rows.push(row); if (keys) rowKeys.push(key); }
    });
    if (rows.length) {
      any = true;
      out.table = { ...baseTable, rows, ...(keys ? { rowKeys } : {}) };
      out._filteredTable = true; // mark so renderCapabilities renders this directly (not via the cache)
    }
  } else if (baseTable) {
    // A not-yet-loaded lazy stub: keep it visible so the operator can still load + then filter rows.
    any = true;
  }
  return any ? out : null;
}

// editable: when true (generic section + Advanced mode) each scalar gets an "Edit" affordance whose
// click fetches object-meta and renders the type-aware widget. sectionId namespaces the row ids so
// multiple sections coexist. Read-only objects (per the fetched MibSyntax.access) stay display-only.
function capScalarTable(scalars, editable, sectionId) {
  const rows = (scalars || []).map((s, i) => {
    const v = s.value === null || s.value === undefined || s.value === ""
      ? '<span class="empty">-</span>' : esc(s.value);
    const t = s.type ? ` <span class="empty">(${esc(s.type)})</span>` : "";
    const rid = `${sectionId || "sec"}_${i}`;
    const act = editable
      ? `<td class="act"><button class="editbtn" data-name="${esc(s.name || "")}" data-oid="${esc(s.oid || "")}" data-rid="${esc(rid)}">Edit</button></td>`
      : "";
    // A dedicated row beneath each object holds its inline editor when opened.
    const ed = editable ? `<tr id="objed_${esc(rid)}" style="display:none"><td colspan="3"></td></tr>` : "";
    // Descriptions/units tooltip: the name cell carries the OID as a baseline title and a `tip` hook so
    // the MIB description/units lazy-fetch via object-meta on hover (cached per name; see wireTooltips).
    return `<tr><th class="tip" title="${esc(s.oid || "")}" data-tip-name="${esc(s.name || "")}"` +
      ` data-tip-oid="${esc(s.oid || "")}">${esc(s.name)}</th><td class="val">${v}${t}</td>${act}</tr>${ed}`;
  }).join("");
  return `<table class="kv-table"><tbody>${rows}</tbody></table>`;
}

// Descriptions/units tooltips: cache of fetched MIB meta per symbol/oid so a hover only fetches once.
const tooltipCache = new Map(); // key (name||oid) -> resolved title string ("" if nothing useful)

// Lazy-fetch a tooltip for a `.tip` element on first hover: pull object-meta, build a description/units
// string, cache it, and set it as the element's title. Unobtrusive: until hovered we show only the OID
// baseline title; if no description/units exist, we keep the OID. Read-only — uses the same object-meta
// path the editor uses. Cancelled cheaply if meta is missing (engine still indexing).
async function fetchTooltip(el) {
  const name = el.dataset.tipName || "";
  const oid = el.dataset.tipOid || "";
  const key = name || oid;
  if (!key || el.dataset.tipDone) return;
  el.dataset.tipDone = "1"; // fetch at most once per element regardless of outcome
  if (tooltipCache.has(key)) { applyTooltip(el, tooltipCache.get(key)); return; }
  const syntax = await fetchSyntax(name, oid);
  let tip = "";
  if (syntax) {
    const bits = [];
    if (syntax.description) bits.push(syntax.description);
    if (syntax.units) bits.push("Units: " + syntax.units);
    tip = bits.join("\n");
  }
  tooltipCache.set(key, tip);
  applyTooltip(el, tip);
}
function applyTooltip(el, tip) {
  if (!tip) return; // nothing extra to surface — leave the OID baseline title in place
  const oid = el.dataset.tipOid || "";
  el.title = oid ? `${tip}\n${oid}` : tip; // description/units first, OID for reference underneath
}

// Wire all `.tip` elements in a container to lazy-fetch their MIB description/units on first hover.
function wireTooltips(container) {
  if (!container) return;
  container.querySelectorAll(".tip").forEach((el) => {
    el.addEventListener("mouseenter", () => fetchTooltip(el), { once: false });
  });
}

// Render a generic TABLE section (columns × rows). When `editable` (generic section + Advanced mode)
// and the table carries `columnMeta`/`rowKeys`, every cell in a read-write column gets an inline
// "Edit" affordance; clicking it opens an EXPANDING SUBROW beneath the row (see openCellEditor) that
// reuses the Phase 3 editor + Phase 2 gating. Read-only columns and tables without columnMeta stay
// display-only. sectionId namespaces the subrow ids so multiple table sections coexist.
//
// Why an expanding subrow (not a modal overlay): dense per-port tables stay readable when the editor
// appears in-context right beneath the clicked row, the existing Phase 3 scalar editor already uses
// this exact inline pattern (so we share its editor-body builder verbatim — no duplication), and it
// sidesteps backdrop/focus-trap concerns. Horizontal scroll (.scrollwrap) keeps wide tables usable.
function capDataTable(table, editable, sectionId) {
  const cols = table.columns || [];
  const meta = (editable && Array.isArray(table.columnMeta)) ? table.columnMeta : null;
  const keys = (editable && Array.isArray(table.rowKeys)) ? table.rowKeys : null;
  // Column-header tooltips: when columnMeta is present (independent of `editable`), each header carries
  // the column symbol + OID and a `tip` hook so its MIB description/units lazy-fetch on hover.
  const cmeta = Array.isArray(table.columnMeta) ? table.columnMeta : null;
  const head = cols.map((c, ci) => {
    const cm = cmeta && cmeta[ci];
    if (cm && (cm.name || cm.oid)) {
      return `<th class="tip" title="${esc(cm.oid || "")}" data-tip-name="${esc(cm.name || "")}"` +
        ` data-tip-oid="${esc(cm.oid || "")}">${esc(c)}</th>`;
    }
    return `<th>${esc(c)}</th>`;
  }).join("");

  const body = (table.rows || []).map((row, r) => {
    const rid = `${sectionId || "tbl"}_${r}`;
    const cells = (row || []).map((cell, c) => {
      const disp = (cell === null || cell === undefined || cell === "")
        ? '<span class="empty">-</span>'
        : esc(cell);
      const numCls = typeof cell === "number" ? " num" : "";
      // A cell is editable iff its column is read-write AND we have the instance key for the row.
      const cm = meta && meta[c];
      const canEdit = cm && cm.access === "read-write" && keys && keys[r] != null;
      if (canEdit) {
        // Stash everything openCellEditor needs to stage the setObject on the Edit button.
        return `<td class="${numCls.trim()} celledit">` +
          `<span class="cellval">${disp}</span>` +
          `<button class="editbtn cellbtn" data-rid="${esc(rid)}" data-name="${esc(cm.name || "")}"` +
          ` data-oid="${esc(cm.oid || "")}" data-key="${esc(keys[r])}" data-base="${esc(cm.base || "")}"` +
          ` data-cur="${esc(cell == null ? "" : cell)}">Edit</button></td>`;
      }
      return `<td class="${numCls.trim()}">${disp}</td>`;
    }).join("");
    // A dedicated full-width subrow beneath each row holds the inline cell editor when opened.
    const ed = (meta && keys)
      ? `<tr id="celled_${esc(rid)}" class="celledrow" style="display:none"><td colspan="${cols.length}"></td></tr>`
      : "";
    return `<tr>${cells}</tr>${ed}`;
  }).join("");

  return `<div class="scrollwrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

// Lazy-tables refactor: decide how to render a section's `table`.
//  - Non-lazy (curated, or already-loaded) tables render exactly as before via capDataTable.
//  - A STUB (table.lazy === true) whose rows we have NOT loaded renders just its header (column names)
//    + the index note + a "Load rows" affordance; clicking it fetches the rows on demand (loadTableRows).
//  - Once loaded (cached in loadedTables), the section renders the populated table via capDataTable —
//    same code path as a curated table, so read-write cells get the EXISTING per-cell editor unchanged.
// `editable`/`sectionId` are threaded straight through to capDataTable (cell editor wiring is identical).
function capTableSection(section, editable, sectionId) {
  const t = section.table || {};
  // Search/filter: filterSection() may have already substituted a filtered `table` into the section
  // (marked _filteredTable). Render that directly — don't fall back to the unfiltered loaded-table cache.
  if (section._filteredTable) return capDataTable(t, editable, sectionId);
  // A loaded table (cache hit) takes the place of the stub: render its rows like any other table.
  const cached = loadedTables.get(section.id);
  if (cached) return capDataTable(cached, editable, sectionId);
  // Non-lazy tables (curated / generic eager) render as today.
  if (!t.lazy) return capDataTable(t, editable, sectionId);

  // Lazy stub, not yet loaded: header + index note + Load button. The header lists the columns so the
  // operator sees the table's shape before paying for the SNMP walk. data-entry carries the section id
  // for the on-demand fetch; data-sec/data-editable let the click handler re-render this section.
  const cols = t.columns || [];
  const head = cols.map((c) => `<th>${esc(c)}</th>`).join("");
  const note = t.index ? `<span class="empty"> · index: ${esc(t.index)}</span>` : "";
  const colspan = Math.max(cols.length, 1);
  return `<div class="scrollwrap"><table><thead><tr>${head}</tr></thead><tbody>` +
    `<tr id="lazyrow_${esc(sectionId)}"><td colspan="${colspan}" class="lazyload">` +
    `<button class="loadrows" data-entry="${esc(section.id)}" data-sec="${esc(sectionId)}"` +
    ` data-editable="${editable ? "1" : ""}">Load rows</button>` +
    `<span class="empty"> rows not loaded yet${note}</span>` +
    `</td></tr></tbody></table></div>`;
}

// Fetch one lazy table's rows on demand, cache them for the session, and re-render the Details panel so
// the (now non-lazy) table renders through capDataTable — wiring the EXISTING per-cell editor. Shows an
// inline loading state on the row while the SNMP walk runs. Cache hit (loadedTables) short-circuits the
// fetch on re-expand. On failure the row shows the error and the Load button stays available to retry.
async function loadTableRows(entry, sectionId, editable, cell) {
  if (loadedTables.has(entry)) { expandedTables.add(entry); renderCapabilities(lastCaps); return; }
  if (cell) cell.innerHTML = '<span class="empty">loading rows…</span>';
  const host = (lastCaps && lastCaps.host) || $("host").value.trim();
  let res;
  try {
    res = await window.switchkeeper.tableRows({ host, cred: getCred(), entry });
  } catch (e) {
    res = { ok: false, error: String((e && e.message) || e) };
  }
  // data:null means the MIB store is still indexing (server returns {ok:true,data:null}); let the user retry.
  const section = res && res.ok ? (res.data || null) : null;
  const table = section && section.table;
  if (!table) {
    const why = res && res.ok ? "table not loaded (MIBs may still be indexing — try again)" : ("load error: " + ((res && res.error) || "no result"));
    if (cell) {
      cell.innerHTML = `<button class="loadrows" data-entry="${esc(entry)}" data-sec="${esc(sectionId)}"` +
        ` data-editable="${editable ? "1" : ""}">Load rows</button> <span class="bad">${esc(why)}</span>`;
      const b = cell.querySelector(".loadrows");
      if (b) b.addEventListener("click", () => loadTableRows(b.dataset.entry, b.dataset.sec, !!b.dataset.editable, cell.closest("td")));
    }
    return;
  }
  loadedTables.set(entry, table); // session cache: re-expanding won't re-fetch
  expandedTables.add(entry);
  renderCapabilities(lastCaps); // re-render: the loaded table now flows through capDataTable + the cell editor
}

function renderCapabilities(model) {
  lastCaps = model;
  const panel = $("capabilities");
  const sections = model.sections || [];
  const generic = sections.filter((s) => s.kind === "generic");
  // Curated sections always render; generic ones only when Advanced mode is on.
  const candidates = sections.filter((s) => s.kind !== "generic" || advancedMode);
  // Search/filter: apply the (generic-section-only) filter; filterSection returns null for a generic
  // section with no match (it's dropped). Curated sections always pass through unfiltered.
  const needle = capFilter.trim().toLowerCase();
  const visible = candidates.map((s) => filterSection(s, needle)).filter(Boolean);
  const filteredOut = needle ? (candidates.filter((s) => s.kind === "generic").length -
    visible.filter((s) => s.kind === "generic").length) : 0;

  const sectionHtml = visible.map((s, si) => {
    const gtag = s.kind === "generic" ? ` <span class="gtag">generic</span>` : "";
    // Per the contract, the "Edit" affordance appears ONLY in generic sections AND only when
    // Advanced mode is on. Curated sections stay display-only.
    const editable = s.kind === "generic" && advancedMode;
    let inner = "";
    if (s.scalars && s.scalars.length) inner += capScalarTable(s.scalars, editable, "s" + si);
    if (s.table) inner += capTableSection(s, editable, "t" + si);
    if (!inner) inner = '<p class="empty">no values reported</p>';
    return `<div class="capsection"><h2>${esc(s.title)}${gtag}</h2>${inner}</div>`;
  }).join("");

  const advClass = advancedMode ? "advtoggle on" : "advtoggle";
  const hiddenNote = (!advancedMode && generic.length)
    ? `<span class="sum">${generic.length} vendor section${generic.length === 1 ? "" : "s"} hidden</span>` : "";
  const filterNote = (needle && filteredOut > 0)
    ? `<span class="sum">${filteredOut} section${filteredOut === 1 ? "" : "s"} filtered out</span>` : "";
  const mibs = model.mibs || { loaded: 0, indexed: 0 };

  panel.innerHTML =
    `<div class="capbar">
       <span class="sum">vendor <b>${esc(model.vendor || "Unknown")}</b></span>
       <span class="sum">MIBs loaded <b>${esc(mibs.loaded ?? 0)}</b> · indexed <b>${esc(mibs.indexed ?? 0)}</b></span>
       ${hiddenNote}
       ${filterNote}
       <span class="spacer"></span>
       <input id="capFilter" class="capfilter" type="search" placeholder="filter objects (name / oid / value)"
         value="${esc(capFilter)}" title="Filter the generic vendor sections by name, OID, or value (Advanced mode)">
       <button id="capExport" class="linkbtn" title="Download the current capability model (curated + scalars + loaded tables) as JSON">Export</button>
       <label class="${advClass}" title="Show generic vendor objects exposed by the device's MIBs (read-only)">
         <input type="checkbox" id="advChk" ${advancedMode ? "checked" : ""}> Advanced mode
       </label>
     </div>` +
    (advancedMode ? `<div class="advbanner">Advanced mode ON — showing all generic vendor objects the MIBs expose (read-only).</div>` : "") +
    (sections.length ? sectionHtml : `<p class="empty" style="margin-top:14px">No capability sections${mibs.loaded ? "" : " (no MIBs loaded — import the device's MIBs to see vendor objects)"}.</p>`) +
    (needle && !visible.some((s) => s.kind === "generic") && generic.length
      ? `<p class="empty" style="margin-top:14px">No generic objects match “${esc(capFilter)}”.</p>` : "");

  const chk = $("advChk");
  if (chk) chk.addEventListener("change", () => {
    advancedMode = chk.checked;
    renderCapabilities(lastCaps);
    // Keep the safety review's gating in sync if a review/apply bar is open (shared toggle).
    if (lastPlanSafety || lastApply) renderPending();
  });

  // Search/filter: re-render on input. Preserve caret/focus by re-focusing the box after re-render
  // (renderCapabilities rebuilds the panel HTML each keystroke; the input is cheap to re-focus).
  const flt = $("capFilter");
  if (flt) flt.addEventListener("input", () => {
    capFilter = flt.value;
    const caret = flt.selectionStart;
    renderCapabilities(lastCaps);
    const again = $("capFilter");
    if (again) { again.focus(); try { again.setSelectionRange(caret, caret); } catch (e) { /* search inputs may reject */ } }
  });

  // Snapshot / export button.
  const exp = $("capExport");
  if (exp) exp.addEventListener("click", exportSnapshot);

  // Descriptions/units tooltips: wire all .tip elements (scalar names + table headers) to lazy-fetch.
  wireTooltips(panel);

  // Phase 3: wire each generic SCALAR "Edit" button to open its type-aware editor.
  panel.querySelectorAll("button.editbtn:not(.cellbtn)").forEach((btn) => {
    btn.addEventListener("click", () => openObjectEditor(btn.dataset.name, btn.dataset.oid, btn.dataset.rid, btn));
  });
  // Phase 4: wire each TABLE-CELL "Edit" button to open its inline cell editor (subrow).
  panel.querySelectorAll("button.cellbtn").forEach((btn) => {
    btn.addEventListener("click", () => openCellEditor(btn, btn.dataset));
  });
  // Lazy-tables refactor: wire each lazy table's "Load rows" button to fetch its rows on demand.
  panel.querySelectorAll("button.loadrows").forEach((btn) => {
    btn.addEventListener("click", () =>
      loadTableRows(btn.dataset.entry, btn.dataset.sec, !!btn.dataset.editable, btn.closest("td")));
  });
}

// ====================================================================================
// Phase 3: type-aware object editor. Clicking "Edit" on a generic read-write object fetches its
// MIB SYNTAX (object-meta) and renders the matching widget; "Review" stages a setObject edit and
// runs the EXISTING plan -> Phase 2 gating -> apply flow (it is never auto-applied). The scalar's
// instance OID is the displayed base OID with ".0" appended (scalar leaves are single-instance).
// ====================================================================================

// --- INTEGRATION FLAG ----------------------------------------------------------------
// While the engine's describeObject() lands in parallel, set this true to resolve object-meta from
// MOCK_SYNTAX (an enum, a ranged integer, a string) so the editor widgets can be exercised without
// a live MIB store. SHIPPED DEFAULT IS false — use the real /api/object-meta (switch:object-meta).
const OBJMETA_USE_MOCK = false;
// -------------------------------------------------------------------------------------

// Mock MibSyntax fixtures keyed by the object's symbol: one enum, one ranged integer, one string.
// Matches the contract shape { base, snmpType?, enums?, range?, sizeRange?, units?, description?, access? }.
const MOCK_SYNTAX = {
  // enum -> <select>
  ngFanState: {
    base: "enum", snmpType: 2, access: "read-write",
    enums: [{ label: "auto", value: 1 }, { label: "low", value: 2 }, { label: "high", value: 3 }],
    description: "Desired fan-tray operating mode.",
  },
  // ranged integer -> bounded number input
  ngTemperatureThreshold: {
    base: "integer", snmpType: 2, access: "read-write",
    range: { min: 0, max: 120 }, units: "degrees Celsius",
    description: "Over-temperature alarm threshold.",
  },
  // string -> text input with maxlength from sizeRange
  ngSystemContact: {
    base: "string", snmpType: 4, access: "read-write",
    sizeRange: { min: 0, max: 32 },
    description: "Free-text administrative contact for this device.",
  },
  // Phase 4 fixture: the editable TABLE COLUMN's syntax (object-meta keys on the column symbol).
  extremePortPriority: {
    base: "integer", snmpType: 2, access: "read-write",
    range: { min: 0, max: 255 },
    description: "Per-port transmit priority (0–255). Set per row (ifIndex).",
  },
};

// The object currently being edited inline: { name, oid (instance), syntax, rid }. Only one editor
// is open at a time (a fresh openObjectEditor / openCellEditor closes any previous one). Phase 4
// cell editors live in `celled_<rid>` subrows; Phase 3 scalar editors in `objed_<rid>` rows — both
// share `openEditor`, the editor-body builder, the value read, and the stage->review handoff below.
let openEditor = null;

// The scalar's single instance OID. The capability model shows base scalar OIDs (no instance), so
// append ".0" unless the caller already supplied an instance (ends in ".<n>" beyond the base).
function instanceOidFor(oid) {
  const s = String(oid || "");
  if (!s) return s;
  return /\.0$/.test(s) ? s : s + ".0";
}

async function fetchSyntax(name, oid) {
  if (OBJMETA_USE_MOCK) return MOCK_SYNTAX[name] || null; // UI-dev path; flip OBJMETA_USE_MOCK above
  try {
    const res = await window.switchkeeper.objectMeta({ name: name || undefined, oid: oid || undefined });
    return res && res.ok ? (res.data || null) : null;
  } catch (e) { return null; }
}

// Build the input widget HTML for a MibSyntax. Returns { html, kind } where kind drives value reads.
function editorWidget(syntax, currentValue) {
  const base = (syntax && syntax.base) || "unknown";
  if (base === "enum" || base === "boolean") {
    const enums = (syntax.enums && syntax.enums.length)
      ? syntax.enums
      : (base === "boolean" ? [{ label: "true", value: 1 }, { label: "false", value: 2 }] : []);
    if (enums.length) {
      const opts = enums.map((e) =>
        `<option value="${esc(e.value)}">${esc(e.label)} (${esc(e.value)})</option>`).join("");
      return { html: `<select id="objval">${opts}</select>`, kind: "enum" };
    }
    // No enum list available — fall back to a free number input.
    return { html: `<input type="number" id="objval" value="${esc(currentValue ?? "")}">`, kind: "number" };
  }
  if (base === "integer" || base === "unsigned" || base === "counter" || base === "timeticks") {
    const r = syntax.range || {};
    const lo = base === "unsigned" && r.min == null ? 0 : r.min;
    const min = lo != null ? ` min="${esc(lo)}"` : "";
    const max = r.max != null ? ` max="${esc(r.max)}"` : "";
    const step = ' step="1"';
    return { html: `<input type="number" id="objval"${min}${max}${step} value="${esc(currentValue ?? "")}">`, kind: "number" };
  }
  // BITS: a SET in SNMP is an OCTET STRING where each named bit occupies a fixed bit position
  // (enums[].value = bit position, 0-based, per the cross-cutting contract). Render one checkbox
  // per named bit so the operator toggles named flags rather than hand-editing a hex string; on
  // Review we encode the chosen positions back to the octet-string value (see readEditorValue).
  if (base === "bits") {
    const enums = (syntax.enums && syntax.enums.length) ? syntax.enums : [];
    if (enums.length) {
      // Pre-tick boxes whose bit is set in the current value (decoded from the displayed hex string).
      const setNow = decodeBitsValue(currentValue);
      const boxes = enums.map((e) => {
        const pos = Number(e.value);
        const on = setNow.has(pos) ? " checked" : "";
        return `<label class="bitbox"><input type="checkbox" class="bitchk" data-pos="${esc(pos)}"${on}> ` +
          `${esc(e.label)} <span class="empty">(${esc(pos)})</span></label>`;
      }).join("");
      return { html: `<span id="objval" class="bitgroup">${boxes}</span>`, kind: "bits" };
    }
    // No named bits available — fall back to free text (operator can type the hex octet string).
    return { html: `<input type="text" id="objval" value="${esc(currentValue ?? "")}">`, kind: "text" };
  }
  // string / oid / ipaddress / bits / unknown -> text input (sizeRange caps OCTET STRING length).
  const sz = syntax.sizeRange || {};
  const ml = sz.max != null ? ` maxlength="${esc(sz.max)}"` : "";
  return { html: `<input type="text" id="objval"${ml} value="${esc(currentValue ?? "")}">`, kind: "text" };
}

// Read the editor's current value, coerced for the widget kind (number for enum/number, else string).
function readEditorValue(kind) {
  const el = $("objval");
  if (!el) return undefined;
  if (kind === "enum" || kind === "number") {
    const n = Number(el.value);
    return Number.isFinite(n) ? n : el.value; // leave non-numeric as-is; engine validates defensively
  }
  if (kind === "bits") {
    // Gather the ticked bit positions and encode them into the SNMP OCTET STRING value (see encodeBits).
    const positions = [...el.querySelectorAll("input.bitchk:checked")].map((c) => Number(c.dataset.pos));
    return encodeBits(positions);
  }
  return el.value;
}

// Encode a set of named-bit POSITIONS into the SNMP BITS octet string per the cross-cutting contract:
// big-endian bit string — position p lives in byte (p >> 3), mask (0x80 >> (p & 7)). The result is the
// hex string the engine's setObject/coerceSetValue expects for a resolved base of "bits". An empty
// selection still yields a (minimal) zero-length-ish string of "00" so the varbind clears all bits.
function encodeBits(positions) {
  if (!positions.length) return "00"; // no bits set: one zero byte (engine builds an OctetString)
  const maxPos = Math.max(...positions);
  const bytes = new Array((maxPos >> 3) + 1).fill(0);
  for (const p of positions) bytes[p >> 3] |= 0x80 >> (p & 7);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Decode a displayed BITS octet string (hex, with or without separators) back to the set of positions
// that are set, so the checkbox group can pre-tick the current state. Tolerant of "0x" prefixes and
// ":"/" " separators; anything unparseable yields an empty set (operator just starts from cleared).
function decodeBitsValue(value) {
  const set = new Set();
  if (value == null) return set;
  const hex = String(value).trim().replace(/^0x/i, "").replace(/[\s:]/g, "");
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) return set;
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    const base = (i / 2) * 8;
    for (let bit = 0; bit < 8; bit++) if (byte & (0x80 >> bit)) set.add(base + bit);
  }
  return set;
}

async function openObjectEditor(name, oid, rid, btn) {
  const host = (lastCaps && lastCaps.host) || $("host").value.trim();
  const row = $("objed_" + rid);
  if (!row) return;
  // Toggle: clicking Edit again on the open one closes it.
  if (openEditor && openEditor.rid === rid && row.style.display !== "none") {
    closeObjectEditor();
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  const syntax = await fetchSyntax(name, oid);
  if (btn) { btn.disabled = false; btn.textContent = "Edit"; }

  const instanceOid = instanceOidFor(oid);
  // Current value (for prefilling the widget) from the model row.
  const cur = currentScalarValue(name, oid);

  // Read-only / unresolved objects stay display-only (per contract). If meta is null we still allow
  // a free-text edit only when the model itself marked it editable — but the model doesn't carry
  // per-scalar access, so without meta we treat it as read-only to fail safe.
  if (!syntax) {
    row.style.display = "";
    row.querySelector("td").innerHTML = editorReadonlyHtml(name || instanceOid, instanceOid,
      "No MIB SYNTAX available (import this object's MIB to edit it). Read-only.");
    $("objClose").addEventListener("click", closeObjectEditor);
    openEditor = { rid };
    return;
  }
  if (syntax.access && syntax.access !== "read-write") {
    row.style.display = "";
    row.querySelector("td").innerHTML = editorReadonlyHtml(name || instanceOid, instanceOid,
      `This object is ${syntax.access} — display only.`, syntax);
    $("objClose").addEventListener("click", closeObjectEditor);
    openEditor = { rid };
    return;
  }

  const w = editorWidget(syntax, cur);
  row.style.display = "";
  row.querySelector("td").innerHTML = editorBodyHtml(name || instanceOid, instanceOid, syntax, cur, w);
  openEditor = { rid, name, oid: instanceOid, syntax, kind: w.kind };
  $("objCancel").addEventListener("click", closeObjectEditor);
  $("objReview").addEventListener("click", reviewObjectEdit);
}

// Shared editor-body HTML for BOTH the Phase 3 scalar editor and the Phase 4 cell editor: the object
// name + instance OID, the type-aware widget, units/range/TC/description helper lines, and the
// Cancel/Review buttons (ids objCancel/objReview, wired by the caller). `currentValue` is shown as
// the cell's/scalar's current value so the operator sees what they are changing from.
function editorBodyHtml(displayName, instanceOid, syntax, currentValue, w) {
  const units = syntax.units ? ` <b>${esc(syntax.units)}</b>` : "";
  const help = [];
  if (syntax.units) help.push(`Units:${units}`);
  if (syntax.range) help.push(`Range: ${esc(syntax.range.min)}–${esc(syntax.range.max)}`);
  if (syntax.sizeRange) help.push(`Length: ${esc(syntax.sizeRange.min)}–${esc(syntax.sizeRange.max)} chars`);
  if (syntax.tc) help.push(`TC: ${esc(syntax.tc)}`);
  const helpLine = help.length ? `<div class="ehelp">${help.join(" · ")}</div>` : "";
  const descLine = syntax.description ? `<div class="ehelp">${esc(syntax.description)}</div>` : "";
  const curLine = (currentValue !== undefined && currentValue !== "")
    ? `<div class="ehelp">Current: <b>${esc(currentValue)}</b></div>` : "";
  return `<div class="objeditor">
       <div class="erow">
         <span class="ename">${esc(displayName)} <span class="mono">${esc(instanceOid)}</span></span>
         ${w.html}
         <span class="spacer"></span>
         <button class="editbtn" id="objCancel">Cancel</button>
         <button id="objReview">Review</button>
       </div>
       ${curLine}${descLine}${helpLine}
     </div>`;
}

// Shared "read-only / no-syntax" editor-body HTML (object can't be edited): name + a note + Close.
function editorReadonlyHtml(displayName, instanceOid, note, syntax) {
  const desc = (syntax && syntax.description) ? `<div class="ehelp">${esc(syntax.description)}</div>` : "";
  return `<div class="objeditor"><div class="ename">${esc(displayName)} <span class="mono">${esc(instanceOid)}</span></div>` +
    `<div class="ero">${esc(note)}</div>${desc}` +
    `<div class="erow" style="margin-top:8px"><span class="spacer"></span><button class="editbtn" id="objClose">Close</button></div></div>`;
}

// The displayed value of a scalar from the model, used to prefill the editor.
function currentScalarValue(name, oid) {
  for (const s of (lastCaps?.sections || [])) {
    for (const sc of (s.scalars || [])) {
      if ((name && sc.name === name) || (oid && sc.oid === oid)) {
        return sc.value == null ? "" : sc.value;
      }
    }
  }
  return "";
}

// Close whichever inline editor is open. Phase 3 scalar editors live in `objed_<rid>`; Phase 4 cell
// editors in `celled_<rid>`. openEditor.rowId holds the exact DOM id so one close path serves both.
function closeObjectEditor() {
  if (openEditor) {
    const id = openEditor.rowId || (openEditor.rid ? "objed_" + openEditor.rid : null);
    const row = id ? $(id) : null;
    if (row) { row.style.display = "none"; const td = row.querySelector("td"); if (td) td.innerHTML = ""; }
  }
  openEditor = null;
}

// "Review": stage the setObject edit and hand off to the EXISTING plan -> Phase 2 gating -> apply
// path (reviewPending). Never auto-applies — the SafetyEngine will classify the write risky/blocked
// and the gating UI requires the matching acknowledgement before Apply enables.
function reviewObjectEdit() {
  if (!openEditor || !openEditor.oid) return;
  const value = readEditorValue(openEditor.kind);
  if (value === undefined || value === "") { setStatus("enter a value to set", "error"); return; }
  // Single staging shape for BOTH scalar and cell writes: { kind:"setObject", oid, value, snmpType?,
  // name? }. collectEdits() folds pendingSetObject into the engine Edit[] that plan/apply consume,
  // so cell writes reuse the exact Phase 2 gating + Phase 3 apply path — no duplicate classify logic.
  pendingSetObject = {
    oid: openEditor.oid,
    value,
    snmpType: openEditor.syntax && openEditor.syntax.snmpType,
    name: openEditor.name || undefined,
  };
  closeObjectEditor();
  renderPending();   // show the pending bar with the staged object write
  reviewPending();   // run the dry-run plan -> safety classification -> gating UI
}

// ====================================================================================
// Phase 4: inline TABLE-CELL editor (expanding subrow). Mirrors the Phase 3 scalar editor but the
// instance OID is built from the COLUMN base OID + the row's instance suffix:
//   oid  = columnMeta[c].oid + "." + rowKeys[r]   (the cell's fully-qualified instance OID)
//   name = columnMeta[c].name + "." + rowKeys[r]  (symbol.instance, for display/audit)
// It fetches object-meta by the column symbol, renders the SAME type-aware widget, and on "Review"
// stages that setObject and runs the EXISTING plan -> Phase 2 gating -> apply (reviewObjectEdit).
// The engine's row decoder maps the row back to a port/VLAN, so a cell targeting the management
// row classifies blocked; otherwise risky. Nothing auto-applies. Reuses editorBodyHtml/readEditorValue.
// ====================================================================================
async function openCellEditor(btn, ds) {
  const rid = ds.rid;
  const row = $("celled_" + rid);
  if (!row) return;
  // Toggle: clicking Edit again on the open cell closes it.
  if (openEditor && openEditor.rowId === "celled_" + rid && row.style.display !== "none") {
    closeObjectEditor();
    return;
  }
  closeObjectEditor(); // close any other open editor first (only one at a time)

  const colName = ds.name || "";
  const colOid = ds.oid || "";
  const key = ds.key;
  const cur = ds.cur != null ? ds.cur : "";
  // Build the cell's instance identity per the Phase 4 contract.
  const instanceOid = colOid && key != null ? `${colOid}.${key}` : colOid;
  const instanceName = colName ? `${colName}.${key}` : instanceOid;

  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  // Resolve units/range/enums/description from the COLUMN symbol (object-meta keys on the symbol).
  const syntax = await fetchSyntax(colName, colOid);
  if (btn) { btn.disabled = false; btn.textContent = "Edit"; }

  const td = row.querySelector("td");
  // No SYNTAX → can't safely build an editor. Fall back to display-only (fail safe). Still show the
  // column's base hint so an operator knows what's needed (import the column's MIB).
  if (!syntax) {
    row.style.display = "";
    td.innerHTML = editorReadonlyHtml(instanceName, instanceOid,
      "No MIB SYNTAX available for this column (import its MIB to edit it). Read-only.");
    $("objClose").addEventListener("click", closeObjectEditor);
    openEditor = { rowId: "celled_" + rid };
    return;
  }
  // Defensive: the cell should already be in a read-write column, but honour object-meta's access too.
  if (syntax.access && syntax.access !== "read-write") {
    row.style.display = "";
    td.innerHTML = editorReadonlyHtml(instanceName, instanceOid,
      `This column is ${syntax.access} — display only.`, syntax);
    $("objClose").addEventListener("click", closeObjectEditor);
    openEditor = { rowId: "celled_" + rid };
    return;
  }

  const w = editorWidget(syntax, cur);
  row.style.display = "";
  td.innerHTML = editorBodyHtml(instanceName, instanceOid, syntax, cur, w);
  // openEditor carries the instance oid/name so reviewObjectEdit stages the right setObject.
  openEditor = { rowId: "celled_" + rid, name: instanceName, oid: instanceOid, syntax, kind: w.kind };
  $("objCancel").addEventListener("click", closeObjectEditor);
  $("objReview").addEventListener("click", reviewObjectEdit);
}

async function loadCapabilities() {
  const panel = $("capabilities");
  if (panel.style.display === "block") { panel.style.display = "none"; return; } // toggle off
  // Fresh capability read: drop any rows loaded for a previous read/device so we don't show stale rows
  // against a newly-fetched stub list. Tables reload on demand against the new model.
  loadedTables.clear();
  expandedTables.clear();
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
$("histBtn").addEventListener("click", toggleHistory);
$("discoverBtn").addEventListener("click", openDiscover);
$("saveBtn").addEventListener("click", saveConfig);
$("version").addEventListener("change", toggleVersion);
$("host").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
$("community").addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });

// Restore remembered credentials/host (and wire host-change prefill). Done last so all
// referenced elements + helpers (toggleVersion, getCred) are defined.
initCredCache();
