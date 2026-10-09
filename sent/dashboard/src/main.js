// Limey Guard admin console — plain-JS React-free SPA hitting the real API.
import { login, me, logout, api, setCsrf } from "./api.js";

const root = document.getElementById("root");

const state = { user: null, route: "overview", eventsFilter: {} };

const pages = ["overview", "sites", "policies", "events", "analytics", "settings"];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

// --- layout ------------------------------------------------------------------

function layout(content) {
  const active = (r) => (state.route === r ? 'class="active"' : "");
  return `
    <header class="top">
      <div class="brand">🍋 Limey Guard</div>
      <nav>${pages.map((p) => `<a href="#/${p}" ${active(p)}>${p[0].toUpperCase() + p.slice(1)}</a>`).join("")}</nav>
      <div class="spacer"></div>
      <span class="user">${esc(state.user?.username || "")} · ${esc(state.user?.role || "")}</span>
      <button class="link" id="logoutBtn">Sign out</button>
    </header>
    <main>${content}</main>`;
}

// --- pages -------------------------------------------------------------------

async function pageOverview() {
  const [analytics, events] = await Promise.all([
    api("/analytics?hours=24").catch(() => null),
    api("/events?limit=8").catch(() => null),
  ]);
  const totals = { allow: 0, challenge: 0, throttle: 0, block: 0, challenges: 0 };
  for (const b of analytics?.buckets ?? []) {
    for (const [k, v] of Object.entries(b.decisions ?? {})) totals[k] += v;
    totals.challenges += b.challenges ?? 0;
  }
  const cards = [
    ["Allowed", totals.allow], ["Challenged", totals.challenge],
    ["Throttled", totals.throttle], ["Blocked", totals.block],
  ];
  return layout(`
    <h1>Overview <span class="muted">last 24h</span></h1>
    <div class="cards">${cards.map(([k, v]) => `<div class="card"><div class="num">${v}</div><div class="lbl">${k}</div></div>`).join("")}</div>
    ${renderTrend(analytics?.buckets ?? [])}
    <h2>Recent events</h2>
    <table class="tbl events">${eventRows(events?.events ?? [])}</table>
  `);
}

function renderTrend(buckets) {
  if (!buckets.length) return `<p class="muted">No traffic recorded yet.</p>`;
  const rows = buckets
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .slice(-24)
    .map((b) => {
      const total = Object.values(b.decisions || {}).reduce((a, x) => a + x, 0);
      const bar = total ? Math.min(100, (b.challenges / total) * 100) : 0;
      return `<div class="trow"><span class="tt">${fmtTime(b.bucket)}</span><span class="bar"><span style="width:${bar}%"></span></span><span class="tv">${total}</span></div>`;
    }).join("");
  return `<h2>Traffic (challenges as % of requests)</h2><div class="trend">${rows}</div>`;
}

function eventRows(events) {
  if (!events.length) return `<tr><td colspan="6" class="muted">No events match.</td></tr>`;
  return events.map((e) => `
    <tr data-detail="${esc(JSON.stringify(e))}">
      <td>${fmtTime(e.ts)}</td>
      <td><span class="pill ${esc(e.decision)}">${esc(e.decision)}</span></td>
      <td>${esc(e.site_key || "")}</td>
      <td>${esc(e.path || "")}</td>
      <td>${esc((e.rules || []).join(", ") || "—")}</td>
      <td>${e.score?.toFixed?.(1) ?? e.score ?? 0}</td>
    </tr>`).join("");
}

async function pageSites() {
  const { sites } = await api("/sites");
  const rows = sites.map((s) => `
    <tr>
      <td><code>${esc(s.siteKey)}</code></td>
      <td>${esc(s.name)}</td>
      <td>${s.hostnames.map(esc).join(", ")}</td>
      <td>${s.enabled ? "✅" : "🚫"}</td>
      <td>${esc(s.createdAt)}</td>
      <td>
        <button data-rotate="${esc(s.siteKey)}">Rotate secret</button>
        <button data-delete="${esc(s.siteKey)}" class="danger">Delete</button>
      </td>
    </tr>`).join("");
  return layout(`
    <h1>Sites &amp; applications</h1>
    <form id="newSite" class="panel">
      <h3>Register site</h3>
      <label>Site key <input name="siteKey" required minlength="3" maxlength="64" placeholder="my-site" /></label>
      <label>Name <input name="name" required placeholder="My Website" /></label>
      <label>Hostnames (comma separated) <input name="hostnames" required placeholder="example.com, www.example.com" /></label>
      <button type="submit">Create</button>
      <div id="siteSecret" class="secret hidden"></div>
    </form>
    <table class="tbl"><thead><tr><th>Key</th><th>Name</th><th>Hostnames</th><th>Enabled</th><th>Created</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>
  `);
}

