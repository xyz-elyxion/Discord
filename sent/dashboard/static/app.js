var m=null;async function l(e,{method:s="GET",body:t}={}){let o={"Content-Type":"application/json"};m&&(o["X-CSRF-Token"]=m);let r=await fetch(`/v1${e}`,{method:s,headers:o,body:t===void 0?void 0:JSON.stringify(t),credentials:"same-origin"});if(!r.ok){let i="http_"+r.status,n=r.statusText;try{let u=await r.json();u?.error?.code&&(i=u.error.code,n=u.error.message)}catch{}let d=new Error(n);throw d.code=i,d.status=r.status,d}return r.json()}async function w(e,s){let t=await l("/auth/login",{method:"POST",body:{username:e,password:s}});return m=t.csrf,t}async function v(){let e=await l("/auth/me");return m=e.csrf,e}async function S(){try{await l("/auth/logout",{method:"POST",body:{}})}finally{m=null}}var k=e=>{m=e};var g=document.getElementById("root"),c={user:null,route:"overview",eventsFilter:{}},y=["overview","sites","policies","events","analytics","settings"];function a(e){return String(e??"").replace(/[&<>"']/g,s=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[s])}function f(e){try{return new Date(e).toLocaleString()}catch{return e}}function h(e){let s=t=>c.route===t?'class="active"':"";return`
    <header class="top">
      <div class="brand">\u{1F34B} Limey Guard</div>
      <nav>${y.map(t=>`<a href="#/${t}" ${s(t)}>${t[0].toUpperCase()+t.slice(1)}</a>`).join("")}</nav>
      <div class="spacer"></div>
      <span class="user">${a(c.user?.username||"")} \xB7 ${a(c.user?.role||"")}</span>
      <button class="link" id="logoutBtn">Sign out</button>
    </header>
    <main>${e}</main>`}async function T(){let[e,s]=await Promise.all([l("/analytics?hours=24").catch(()=>null),l("/events?limit=8").catch(()=>null)]),t={allow:0,challenge:0,throttle:0,block:0,challenges:0};for(let r of e?.buckets??[]){for(let[i,n]of Object.entries(r.decisions??{}))t[i]+=n;t.challenges+=r.challenges??0}let o=[["Allowed",t.allow],["Challenged",t.challenge],["Throttled",t.throttle],["Blocked",t.block]];return h(`
    <h1>Overview <span class="muted">last 24h</span></h1>
    <div class="cards">${o.map(([r,i])=>`<div class="card"><div class="num">${i}</div><div class="lbl">${r}</div></div>`).join("")}</div>
    ${j(e?.buckets??[])}
    <h2>Recent events</h2>
    <table class="tbl events">${E(s?.events??[])}</table>
  `)}function j(e){return e.length?`<h2>Traffic (challenges as % of requests)</h2><div class="trend">${e.sort((t,o)=>t.bucket.localeCompare(o.bucket)).slice(-24).map(t=>{let o=Object.values(t.decisions||{}).reduce((i,n)=>i+n,0),r=o?Math.min(100,t.challenges/o*100):0;return`<div class="trow"><span class="tt">${f(t.bucket)}</span><span class="bar"><span style="width:${r}%"></span></span><span class="tv">${o}</span></div>`}).join("")}</div>`:'<p class="muted">No traffic recorded yet.</p>'}function E(e){return e.length?e.map(s=>`
    <tr data-detail="${a(JSON.stringify(s))}">
      <td>${f(s.ts)}</td>
      <td><span class="pill ${a(s.decision)}">${a(s.decision)}</span></td>
      <td>${a(s.site_key||"")}</td>
      <td>${a(s.path||"")}</td>
      <td>${a((s.rules||[]).join(", ")||"\u2014")}</td>
      <td>${s.score?.toFixed?.(1)??s.score??0}</td>
    </tr>`).join(""):'<tr><td colspan="6" class="muted">No events match.</td></tr>'}async function O(){let{sites:e}=await l("/sites"),s=e.map(t=>`
    <tr>
      <td><code>${a(t.siteKey)}</code></td>
      <td>${a(t.name)}</td>
      <td>${t.hostnames.map(a).join(", ")}</td>
      <td>${t.enabled?"\u2705":"\u{1F6AB}"}</td>
      <td>${a(t.createdAt)}</td>
      <td>
        <button data-rotate="${a(t.siteKey)}">Rotate secret</button>
        <button data-delete="${a(t.siteKey)}" class="danger">Delete</button>
      </td>
    </tr>`).join("");return h(`
    <h1>Sites &amp; applications</h1>
    <form id="newSite" class="panel">
      <h3>Register site</h3>
      <label>Site key <input name="siteKey" required minlength="3" maxlength="64" placeholder="my-site" /></label>
      <label>Name <input name="name" required placeholder="My Website" /></label>
      <label>Hostnames (comma separated) <input name="hostnames" required placeholder="example.com, www.example.com" /></label>
      <button type="submit">Create</button>
      <div id="siteSecret" class="secret hidden"></div>
    </form>
    <table class="tbl"><thead><tr><th>Key</th><th>Name</th><th>Hostnames</th><th>Enabled</th><th>Created</th><th>Actions</th></tr></thead><tbody>${s}</tbody></table>
  `)}async function x(){let{policies:e}=await l("/policies"),s=(e??[]).map(t=>`
    <tr>
      <td><code>${a(t.site_key)}</code></td><td>${a(t.name)}</td>
      <td>${a(t.action_name)}</td>
      <td>${t.require_verified?"required":"risk-scored"}</td>
      <td>${a(String(t.rate_limit))}/min</td>
      <td>${a(String(t.threshold_challenge))} / ${a(String(t.threshold_throttle))} / ${a(String(t.threshold_block))}</td>
      <td>${t.simulation?"\u{1F9EA} simulate":"\u26D4 enforce"}</td>
    </tr>`).join("");return h(`
    <h1>Security policies</h1>
    <p class="muted">Policies are enforced by the central service; simulation mode evaluates without blocking.</p>
    <table class="tbl"><thead><tr><th>Site</th><th>Name</th><th>Action</th><th>Verification</th><th>Rate limit</th><th>Thresholds C/T/B</th><th>Mode</th></tr></thead><tbody>${s}</tbody></table>
  `)}async function L(){let e=c.eventsFilter,s=new URLSearchParams;for(let[r,i]of Object.entries(e))i&&s.set(r,i);s.set("limit","50");let{events:t}=await l(`/events?${s}`),o=`
    <form id="evFilter" class="panel">
      <label>Site <input name="siteKey" value="${a(e.siteKey||"")}" /></label>
      <label>Decision
        <select name="decision">
          ${["","allow","challenge","throttle","block"].map(r=>`<option value="${r}" ${e.decision===r?"selected":""}>${r||"any"}</option>`).join("")}
        </select></label>
      <label>Action <input name="action" value="${a(e.action||"")}" /></label>
      <button type="submit">Apply</button>
      <button type="button" id="evExport">Export JSON</button>
    </form>`;return h(`
    <h1>Event explorer</h1>
    ${o}
    <table class="tbl events">${E(t)}</table>
    <p class="muted">Client identities are irreversible hashes; query strings and bodies are never stored.</p>
  `)}async function q(){let e=Number(c.analyticsHours||24),{buckets:s}=await l(`/analytics?hours=${e}`),t={};for(let n of s)for(let[d,u]of Object.entries(n.decisions??{}))t[d]=(t[d]||0)+u;let o={},{events:r}=await l("/events?limit=200");for(let n of r??[])o[n.path||"(root)"]=(o[n.path||"(root)"]||0)+1;let i=Object.entries(o).sort((n,d)=>d[1]-n[1]).slice(0,10);return h(`
    <h1>Analytics</h1>
    <label class="inline">Window
      <select id="hours">${[6,24,72,168].map(n=>`<option ${n===e?"selected":""} value="${n}">${n}h</option>`).join("")}</select>
    </label>
    <div class="cards">${Object.entries(t).map(([n,d])=>`<div class="card"><div class="num">${d}</div><div class="lbl">${n}</div></div>`).join("")}</div>
    ${j(s)}
    <h2>Top targeted paths (recent 200 events)</h2>
    <table class="tbl"><tbody>${i.map(([n,d])=>`<tr><td><code>${a(n)}</code></td><td>${d}</td></tr>`).join("")}</tbody></table>
  `)}async function F(){let e=await l("/audit?limit=50").catch(()=>({entries:[]})),[s,t]=await Promise.all([v().catch(()=>null),fetch("/v1/ready").then(o=>o.json()).catch(()=>null)]);return h(`
    <h1>Settings</h1>
    <div class="panel">
      <h3>Session</h3>
      <p>Signed in as <strong>${a(c.user?.username)}</strong> (role ${a(c.user?.role)}). Sessions are HTTP-only cookies; admin actions require a CSRF token and are audited.</p>
    </div>
    <div class="panel">
      <h3>Health</h3>
      <p>PostgreSQL: ${t?.postgres==="up"?"\u2705 up":"\u26A0\uFE0F "+a(t?.postgres||"unknown")}</p>
    </div>
    <h2>Audit log</h2>
    <table class="tbl"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Target</th></tr></thead>
    <tbody>${(e.entries??[]).map(o=>`<tr><td>${f(o.ts)}</td><td>${a(o.actor)}</td><td>${a(o.action)}</td><td>${a(o.target)}</td></tr>`).join("")}</tbody></table>
  `)}function b(e=""){g.innerHTML=`
    <div class="login-wrap">
      <form class="login panel" id="loginForm">
        <div class="brand big">\u{1F34B} Limey Guard</div>
        <p class="muted">Sign in to the protection console.</p>
        ${e?`<div class="err">${a(e)}</div>`:""}
        <label>Username <input name="username" autocomplete="username" required /></label>
        <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
        <button type="submit">Sign in</button>
      </form>
    </div>`,document.getElementById("loginForm").onsubmit=async s=>{s.preventDefault();let t=new FormData(s.target);try{let o=await w(t.get("username"),t.get("password"));c.user=o,await p()}catch(o){b(o.message||"Sign-in failed")}}}async function p(){if(!c.user)try{c.user=await v(),k(c.user.csrf)}catch{return b()}let e={overview:T,sites:O,policies:x,events:L,analytics:q,settings:F};try{g.innerHTML=await e[c.route](),A()}catch(s){if(s.status===401)return c.user=null,b();g.innerHTML=h(`<div class="err">Failed to load: ${a(s.message)}</div>`)}}function A(){let e=document.getElementById("logoutBtn");e&&(e.onclick=async()=>{await S(),c.user=null,b()});let s=document.getElementById("newSite");s&&(s.onsubmit=async i=>{i.preventDefault();let n=new FormData(s),d=String(n.get("hostnames")).split(",").map(u=>u.trim()).filter(Boolean);try{let u=await l("/sites",{method:"POST",body:{siteKey:n.get("siteKey"),name:n.get("name"),hostnames:d}}),$=document.getElementById("siteSecret");$.classList.remove("hidden"),$.innerHTML=`<strong>Copy this secret now (shown once):</strong><br><code>${a(u.secret)}</code>`}catch(u){box.classList.remove("hidden"),box.innerHTML=`<span class="err">${a(u.message)}</span>`}}),document.querySelectorAll("[data-rotate]").forEach(i=>i.onclick=async()=>{let n=await l(`/sites/${i.dataset.rotate}/rotate`,{method:"POST",body:{}});alert(`New secret (shown once):
`+n.secret)}),document.querySelectorAll("[data-delete]").forEach(i=>i.onclick=async()=>{confirm(`Delete site ${i.dataset.delete}? Policies and events remain for audit.`)&&(await l(`/sites/${i.dataset.delete}`,{method:"DELETE"}),p())});let t=document.getElementById("evFilter");t&&(t.onsubmit=i=>{i.preventDefault();let n=new FormData(t);c.eventsFilter={siteKey:n.get("siteKey"),decision:n.get("decision"),action:n.get("action")},p()});let o=document.getElementById("evExport");o&&(o.onclick=async()=>{let i=await l(`/events?${new URLSearchParams({...c.eventsFilter,limit:"1000"})}`),n=new Blob([JSON.stringify(i,null,2)],{type:"application/json"});Object.assign(document.createElement("a"),{href:URL.createObjectURL(n),download:"sentinel-events.json"}).click()});let r=document.getElementById("hours");r&&(r.onchange=()=>{c.analyticsHours=r.value,p()}),document.querySelectorAll("tr[data-detail]").forEach(i=>i.onclick=()=>{let n=JSON.parse(i.dataset.detail);alert(JSON.stringify(n,null,2))})}window.addEventListener("hashchange",()=>{let e=location.hash.replace("#/","");y.includes(e)&&(c.route=e,p())});c.route=y.includes(location.hash.replace("#/",""))?location.hash.replace("#/",""):"overview";p();
