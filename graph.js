"use strict";
const api = typeof browser !== "undefined" ? browser : chrome;

const canvas = document.getElementById("c");
const ctx = canvas.getContext("2d");
const qInput = document.getElementById("q");
const sectionSel = document.getElementById("section");
const showLinksBox = document.getElementById("showLinks");
const stats = document.getElementById("stats");
const spreadInput = document.getElementById("spread");
const themeBtn = document.getElementById("theme");
const spreadVal = document.getElementById("spreadVal");
const showRootBox = document.getElementById("showRoot");

const THEMES = {
  dark:  { edge: "150,158,170", halo: "rgba(22,24,29,.85)",   fold: "#eceef2", book: "#b9bec8", root: "#e8eaed", ring: "#fff",    share: "#fff" },
  light: { edge: "90,98,112",   halo: "rgba(246,247,249,.9)", fold: "#14161a", book: "#4a505c", root: "#2b2f36", ring: "#14161a", share: "#14161a" },
};
// layout sliders: value x, multiplier = 2^x (same log scale as sparseness)
const PARAMS = [
  { key: "folderDist", label: "Folder distance",            hint: "edge length folder → subfolder" },
  { key: "linkLen",    label: "Link length",                hint: "distance link → its folder" },
  { key: "folderRep",  label: "Folder repulsion",            hint: "folders push each other apart, links do not" },
  { key: "sizeRep",    label: "Big-folder weight",           hint: "more links in a folder, stronger repulsion" },
  { key: "sectionSep", label: "Section separation",          hint: "top-level sections move away from each other" },
  { key: "gravity",    label: "Pull to center",               hint: "squeezes or stretches the whole graph" },
  { key: "stiff",      label: "Edge stiffness",              hint: "how strictly edges keep their length" },
];
const pv = Object.fromEntries(PARAMS.map(p => [p.key, 0]));   // slider positions
const pm = Object.fromEntries(PARAMS.map(p => [p.key, 1]));   // multipliers
try { Object.assign(pv, JSON.parse(localStorage.getItem("bg-params") || "{}")); } catch {}
for (const k in pv) pm[k] = Math.pow(2, pv[k] = Number(pv[k]) || 0);

let theme = "light";
let showRoot = true;
let gravityBoost = 1;   // without the root node, components are held together by gravity only
let spreadLog = 0;      // slider position: spread = 2^spreadLog
let spread = 1;
try { theme = localStorage.getItem("bg-theme") === "dark" ? "dark" : "light"; spreadLog = parseFloat(localStorage.getItem("bg-spread-log")) || 0; showRoot = localStorage.getItem("bg-root") !== "0"; } catch {}
spread = Math.pow(2, spreadLog);
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === "dark" ? "☾ Dark" : "☀︎ Light";
  dirty = true;
}
const tip = document.getElementById("tip");

let W = 0, H = 0, DPR = window.devicePixelRatio || 1;
const view = { k: 1, x: 0, y: 0 };

let model = null;            // full graph: { nodes: Map, links: [] }
let nodes = [], links = [];  // current subset (after section filter)
let order = [];              // node indices ordered by label priority
let neighbors = [];          // neighbors[i] = Set of indices
let alpha = 1, dirty = true, autoFit = true;
let hover = -1, selected = -1, matches = null;
let groupColor = new Map();

// ---------- build the model from the bookmark tree ----------