async function pagePolicies() {
  const { policies } = await api("/policies");
  const rows = (policies ?? []).map((p) => `
    <tr>
      <td><code>${esc(p.site_key)}</code></td><td>${esc(p.name)}</td>
      <td>${esc(p.action_name)}</td>
      <td>${p.require_verified ? "required" : "risk-scored"}</td>
      <td>${esc(String(p.rate_limit))}/min</td>
      <td>${esc(String(p.threshold_challenge))} / ${esc(String(p.threshold_throttle))} / ${esc(String(p.threshold_block))}</td>
      <td>${p.simulation ? "🧪 simulate" : "⛔ enforce"}</td>
    </tr>`).join("");
  return layout(`
    <h1>Security policies</h1>
    <p class="muted">Policies are enforced by the central service; simulation mode evaluates without blocking.</p>
    <table class="tbl"><thead><tr><th>Site</th><th>Name</th><th>Action</th><th>Verification</th><th>Rate limit</th><th>Thresholds C/T/B</th><th>Mode</th></tr></thead><tbody>${rows}</tbody></table>
  `);
}

async function pageEvents() {
  const f = state.eventsFilter;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v);
  qs.set("limit", "50");
  const { events } = await api(`/events?${qs}`);
  const filters = `
    <form id="evFilter" class="panel">
      <label>Site <input name="siteKey" value="${esc(f.siteKey || "")}" /></label>
      <label>Decision
        <select name="decision">
          ${["", "allow", "challenge", "throttle", "block"].map((d) => `<option value="${d}" ${f.decision === d ? "selected" : ""}>${d || "any"}</option>`).join("")}
        </select></label>
      <label>Action <input name="action" value="${esc(f.action || "")}" /></label>
      <button type="submit">Apply</button>
      <button type="button" id="evExport">Export JSON</button>
    </form>`;
  return layout(`
    <h1>Event explorer</h1>
    ${filters}
    <table class="tbl events">${eventRows(events)}</table>
    <p class="muted">Client identities are irreversible hashes; query strings and bodies are never stored.</p>
  `);
}

async function pageAnalytics() {
  const hours = Number(state.analyticsHours || 24);
  const { buckets } = await api(`/analytics?hours=${hours}`);
  const totals = {};
  for (const b of buckets) for (const [k, v] of Object.entries(b.decisions ?? {})) totals[k] = (totals[k] || 0) + v;
  const topRoutes = {};
  const { events } = await api(`/events?limit=200`);
  for (const e of events ?? []) topRoutes[e.path || "(root)"] = (topRoutes[e.path || "(root)"] || 0) + 1;
  const routes = Object.entries(topRoutes).sort((a, b) => b[1] - a[1]).slice(0, 10);
  return layout(`
    <h1>Analytics</h1>
    <label class="inline">Window
      <select id="hours">${[6, 24, 72, 168].map((h) => `<option ${h === hours ? "selected" : ""} value="${h}">${h}h</option>`).join("")}</select>
    </label>
    <div class="cards">${Object.entries(totals).map(([k, v]) => `<div class="card"><div class="num">${v}</div><div class="lbl">${k}</div></div>`).join("")}</div>
    ${renderTrend(buckets)}
    <h2>Top targeted paths (recent 200 events)</h2>
    <table class="tbl"><tbody>${routes.map(([p, n]) => `<tr><td><code>${esc(p)}</code></td><td>${n}</td></tr>`).join("")}</tbody></table>
  `);
}