function buildModel(tree) {
  const map = new Map();
  const rawLinks = [];
  const linkSet = new Set();
  const root = mk("root", "root", "Bookmarks");
  map.set("root", root);

  function mk(id, type, label, url) {
    return { id, type, label, url, groups: new Set(), x: 0, y: 0, vx: 0, vy: 0, size: 0, deg: 0 };
  }
  function link(a, b, L) {
    const k = a + ">" + b;
    if (linkSet.has(k)) return;
    linkSet.add(k);
    rawLinks.push({ a, b, L });
  }

  // parentId — hub node, group — top-level section name (null at root level)
  function walk(folder, parentId, group) {
    for (const c of folder.children || []) {
      if (c.type === "separator") continue;
      if (c.children) {
        if (!c.title) { walk(c, parentId, group); continue; }          // unnamed folders are flattened
        const g = group ?? c.title;
        const id = "f:" + c.id;
        let n = map.get(id);
        if (!n) { n = mk(id, "folder", c.title); map.set(id, n); }
        n.groups.add(g);
        link(parentId, id, parentId === "root" ? 130 : 70);
        walk(c, id, g);
      } else if (c.url && !c.url.startsWith("place:")) {
        const g = group ?? "(no folder)";
        const id = "u:" + c.url;
        let n = map.get(id);
        if (!n) { n = mk(id, "bookmark", c.title || hostOf(c.url), c.url); map.set(id, n); }
        n.groups.add(g);
        link(parentId, id, 38);
      }
    }
  }
  // built-in roots (Menu, Toolbar, Other, Mobile) are not shown — only their contents
  for (const r of tree[0].children || []) walk(r, "root", null);

  // folder sizes: number of bookmarks in the subtree
  const kids = new Map();
  for (const l of rawLinks) {
    if (!kids.has(l.a)) kids.set(l.a, []);
    kids.get(l.a).push(l.b);
  }
  const memo = new Map();
  const count = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const n = map.get(id);
    if (n.type === "bookmark") return 1;
    let s = 0;
    for (const k of kids.get(id) || []) s += count(k);
    memo.set(id, s);
    return s;
  };
  for (const n of map.values()) {
    n.size = count(n.id);
    n.r = n.type === "root" ? 14 : n.type === "folder" ? Math.min(5 + Math.sqrt(n.size) * 1.1, 22) : 3.2;
    n.charge = n.type === "root" ? 10 : n.type === "folder" ? 2 + Math.sqrt(n.size) * 0.5 : 1;
  }
  return { nodes: map, links: rawLinks };
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }

// ---------- section filter / rebuild working arrays ----------

function applyFilter() {
  const g = sectionSel.value;
  const all = [...model.nodes.values()];
  const sel = g ? all.filter(n => n.type !== "root" && n.groups.has(g)) : all.filter(n => showRoot || n.type !== "root");
  const idx = new Map(sel.map((n, i) => [n.id, i]));
  nodes = sel;
  gravityBoost = !g && !showRoot ? 4 : 1;
  links = [];
  for (const l of model.links) {
    const s = idx.get(l.a), t = idx.get(l.b);
    if (s !== undefined && t !== undefined) links.push({ s, t, L: l.L, bm: nodes[t].type === "bookmark" });
  }
  neighbors = nodes.map(() => new Set());
  for (const l of links) { neighbors[l.s].add(l.t); neighbors[l.t].add(l.s); }
  nodes.forEach((n, i) => { n.deg = neighbors[i].size; });
  order = nodes.map((_, i) => i).sort((a, b) => {
    const A = nodes[a], B = nodes[b];
    const ta = A.type === "bookmark" ? 1 : 0, tb = B.type === "bookmark" ? 1 : 0;
    return ta - tb || (B.size - A.size) || (B.deg - A.deg);
  });
  hover = selected = -1;
  matches = null;
  runSearch();
  alpha = 1; autoFit = true; dirty = true;
  stats.textContent = `${nodes.filter(n => n.type === "folder").length} folders · ${nodes.filter(n => n.type === "bookmark").length} links`;
}

function colorFor(n) {
  const g = n.groups.values().next().value;
  return groupColor.get(g) || "#888";
}

function refreshSections(selectedValue) {
  const names = [];
  for (const l of model.links) {
    if (l.a === "root") {
      const n = model.nodes.get(l.b);
      if (n.type === "folder" && !names.includes(n.label)) names.push(n.label);
      else if (n.type === "bookmark" && !names.includes("(no folder)")) names.push("(no folder)");
    }
  }
  groupColor = new Map(names.map((nm, i) => [nm, `hsl(${(i * 137.5) % 360} 65% 62%)`]));
  const opts = [["", "All sections"], ...names.map(nm => [nm, nm])].map(([v, t]) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = t;
    return o;
  });
  sectionSel.replaceChildren(...opts);
  if (names.includes(selectedValue)) sectionSel.value = selectedValue;
}

// ---------- loading and live updates ----------

async function load(first) {
  const tree = await api.bookmarks.getTree();
  const old = model ? model.nodes : null;
  model = buildModel(tree);
  const nodeCount = model.nodes.size;
  // positions: keep old ones, seed new nodes along a spiral
  const R = Math.sqrt(nodeCount) * 12;
  let i = 0;
  for (const n of model.nodes.values()) {
    const o = old && old.get(n.id);
    if (o) { n.x = o.x; n.y = o.y; }
    else {
      const a = i * 2.399963, r = R * Math.sqrt((i + 1) / nodeCount);
      n.x = Math.cos(a) * r; n.y = Math.sin(a) * r;
    }
    i++;
  }
  const prev = sectionSel.value;
  refreshSections(prev);
  applyFilter();
  if (!first) { autoFit = false; alpha = 0.4; }
}

let reloadTimer = 0;
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => load(false), 500); }
for (const ev of ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered"]) {
  if (api.bookmarks[ev]) api.bookmarks[ev].addListener(scheduleReload);
}

// ---------- physics (Barnes–Hut) ----------

function newCell(x, y, s) { return { x, y, s, leaf: true, p: null, kids: null, m: 0, cx: 0, cy: 0 }; }

function insert(c, n, depth) {
  if (c.leaf && c.p === null) { c.p = n; return; }
  if (c.leaf) {
    const old = c.p;
    if (depth > 40 || (old.x === n.x && old.y === n.y)) { n.x += Math.random() * 0.02; n.y += Math.random() * 0.02; }
    c.p = null; c.leaf = false; c.kids = [null, null, null, null];
    put(c, old, depth);
  }
  put(c, n, depth);
}
function put(c, n, depth) {
  const h = c.s / 2;
  const qx = n.x >= c.x + h ? 1 : 0, qy = n.y >= c.y + h ? 1 : 0, q = qx + qy * 2;
  let k = c.kids[q];
  if (!k) k = c.kids[q] = newCell(c.x + qx * h, c.y + qy * h, h);
  insert(k, n, depth + 1);
}
function accumulate(c) {
  if (c.leaf) {
    if (c.p) { c.m = c.p.charge; c.cx = c.p.x; c.cy = c.p.y; }
    return;
  }
  let m = 0, cx = 0, cy = 0;
  for (const k of c.kids) if (k) { accumulate(k); m += k.m; cx += k.cx * k.m; cy += k.cy * k.m; }
  c.m = m; c.cx = cx / m; c.cy = cy / m;
}
function repulse(c, n, K) {
  if (c.leaf) {
    const p = c.p;
    if (!p || p === n) return;
    apply(n, p.x, p.y, p.charge, K);
    return;
  }
  const dx = c.cx - n.x, dy = c.cy - n.y, d2 = dx * dx + dy * dy;
  if (c.s * c.s < d2 * 0.81) { apply(n, c.cx, c.cy, c.m, K); return; }
  for (const k of c.kids) if (k) repulse(k, n, K);
}
function apply(n, x, y, m, K) {
  const dx = n.x - x, dy = n.y - y, d2 = dx * dx + dy * dy + 1;
  const f = K * m / d2;
  n.vx += dx * f; n.vy += dy * f;
}

// extra repulsion between centers of mass of top-level sections
function separateSections(K) {
  const gs = new Map();
  for (const n of nodes) {
    if (n.type === "root") continue;
    const g = n.groups.values().next().value;
    let e = gs.get(g);
    if (!e) gs.set(g, e = { x: 0, y: 0, c: 0, ids: [] });
    e.x += n.x; e.y += n.y; e.c++; e.ids.push(n);
  }
  if (gs.size < 2) return;
  const list = [...gs.values()];
  for (const e of list) { e.x /= e.c; e.y /= e.c; }
  const S = K * pm.sectionSep * 3;
  for (const a of list) {
    let fx = 0, fy = 0;
    for (const b of list) {
      if (a === b) continue;
      const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 100;
      const w = S * Math.sqrt(b.c) / d2;
      fx += dx * w; fy += dy * w;
    }
    for (const n of a.ids) { if (!n.fixed) { n.vx += fx; n.vy += fy; } }
  }
}