async function pageSettings() {
  const audit = await api("/audit?limit=50").catch(() => ({ entries: [] }));
  const [me_, health] = await Promise.all([me().catch(() => null), fetch("/v1/ready").then((r) => r.json()).catch(() => null)]);
  return layout(`
    <h1>Settings</h1>
    <div class="panel">
      <h3>Session</h3>
      <p>Signed in as <strong>${esc(state.user?.username)}</strong> (role ${esc(state.user?.role)}). Sessions are HTTP-only cookies; admin actions require a CSRF token and are audited.</p>
    </div>
    <div class="panel">
      <h3>Health</h3>
      <p>PostgreSQL: ${health?.postgres === "up" ? "✅ up" : "⚠️ " + esc(health?.postgres || "unknown")}</p>
    </div>
    <h2>Audit log</h2>
    <table class="tbl"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
    <tbody>${(audit.entries ?? []).map((a) => `<tr><td>${fmtTime(a.ts)}</td><td>${esc(a.actor)}</td><td>${esc(a.action)}</td><td>${esc(a.target)}</td></tr>`).join("")}</tbody></table>
  `);
}

// --- login ---------------------------------------------------------------------

function loginScreen(msg = "") {
  root.innerHTML = `
    <div class="login-wrap">
      <form class="login panel" id="loginForm">
        <div class="brand big">🍋 Limey Guard</div>
        <p class="muted">Sign in to the protection console.</p>
        ${msg ? `<div class="err">${esc(msg)}</div>` : ""}
        <label>Username <input name="username" autocomplete="username" required /></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Sign in</button>
      </form>
    </div>`;
  document.getElementById("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const u = await login(f.get("username"), f.get("password"));
      state.user = u;
      await router();
    } catch (err) {
      loginScreen(err.message || "Sign-in failed");
    }
  };
}

// --- router ---------------------------------------------------------------

async function router() {
  if (!state.user) {
    try {
      state.user = await me();
      setCsrf(state.user.csrf);
    } catch {
      return loginScreen();
    }
  }
  const impl = {
    overview: pageOverview, sites: pageSites, policies: pagePolicies,
    events: pageEvents, analytics: pageAnalytics, settings: pageSettings,
  };
  try {
    root.innerHTML = await impl[state.route]();
    bind();
  } catch (err) {
    if (err.status === 401) { state.user = null; return loginScreen(); }
    root.innerHTML = layout(`<div class="err">Failed to load: ${esc(err.message)}</div>`);
  }
}

function bind() {
  const lo = document.getElementById("logoutBtn");
  if (lo) lo.onclick = async () => { await logout(); state.user = null; loginScreen(); };
  const ns = document.getElementById("newSite");
  if (ns) ns.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(ns);
    const hostnames = String(f.get("hostnames")).split(",").map((s) => s.trim()).filter(Boolean);
    try {
      const out = await api("/sites", { method: "POST", body: { siteKey: f.get("siteKey"), name: f.get("name"), hostnames } });
      const box = document.getElementById("siteSecret");
      box.classList.remove("hidden");
      box.innerHTML = `<strong>Copy this secret now (shown once):</strong><br><code>${esc(out.secret)}</code>`;
    } catch (err) { box.classList.remove("hidden"); box.innerHTML = `<span class="err">${esc(err.message)}</span>`; }
  };
  document.querySelectorAll("[data-rotate]").forEach((b) => b.onclick = async () => {
    const out = await api(`/sites/${b.dataset.rotate}/rotate`, { method: "POST", body: {} });
    alert("New secret (shown once):\n" + out.secret);
  });
  document.querySelectorAll("[data-delete]").forEach((b) => b.onclick = async () => {
    if (!confirm(`Delete site ${b.dataset.delete}? Policies and events remain for audit.`)) return;
    await api(`/sites/${b.dataset.delete}`, { method: "DELETE" });
    router();
  });
  const ef = document.getElementById("evFilter");
  if (ef) ef.onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(ef);
    state.eventsFilter = { siteKey: f.get("siteKey"), decision: f.get("decision"), action: f.get("action") };
    router();
  };
  const ex = document.getElementById("evExport");
  if (ex) ex.onclick = async () => {
    const data = await api(`/events?${new URLSearchParams({ ...state.eventsFilter, limit: "1000" })}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "sentinel-events.json" }).click();
  };
  const hrs = document.getElementById("hours");
  if (hrs) hrs.onchange = () => { state.analyticsHours = hrs.value; router(); };
  document.querySelectorAll("tr[data-detail]").forEach((tr) => tr.onclick = () => {
    const e = JSON.parse(tr.dataset.detail);
    alert(JSON.stringify(e, null, 2));
  });
}

window.addEventListener("hashchange", () => {
  const r = location.hash.replace("#/", "");
  if (pages.includes(r)) { state.route = r; router(); }
});
state.route = pages.includes(location.hash.replace("#/", "")) ? location.hash.replace("#/", "") : "overview";
router();