function tick() {
  const N = nodes.length;
  if (!N) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    if (n.x < x0) x0 = n.x; if (n.x > x1) x1 = n.x;
    if (n.y < y0) y0 = n.y; if (n.y > y1) y1 = n.y;
  }
  const s = Math.max(x1 - x0, y1 - y0, 1) + 1;
  const qt = newCell(x0 - 0.5, y0 - 0.5, s);
  for (const n of nodes) insert(qt, n, 0);
  accumulate(qt);

  for (const n of nodes) {
    n.charge = n.type === "bookmark" ? 1
      : (n.type === "root" ? 10 : 2 + Math.sqrt(n.size) * 0.5 * pm.sizeRep) * pm.folderRep;
  }
  const K = 28 * alpha * spread * spread;
  separateSections(K);
  for (const n of nodes) { if (!n.fixed) repulse(qt, n, K); }

  for (const l of links) {
    const a = nodes[l.s], b = nodes[l.t];
    let dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - l.L * spread * (l.bm ? pm.linkLen : pm.folderDist)) / d * 0.12 * pm.stiff * alpha;
    dx *= f; dy *= f;
    // a hub with many children barely moves, leaves are pulled in
    const wa = b.deg / (a.deg + b.deg), wb = 1 - wa;
    a.vx += dx * wa; a.vy += dy * wa;
    b.vx -= dx * wb; b.vy -= dy * wb;
  }
  for (const n of nodes) {
    if (n.fixed) { n.vx = n.vy = 0; continue; }
    const g = 0.012 / spread * pm.gravity * gravityBoost * alpha; n.vx -= n.x * g; n.vy -= n.y * g;
    n.vx *= 0.6; n.vy *= 0.6;
    const vm = Math.hypot(n.vx, n.vy), cap = 60 * spread;
    if (vm > cap) { n.vx *= cap / vm; n.vy *= cap / vm; }
    n.x += n.vx; n.y += n.vy;
  }
}

// ---------- drawing ----------

const toScreenX = x => x * view.k + view.x;
const toScreenY = y => y * view.k + view.y;
const widthCache = new Map();
function textWidth(font, text) {
  const key = font + "|" + text;
  let w = widthCache.get(key);
  if (w === undefined) { ctx.font = font; w = ctx.measureText(text).width; widthCache.set(key, w); if (widthCache.size > 20000) widthCache.clear(); }
  return w;
}
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function highlightSet() {
  if (matches) return matches;
  const f = hover >= 0 ? hover : selected;
  if (f >= 0) { const s = new Set(neighbors[f]); s.add(f); return s; }
  return null;
}

function draw() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const T = THEMES[theme];
  const hl = highlightSet();
  const focus = matches ? -1 : (hover >= 0 ? hover : selected);

  // edges
  ctx.lineWidth = 1;
  for (const l of links) {
    const a = nodes[l.s], b = nodes[l.t];
    const ax = toScreenX(a.x), ay = toScreenY(a.y), bx = toScreenX(b.x), by = toScreenY(b.y);
    if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) || (ax > W && bx > W) || (ay > H && by > H)) continue;
    let al = 0.22;
    if (hl) al = (focus >= 0 && (l.s === focus || l.t === focus)) ? 0.8 : (hl.has(l.s) && hl.has(l.t) ? 0.35 : 0.04);
    ctx.strokeStyle = `rgba(${T.edge},${al})`;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
  }

  // nodes
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const x = toScreenX(n.x), y = toScreenY(n.y);
    if (x < -30 || y < -30 || x > W + 30 || y > H + 30) continue;
    const r = Math.max(n.r * Math.sqrt(view.k), 1.8);
    ctx.globalAlpha = hl && !hl.has(i) ? 0.12 : 1;
    ctx.fillStyle = n.type === "root" ? T.root : colorFor(n);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    if (n.type === "bookmark" && n.groups.size > 1) { ctx.strokeStyle = T.share; ctx.lineWidth = 1; ctx.stroke(); }
    if (i === focus) { ctx.strokeStyle = T.ring; ctx.lineWidth = 2; ctx.stroke(); }
  }
  ctx.globalAlpha = 1;

  // labels with simple overlap suppression: important ones first
  const cell = 48, grid = new Map();
  const taken = (x0, y0, x1, y1) => {
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
      for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
        const arr = grid.get(cx + "," + cy);
        if (arr) for (const r of arr) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return true;
      }
    return false;
  };
  const claim = (x0, y0, x1, y1) => {
    const r = [x0, y0, x1, y1];
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
      for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
        const key = cx + "," + cy;
        (grid.get(key) || grid.set(key, []).get(key)).push(r);
      }
  };
  const zoomFs = Math.min(1.6, Math.max(1, Math.pow(view.k, 0.35)));
  const showB = showLinksBox.checked;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  const label = i => {
    const n = nodes[i];
    const isF = n.type !== "bookmark";
    if (!isF && !showB && !(hl && hl.has(i))) return;
    const x = toScreenX(n.x), y = toScreenY(n.y);
    if (x < -50 || y < -20 || x > W + 50 || y > H + 20) return;
    const fs = (isF ? 13 : 10.5) * zoomFs;
    const font = `${isF ? "600 " : ""}${fs.toFixed(1)}px system-ui, sans-serif`;
    const text = trunc(n.label, isF ? 44 : 38);
    const w = textWidth(font, text);
    const r = Math.max(n.r * Math.sqrt(view.k), 1.8);
    const lx = x + r + 3, ly = y;
    if (taken(lx, ly - fs / 2, lx + w, ly + fs / 2)) return;
    claim(lx - 1, ly - fs / 2 - 1, lx + w + 1, ly + fs / 2 + 1);
    ctx.font = font;
    ctx.lineWidth = 3; ctx.strokeStyle = T.halo; ctx.strokeText(text, lx, ly);
    ctx.fillStyle = isF ? T.fold : T.book; ctx.fillText(text, lx, ly);
  };
  if (hl) for (const i of hl) label(i);
  if (!matches) for (const i of order) label(i);
}

// ---------- main loop ----------

function frame() {
  if (alpha > 0.004) {
    tick();
    alpha *= 0.985;
    dirty = true;
    if (autoFit && alpha > 0.15) fit(true);
  }
  if (dirty) { draw(); dirty = false; }
  requestAnimationFrame(frame);
}

function fit(quiet) {
  const pool = matches ? [...matches].map(i => nodes[i]) : nodes;
  if (!pool.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of pool) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
  const pad = 80, top = 50;
  const k = Math.min((W - pad * 2) / Math.max(x1 - x0, 1), (H - top - pad * 2) / Math.max(y1 - y0, 1), 4);
  view.k = k;
  view.x = W / 2 - ((x0 + x1) / 2) * k;
  view.y = top + (H - top) / 2 - ((y0 + y1) / 2) * k;
  dirty = true;
  if (!quiet) autoFit = false;
}

function resize() {
  DPR = window.devicePixelRatio || 1;
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * DPR; canvas.height = H * DPR;
  dirty = true;
}
window.addEventListener("resize", resize);

// ---------- search ----------

function runSearch() {
  const q = qInput.value.trim().toLowerCase();
  if (!q) { matches = null; dirty = true; return; }
  matches = new Set();
  nodes.forEach((n, i) => {
    if (n.type === "root") return;
    if (n.label.toLowerCase().includes(q) || (n.url && n.url.toLowerCase().includes(q))) matches.add(i);
  });
  dirty = true;
}
qInput.addEventListener("input", () => { runSearch(); if (matches && matches.size) { autoFit = false; fit(true); } });
sectionSel.addEventListener("change", applyFilter);
showLinksBox.addEventListener("change", () => { dirty = true; });
const panel = document.getElementById("panel");
function buildPanel() {
  for (const p of PARAMS) {
    const row = document.createElement("div"); row.className = "row";
    const name = document.createElement("label"); name.textContent = p.label;
    const val = document.createElement("span");
    const inp = document.createElement("input");
    Object.assign(inp, { type: "range", min: -4, max: 4, step: 0.05, value: pv[p.key] });
    const hint = document.createElement("div"); hint.className = "hint"; hint.textContent = p.hint;
    const show = () => { val.textContent = "×" + pm[p.key].toFixed(2); };
    show();
    inp.addEventListener("input", () => {
      pv[p.key] = parseFloat(inp.value); pm[p.key] = Math.pow(2, pv[p.key]); show();
      try { localStorage.setItem("bg-params", JSON.stringify(pv)); } catch {}
      alpha = Math.max(alpha, 1);
    });
    p.input = inp; p.show = show;
    row.append(name, val, inp, hint);
    panel.append(row);
  }
  const reset = document.createElement("button"); reset.textContent = "Reset all";
  reset.addEventListener("click", () => {
    for (const p of PARAMS) { pv[p.key] = 0; pm[p.key] = 1; p.input.value = 0; p.show(); }
    spreadLog = 0; spread = 1; spreadInput.value = 0; spreadVal.textContent = "×1.00";
    try { localStorage.setItem("bg-params", "{}"); localStorage.setItem("bg-spread-log", "0"); } catch {}
    alpha = 1;
  });
  panel.append(reset);
}
buildPanel();
showRootBox.checked = showRoot;
showRootBox.addEventListener("change", () => {
  showRoot = showRootBox.checked;
  try { localStorage.setItem("bg-root", showRoot ? "1" : "0"); } catch {}
  applyFilter(); autoFit = false;   // leave the camera alone
});
document.getElementById("gear").addEventListener("click", () => { panel.hidden = !panel.hidden; });
spreadInput.value = spreadLog;
spreadVal.textContent = "×" + spread.toFixed(2);
spreadInput.addEventListener("input", () => {
  spreadLog = parseFloat(spreadInput.value);
  spread = Math.pow(2, spreadLog);
  spreadVal.textContent = "×" + spread.toFixed(2);
  try { localStorage.setItem("bg-spread-log", spreadLog); } catch {}
  alpha = Math.max(alpha, 1);
});
themeBtn.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("bg-theme", theme); } catch {}
  applyTheme();
});
applyTheme();
document.getElementById("fit").addEventListener("click", () => fit(false));

// ---------- mouse ----------

function hit(mx, my) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const dx = toScreenX(n.x) - mx, dy = toScreenY(n.y) - my;
    const r = Math.max(n.r * Math.sqrt(view.k), 1.8) + 3;
    const d = dx * dx + dy * dy;
    if (d < r * r && d < bd) { bd = d; best = i; }
  }
  return best;
}

let drag = null;
canvas.addEventListener("pointerdown", e => {
  if (e.button !== 0) return;
  canvas.setPointerCapture(e.pointerId);
  const i = hit(e.clientX, e.clientY);
  drag = { i, sx: e.clientX, sy: e.clientY, moved: false, vx: view.x, vy: view.y };
  autoFit = false;
  canvas.classList.add("drag");
});
canvas.addEventListener("pointermove", e => {
  if (drag) {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.i >= 0) {
      const n = nodes[drag.i];
      n.x = (e.clientX - view.x) / view.k; n.y = (e.clientY - view.y) / view.k;
      n.fixed = true; alpha = Math.max(alpha, 0.25);
    } else { view.x = drag.vx + dx; view.y = drag.vy + dy; }
    dirty = true;
    return;
  }
  const i = hit(e.clientX, e.clientY);
  if (i !== hover) { hover = i; dirty = true; canvas.classList.toggle("hit", i >= 0); }
  if (i >= 0) {
    const n = nodes[i];
    tip.hidden = false;
    tip.replaceChildren(document.createTextNode(n.label));
    const small = document.createElement("small");
    small.textContent = n.type === "bookmark" ? n.url : `${n.size} links`;
    tip.append(small);
    tip.style.left = Math.min(e.clientX + 14, W - 440) + "px";
    tip.style.top = (e.clientY + 14) + "px";
  } else tip.hidden = true;
});
canvas.addEventListener("pointerup", e => {
  canvas.classList.remove("drag");
  if (!drag) return;
  const d = drag; drag = null;
  if (d.i >= 0) nodes[d.i].fixed = false;
  if (d.moved) return;
  if (d.i < 0) { selected = -1; dirty = true; return; }
  const n = nodes[d.i];
  if (n.type === "bookmark") api.tabs.create({ url: n.url, active: !(e.ctrlKey || e.metaKey || e.shiftKey) });
  else { selected = selected === d.i ? -1 : d.i; dirty = true; }
});
canvas.addEventListener("pointerleave", () => { tip.hidden = true; if (hover !== -1) { hover = -1; dirty = true; } });
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  autoFit = false;
  const f = Math.exp(-e.deltaY * 0.0015);
  const k = view.k * f;
  const r = k / view.k;
  view.x = e.clientX - (e.clientX - view.x) * r;
  view.y = e.clientY - (e.clientY - view.y) * r;
  view.k = k; dirty = true;
}, { passive: false });
window.addEventListener("keydown", e => {
  if (e.key === "Escape") { selected = -1; qInput.value = ""; runSearch(); dirty = true; }
  if (e.key === "/" && document.activeElement !== qInput) { e.preventDefault(); qInput.focus(); }
});

resize();
load(true).then(() => requestAnimationFrame(frame));
