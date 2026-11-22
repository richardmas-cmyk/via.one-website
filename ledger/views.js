// Build Ledger HTML views. Server-rendered so every page reads without JavaScript;
// the browser script (client.js) adds search, keys, text size, theme and Read aloud.

const fs = require('fs');
const path = require('path');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CLIENT_JS = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');

const fmtDate = (iso, withTime) => {
  const d = new Date(iso);
  if (isNaN(d)) return esc(iso || '');
  const o = { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'America/New_York' };
  if (withTime) Object.assign(o, { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleString('en-GB', o).replace(',', '');
};

// Status = shape + word + colour, never colour alone.
const STATUS = {
  proposed: ['○', 'PROPOSED', 'st-prop'],
  built_flag_off: ['◐', 'BUILT, FLAG OFF', 'st-off'],
  staged: ['◇', 'STAGED', 'st-stg'],
  live: ['●', 'LIVE', 'st-live'],
  live_inferred: ['◍', 'LIVE (INFERRED)', 'st-inf'],
  rolled_back: ['↺', 'ROLLED BACK', 'st-rb'],
  retired: ['✕', 'RETIRED', 'st-ret'],
  abandoned: ['⊘', 'ABANDONED', 'st-ret'],
};
const statusKey = (cr) => (cr.current === 'live' && cr.live_proof === 'inferred' ? 'live_inferred' : cr.current);
const statusWords = (cr) => {
  const s = STATUS[statusKey(cr)] || ['?', cr.current, ''];
  return s[1] + (cr.current === 'live' && cr.live_proof === 'owner-confirmed' ? ' (OWNER-CONFIRMED)' : '') + (cr.current === 'staged' ? ' (LIMITED)' : '');
};
const badge = (cr) => {
  const s = STATUS[statusKey(cr)] || ['?', cr.current, ''];
  return `<span class="st ${s[2]}"><span aria-hidden="true">${s[0]}</span> ${esc(statusWords(cr))}</span>`;
};
const badgeFor = (status) => {
  const s = STATUS[status] || ['?', status, ''];
  return `<span class="st ${s[2]}"><span aria-hidden="true">${s[0]}</span> ${esc(s[1])}</span>`;
};
const showVal = (v) => (Array.isArray(v) ? v.join(' · ') : v == null || v === '' ? '(empty)' : String(v));
const actorWord = (a) => (a && a.kind === 'owner' ? 'you' : a && a.kind === 'system' ? 'system' : 'Claude');
const KIND = {
  build: 'BUILD', modify: 'MODIFY', remove: 'REMOVE', config_flag: 'CONFIG FLAG', incident_fix: 'INCIDENT FIX', doc: 'DOC', revert: 'REVERT',
};
const kindChip = (k) => `<span class="kd kd-${esc(k)}">${k === 'remove' ? '<span aria-hidden="true">✕ </span>' : ''}${esc(KIND[k] || k)}</span>`;

const CSS = `
@font-face{font-family:"Atkinson Hyperlegible";font-weight:400;font-display:swap;src:url(/fonts/atkinson-hyperlegible-latin-400-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Atkinson Hyperlegible";font-weight:700;font-display:swap;src:url(/fonts/atkinson-hyperlegible-latin-700-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Atkinson Hyperlegible";font-weight:400;font-display:swap;src:url(/fonts/atkinson-hyperlegible-latin-ext-400-normal.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Atkinson Hyperlegible";font-weight:700;font-display:swap;src:url(/fonts/atkinson-hyperlegible-latin-ext-700-normal.woff2) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
:root{--bg:#FAFAF7;--card:#FFFFFF;--ink:#111111;--dim:#2E2E2E;--line:#111111;--soft:#9A9A92;--bar:#0A1628;--bar-ink:#FFFFFF;--link:#0B3FB0;
--live:#0F6B30;--off:#8A4500;--stg:#5B2A9E;--prop:#2E2E2E;--rb:#B3001B;--ret:#4A4A4A;--inf:#0F5A6B;--add:#0F6B30;--rem:#B3001B;--hl:#FFE27A;--hlink:#111}
:root[data-theme=dark]{--bg:#121212;--card:#1C1C1C;--ink:#EDEDE6;--dim:#D4D4CC;--line:#EDEDE6;--soft:#6A6A64;--bar:#0A1628;--link:#9CC0FF;
--live:#4ADE80;--off:#FBBF24;--stg:#C4A5FF;--prop:#D4D4CC;--rb:#FF6B6B;--ret:#BDBDB5;--inf:#67E8F9;--add:#4ADE80;--rem:#FF8A8A;--hl:#5A4A00;--hlink:#EDEDE6;color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#121212;--card:#1C1C1C;--ink:#EDEDE6;--dim:#D4D4CC;--line:#EDEDE6;--soft:#6A6A64;--link:#9CC0FF;
--live:#4ADE80;--off:#FBBF24;--stg:#C4A5FF;--prop:#D4D4CC;--rb:#FF6B6B;--ret:#BDBDB5;--inf:#67E8F9;--add:#4ADE80;--rem:#FF8A8A;--hl:#5A4A00;--hlink:#EDEDE6;color-scheme:dark}}
html{font-size:calc(20px * var(--scale,1))}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:400 1rem/1.5 "Atkinson Hyperlegible",system-ui,-apple-system,"Segoe UI",sans-serif}
.skip{position:absolute;left:-999px;top:0;background:var(--hl);color:var(--hlink);padding:12px 18px;font-weight:700;z-index:9}
.skip:focus{left:8px;top:8px}
header.top{background:var(--bar);color:var(--bar-ink);border-bottom:3px solid var(--soft)}
.in{max-width:62rem;margin:0 auto;padding:0 max(16px,env(safe-area-inset-left,0px))}
header.top .in{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;justify-content:space-between;padding-block:12px}
header.top a,header.top button{color:var(--bar-ink)}
.brand{font-weight:700;font-size:1.2rem;text-decoration:none;letter-spacing:.04em}
nav.main{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center}
nav.main a{font-weight:700;text-underline-offset:4px;padding:8px 2px;min-height:44px;display:inline-flex;align-items:center}
nav.main a[aria-current=page]{text-decoration-thickness:3px}
.tools{display:flex;flex-wrap:wrap;gap:8px}
button,.btn{font:700 .95rem/1.2 "Atkinson Hyperlegible",system-ui,sans-serif;min-height:44px;min-width:44px;border:2px solid var(--line);border-radius:8px;padding:9px 14px;background:var(--card);color:var(--ink);cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
header.top button{background:transparent;border-color:var(--bar-ink)}
button.primary,.btn.primary{background:var(--ink);color:var(--bg)}
:focus-visible{outline:4px solid #F2A900;outline-offset:3px}
main.in{padding-block:24px 70px;display:flex;flex-direction:column;gap:24px}
h1{font-size:2rem;line-height:1.15;margin:0;font-weight:700}
h2{font-size:1.4rem;line-height:1.2;margin:0;font-weight:700}
h3{font-size:1.1rem;margin:0;font-weight:700}
p{margin:0;max-width:70ch}
a{color:var(--link);font-weight:700;text-underline-offset:3px}
.dim{color:var(--dim)}
.card{background:var(--card);border:2px solid var(--line);border-radius:10px;padding:18px 20px;display:flex;flex-direction:column;gap:12px}
.row{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,17rem),1fr))}
.st{font-weight:700;border:2px solid currentColor;border-radius:6px;padding:1px 8px;display:inline-block}
.st-live{color:var(--live)}.st-off{color:var(--off)}.st-stg{color:var(--stg)}.st-prop{color:var(--prop)}.st-rb{color:var(--rb)}.st-ret{color:var(--ret)}.st-inf{color:var(--inf);border-style:dashed}
.kd{font-weight:700;letter-spacing:.05em;font-size:.85rem;border:2px solid var(--line);border-radius:4px;padding:1px 6px;white-space:nowrap}
.kd-remove{text-decoration:line-through;text-decoration-thickness:2px}
.banner{border:3px solid var(--live);color:var(--ink);border-radius:10px;padding:10px 16px;font-weight:700}
.banner.bad{border-color:var(--rb);color:var(--rb)}
label.big{font-weight:700;font-size:1.1rem;display:flex;flex-direction:column;gap:6px}
input[type=search]{font:700 1.3rem/1.3 "Atkinson Hyperlegible",system-ui,sans-serif;width:100%;padding:14px 16px;border:3px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink)}
select{font:700 .95rem "Atkinson Hyperlegible",system-ui,sans-serif;min-height:44px;padding:6px 10px;border:2px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
ol.list,ul.list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.item{background:var(--card);border:2px solid var(--line);border-radius:10px;padding:12px 16px;display:flex;flex-direction:column;gap:6px}
.item.sel{outline:4px solid #F2A900;outline-offset:2px}
.item .t{font-weight:700;font-size:1.1rem}
.meta{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.tally{font-weight:700;font-size:1.1rem}
.now{font-size:1.25rem;font-weight:700;display:flex;flex-direction:column;gap:6px}
.frame{border:3px solid var(--line);border-radius:10px;overflow:hidden;background:#fff;height:70vh}
.frame iframe{border:0;width:100%;height:100%;transform-origin:0 0}
.plus{color:var(--add);font-weight:700}.minus{color:var(--rem);font-weight:700}
dl.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:8px 18px;margin:0}
@media (max-width:640px){dl.kv{grid-template-columns:minmax(0,1fr)}}
[hidden]{display:none!important}
.grid.list{display:grid}
main,dd,p,li,.mono{overflow-wrap:anywhere}
dl.kv dt{font-weight:700}dl.kv dd{margin:0}
details>summary{cursor:pointer;font-weight:700;min-height:44px;display:flex;align-items:center}
code,.mono{font-family:ui-monospace,Menlo,monospace;font-size:.9em}
.speaking{background:var(--hl);color:var(--hlink)}
#help{position:fixed;inset:10% 10% auto;max-width:34rem;margin:auto;z-index:10;box-shadow:0 0 0 100vmax rgba(0,0,0,.55)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.timeline li{border-left:6px solid var(--line);padding-left:12px}
.diff li{list-style:none;padding:6px 10px;border-radius:6px;margin:4px 0}.diff .add{border-left:6px solid var(--add)}.diff .del{border-left:6px solid var(--rem);text-decoration:line-through;text-decoration-thickness:2px}
.diff .same{color:var(--dim)}
.pair{display:grid;gap:12px;grid-template-columns:1fr 1fr}@media (max-width:800px){.pair{grid-template-columns:1fr}}
.overlay{position:relative;height:70vh;border:3px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}
.overlay iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
input[type=range]{width:100%;min-height:44px}
textarea,input[type=text],input[type=date]{font:400 1rem/1.4 "Atkinson Hyperlegible",system-ui,sans-serif;width:100%;padding:10px 12px;border:2px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
form.stack{display:flex;flex-direction:column;gap:12px}form.stack label{font-weight:700;display:flex;flex-direction:column;gap:4px}
table.mx{border-collapse:collapse;width:100%}table.mx th,table.mx td{overflow-wrap:normal;word-break:normal;hyphens:none}table.mx th,table.mx td{border:2px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
.needs li{border-left:8px solid var(--off)}.needs li.bad{border-left-color:var(--rb)}
@media print{header.top,.tools,.noprint,nav.main,.skip,#help{display:none!important}body{background:#fff;color:#000}.card,.item{break-inside:avoid;border-color:#000}a{color:#000;text-decoration:none}main.in{max-width:none}}
.tag{font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-size:.85rem;color:var(--dim)}
@media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
`;

function shell({ title, body, nonce, active, chain, lang = 'en', inboxCount = 0, partner = false, flash = null }) {
  const nav = partner ? '' : [['home', '/library/ledger', 'Home'], ['products', '/library/ledger/products', 'Products'], ['audit', '/library/ledger/audit', 'Audit'],
    ['inbox', '/library/ledger/inbox', `Inbox${inboxCount ? ` (${inboxCount})` : ''}`], ['shares', '/library/ledger/shares', 'Shares'], ['library', '/library', 'Library']]
    .map(([k, href, label]) => `<a href="${href}"${active === k ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  const banner = chain ? (chain.ok
    ? `<p class="banner" role="status"><span aria-hidden="true">✓</span> Chain verified: ${chain.count} ${chain.count === 1 ? 'entry' : 'entries'}, head <span class="mono">${esc(chain.head.slice(7, 15))}</span></p>`
    : `<p class="banner bad" role="alert"><span aria-hidden="true">✕</span> CHAIN BROKEN at entry ${chain.brokenAt}${chain.anchorProblem ? ` (${esc(chain.anchorProblem)})` : ''}. The ledger is read-only until this is reviewed.</p>`) : '';
  const flashHtml = flash ? `<p class="banner${flash.bad ? ' bad' : ''}" role="${flash.bad ? 'alert' : 'status'}"><span aria-hidden="true">${flash.bad ? '✕' : '✓'}</span> ${esc(flash.text)}</p>` : '';
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><link rel="icon" href="/favicon.png">
<script nonce="${nonce}">(function(){try{var s=localStorage.getItem('bl.scale');if(s)document.documentElement.style.setProperty('--scale',s);var t=localStorage.getItem('bl.theme');if(t)document.documentElement.setAttribute('data-theme',t)}catch(e){}})();</script>
<style>${CSS}</style></head><body>
<a class="skip" href="#main">Skip to content</a>
<header class="top"><div class="in">${partner ? '<span class="brand">VIA ONE</span>' : '<a class="brand" href="/library/ledger">BUILD LEDGER</a>'}
${nav ? `<nav class="main" aria-label="Main">${nav}</nav>` : ''}
<div class="tools" role="group" aria-label="Reading tools">
<button type="button" data-act="smaller" aria-label="Smaller text">A−</button><button type="button" data-act="bigger" aria-label="Bigger text">A+</button>
<button type="button" data-act="theme" aria-label="Switch light or dark">◐ Theme</button>
<button type="button" data-act="read" aria-label="Read this page aloud">▶ Read</button>
<button type="button" data-act="voice" aria-label="Reading voice language">EN</button>
<button type="button" data-act="help" aria-label="Keyboard shortcuts">?</button></div></div></header>
<main id="main" class="in" tabindex="-1">${flashHtml}${banner}${body}</main>
<div id="help" class="card" role="dialog" aria-modal="true" aria-labelledby="help-h" hidden><h2 id="help-h">Keyboard shortcuts</h2>
<dl class="kv"><dt>/</dt><dd>Search</dd><dt>j / k</dt><dd>Next / previous item</dd><dt>Enter</dt><dd>Open the selected item</dd>
<dt>[ / ]</dt><dd>Previous / next flow version</dd><dt>c</dt><dd>Compare versions (feature page)</dd><dt>a e m d</dt><dd>Inbox: accept, edit, merge, discard</dd><dt>r</dt><dd>Read aloud (again stops)</dd><dt>+ / −</dt><dd>Bigger / smaller text</dd><dt>g h</dt><dd>Home</dd><dt>?</dt><dd>This list</dd><dt>Esc</dt><dd>Close / stop</dd></dl>
<div><button type="button" class="primary" data-act="help-close">Close</button></div></div>
<script nonce="${nonce}">${CLIENT_JS}</script></body></html>`;
}

// ---------- pieces ----------
function crItem(cr, products, features) {
  const prod = products.find((p) => p.slug === cr.product_line);
  const feats = (cr.features || []).map((f) => features.get(f)).filter(Boolean);
  return `<li class="item" data-nav><div class="meta"><a class="t" href="/library/ledger/cr/${esc(cr.cr_id)}">${esc(cr.cr_id)} · ${esc(cr.title)}</a></div>
<div class="meta">${kindChip(cr.kind)} ${badge(cr)} <span>${fmtDate(cr.date)}</span>
<span class="dim">${esc(prod ? prod.name_en : cr.product_line)}${feats.length ? ` › ${feats.map((f) => esc(f.name_en)).join(', ')}` : ''}</span>
${cr.provenance && cr.provenance.source === 'backfill' ? `<span class="tag">Backfilled · ${esc(cr.provenance.confidence)} confidence</span>` : ''}</div>
<p data-read>${esc(cr.summary_plain)}</p></li>`;
}

function tally(crs, versions) {
  const n = {};
  for (const cr of crs) n[cr.kind] = (n[cr.kind] || 0) + 1;
  const parts = ['build', 'modify', 'remove', 'config_flag', 'incident_fix', 'revert', 'doc'].filter((k) => n[k]).map((k) => `${n[k]} ${KIND[k].toLowerCase()}`);
  if (versions != null) parts.push(`${versions} flow ${versions === 1 ? 'version' : 'versions'}`);
  return `<p class="tally" data-read>Tally: ${crs.length} ${crs.length === 1 ? 'change' : 'changes'}${parts.length ? ` — ${parts.join(' · ')}` : ''}</p>`;
}

// Live / next flow version for a feature, from the CRs that produced flow artifacts.
function featureState(feature, crs, libItem) {
  const mine = crs.filter((cr) => (cr.features || []).includes(feature.slug)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const flowSlug = feature.flow_artifact_slug;
  let live = null; let next = null;
  for (const cr of mine) {
    for (const a of cr.artifacts || []) {
      if (a.role !== 'flow' || a.library_slug !== flowSlug) continue;
      if (cr.current === 'live' && (!live || a.version > live.v)) live = { v: a.version, cr };
      if (['built_flag_off', 'staged', 'proposed'].includes(cr.current) && (!next || a.version > next.v)) next = { v: a.version, cr };
    }
  }
  if (next && live && next.v <= live.v) next = null;
  const retiredBy = mine.find((cr) => cr.kind === 'remove' && cr.removes_feature && cr.current === 'live');
  const versions = libItem ? libItem.versions.length : 0;
  return { mine, live, next, retiredBy, versions };
}

function featureLine(f, st) {
  const parts = [];
  if (st.retiredBy) parts.push(badgeFor('retired'));
  else {
    if (st.live) parts.push(`${badge(st.live.cr)} v${st.live.v}`);
    if (st.next) parts.push(`${badge(st.next.cr)} v${st.next.v}`);
    if (!st.live && !st.next && st.mine[0]) parts.push(badge(st.mine[0]));
  }
  return `<li class="item" data-nav><a class="t" href="/library/ledger/f/${esc(f.slug)}">${esc(f.name_en)}</a>
<div class="meta">${parts.join(' ')}<span class="dim">${esc(f.name_es)}</span><span class="dim">${st.mine.length} ${st.mine.length === 1 ? 'change' : 'changes'}</span></div></li>`;
}

// ---------- pages ----------
function homePage({ products, crs, features, chain, needsHtml = '' }) {
  const list = [...crs.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const weekAgo = Date.now() - 7 * 864e5;
  const week = list.filter((cr) => Date.parse(cr.date) >= weekAgo);
  const tiles = products.map((p) => {
    const mine = list.filter((cr) => cr.product_line === p.slug);
    const live = mine.filter((cr) => cr.current === 'live').length;
    const off = mine.filter((cr) => ['built_flag_off', 'staged'].includes(cr.current)).length;
    return `<li class="item" data-nav><a class="t" href="/library/ledger/p/${esc(p.slug)}">${esc(p.name_en)}</a>
<span class="dim">${esc(p.name_es)}</span><div class="meta"><b>${mine.length} ${mine.length === 1 ? 'change' : 'changes'}</b>
${live ? `<span class="st st-live"><span aria-hidden="true">●</span> ${live} LIVE</span>` : ''}${off ? `<span class="st st-off"><span aria-hidden="true">◐</span> ${off} NOT FULLY ON</span>` : ''}</div></li>`;
  }).join('');
  const opt = (v, l) => `<option value="${esc(v)}">${esc(l)}</option>`;
  return {
    title: 'Build Ledger · Via One',
    body: `<h1>Build Ledger</h1>
<p data-read>Every build, change and removal, by product. Type a product or feature in English or Spanish, a CR number, a commit or a flag name.</p>
<form role="search" id="search-form"><label class="big" for="q">Search</label>
<input id="q" type="search" autocomplete="off" spellcheck="false" placeholder="gift card, cheque, SPEI, CR-0003…" aria-describedby="also"></form>
<p id="also" class="dim" aria-live="polite"></p>
<div class="row" role="group" aria-label="Filters">
<label>Product <select id="f-product">${opt('', 'All')}${products.map((p) => opt(p.slug, p.name_en)).join('')}</select></label>
<label>Kind <select id="f-kind">${opt('', 'All')}${Object.entries(KIND).map(([k, l]) => opt(k, l)).join('')}</select></label>
<label>Status <select id="f-status">${opt('', 'All')}${Object.entries(STATUS).map(([k, s]) => opt(k, `${s[0]} ${s[1]}`)).join('')}</select></label></div>
<p id="count" class="sr" aria-live="polite"></p>
<div id="results" hidden></div>
<div id="dash">${needsHtml}
<section aria-labelledby="h-week"><h2 id="h-week">This week (${week.length})</h2>
${week.length ? `<ol class="list">${week.map((cr) => crItem(cr, products, features)).join('')}</ol>` : '<p class="dim">No changes recorded in the last 7 days.</p>'}</section>
<section aria-labelledby="h-prod" style="margin-top:24px"><h2 id="h-prod">Product lines</h2><ul class="grid list" style="margin-top:12px">${tiles}</ul></section>
<section aria-labelledby="h-all" style="margin-top:24px"><h2 id="h-all">All changes (${list.length})</h2>
<ol class="list" style="margin-top:12px">${list.map((cr) => crItem(cr, products, features)).join('')}</ol></section></div>`,
    active: 'home', chain,
  };
}

function productsPage({ products, crs }) {
  const list = [...crs.values()];
  return {
    title: 'Products · Build Ledger',
    body: `<h1>Product lines</h1><ul class="list">${products.map((p) => {
      const mine = list.filter((cr) => cr.product_line === p.slug);
      return `<li class="item" data-nav><a class="t" href="/library/ledger/p/${esc(p.slug)}">${esc(p.name_en)}</a><span class="dim">${esc(p.name_es)}${p.aliases && p.aliases.length ? ` · also: ${esc(p.aliases.join(', '))}` : ''}</span>${tally(mine)}</li>`;
    }).join('')}</ul>`,
    active: 'products',
  };
}

function productPage({ product, crs, features, libItems, products, chain }) {
  const mine = [...crs.values()].filter((cr) => cr.product_line === product.slug).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const feats = [...features.values()].filter((f) => f.product_line === product.slug).map((f) => [f, featureState(f, [...crs.values()], libItems.find((i) => i.slug === f.flow_artifact_slug))]);
  const active = feats.filter(([, st]) => !st.retiredBy);
  const retired = feats.filter(([, st]) => st.retiredBy);
  return {
    title: `${product.name_en} · Build Ledger`,
    body: `<nav aria-label="Breadcrumb" class="dim"><a href="/library/ledger/products">Products</a> › ${esc(product.name_en)}</nav>
<div><p class="tag">Product line</p><h1>${esc(product.name_en)}</h1><p class="dim">${esc(product.name_es)}${product.aliases && product.aliases.length ? ` · also: ${esc(product.aliases.join(', '))}` : ''}</p></div>
${product.summary ? `<p data-read>${esc(product.summary)}</p>` : ''}
${tally(mine)}
<section aria-labelledby="h-f"><h2 id="h-f">Features (${active.length})</h2>
${active.length ? `<ul class="list" style="margin-top:12px">${active.map(([f, st]) => featureLine(f, st)).join('')}</ul>` : '<p class="dim">No features recorded yet.</p>'}</section>
<section aria-labelledby="h-c"><h2 id="h-c">Changes (${mine.length})</h2>
${mine.length ? `<ol class="list" style="margin-top:12px">${mine.map((cr) => crItem(cr, products, features)).join('')}</ol>` : '<p class="dim">No changes recorded yet.</p>'}</section>
${retired.length ? `<details><summary>Retired features (${retired.length})</summary><ul class="list">${retired.map(([f, st]) => featureLine(f, st)).join('')}</ul></details>` : ''}`,
    active: 'products', chain,
  };
}

function featurePage({ feature, product, crs, features, libItem, products, chain, showV, stepsText, extra = '' }) {
  const st = featureState(feature, [...crs.values()], libItem);
  const versions = libItem ? libItem.versions.map((v) => v.v) : [];
  const shown = showV && versions.includes(showV) ? showV : st.live ? st.live.v : st.next ? st.next.v : versions[versions.length - 1];
  const verCr = new Map();
  for (const cr of st.mine) for (const a of cr.artifacts || []) if (a.library_slug === feature.flow_artifact_slug) verCr.set(a.version, cr);
  const creator = crs.get(feature.created_by_cr);
  const describe = feature.summary || (creator && creator.summary_plain) || '';
  const groups = {
    live: st.mine.filter((cr) => cr.current === 'live' && !(cr.kind === 'remove')),
    off: st.mine.filter((cr) => ['built_flag_off', 'staged', 'proposed'].includes(cr.current)),
    gone: st.mine.filter((cr) => cr.kind === 'remove' || ['rolled_back', 'retired'].includes(cr.current)),
  };
  const mini = (arr) => (arr.length ? `<ul>${arr.map((cr) => `<li><a href="/library/ledger/cr/${esc(cr.cr_id)}">${esc(cr.title)}</a> (${esc(cr.cr_id)})</li>`).join('')}</ul>` : '<p class="dim">None.</p>');
  return {
    title: `${feature.name_en} · Build Ledger`,
    body: `<nav aria-label="Breadcrumb" class="dim"><a href="/library/ledger/p/${esc(product.slug)}">${esc(product.name_en)}</a> › ${esc(feature.name_en)}</nav>
<div><p class="tag">Feature · ${esc(feature.type)}</p><h1>${esc(feature.name_en)}</h1><p class="dim">${esc(feature.name_es)}</p></div>
<div class="card now" data-read>
${st.retiredBy ? `<p>NOW: ${badgeFor('retired')} by <a href="/library/ledger/cr/${esc(st.retiredBy.cr_id)}">${esc(st.retiredBy.cr_id)}</a></p>` : `
<p>NOW: ${st.live ? `${badge(st.live.cr)} flow v${st.live.v} — since ${fmtDate(st.live.cr.date)} (<a href="/library/ledger/cr/${esc(st.live.cr.cr_id)}">${esc(st.live.cr.cr_id)}</a>)` : st.mine[0] ? 'Not live yet' : 'nothing recorded'}</p>
${st.next ? `<p>NEXT: ${badge(st.next.cr)} flow v${st.next.v} (<a href="/library/ledger/cr/${esc(st.next.cr.cr_id)}">${esc(st.next.cr.cr_id)}</a>)</p>` : ''}`}
${describe ? `<p style="font-weight:400">“${esc(describe)}”</p>` : ''}</div>
${versions.length ? `<section aria-labelledby="h-flow"><h2 id="h-flow">Flow page — version ${shown} of ${versions.length}</h2>
<div class="row" style="margin-top:10px">${versions.slice().reverse().map((v) => {
      const cr = verCr.get(v);
      return `<a class="btn${v === shown ? ' primary' : ''}" ${v === shown ? 'aria-current="true"' : ''} data-ver="${v}" href="?v=${v}">v${v}${cr ? ` · ${esc(statusWords(cr))}` : ''}</a>`;
    }).join('')}
<a class="btn" href="/library/${esc(feature.flow_artifact_slug)}/v${shown}" target="_blank" rel="noopener">Open full page ↗</a>
${versions.length > 1 ? `<a class="btn" id="compare-link" href="/library/ledger/f/${esc(feature.slug)}/compare?a=${shown > versions[0] ? shown - 1 : shown}&b=${shown > versions[0] ? shown : versions[1]}">Compare ⇄</a>` : ''}
<button type="button" data-act="zoom-out" aria-label="Zoom flow out">−</button><button type="button" data-act="zoom-in" aria-label="Zoom flow in">+</button></div>
<div class="frame" style="margin-top:12px"><iframe id="flow" title="${esc(feature.name_en)} flow page version ${shown}" src="/library/${esc(feature.flow_artifact_slug)}/v${shown}?embed=1" sandbox="allow-scripts allow-popups"></iframe></div>
${stepsText && stepsText.length ? `<details style="margin-top:10px"><summary>Steps as text (version ${shown})</summary><ol data-read>${stepsText.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></details>` : ''}
</section>` : feature.flow_artifact_slug ? `<p class="card">⚠ No flow page has been uploaded yet for <span class="mono">${esc(feature.flow_artifact_slug)}</span>.</p>` : ''}
<div class="grid">
<section class="card" aria-labelledby="h-l"><h2 id="h-l"><span aria-hidden="true">●</span> What's live (${groups.live.length})</h2>${mini(groups.live)}</section>
<section class="card" aria-labelledby="h-o"><h2 id="h-o"><span aria-hidden="true">◐</span> Not fully live yet (${groups.off.length})</h2>${mini(groups.off)}</section>
<section class="card" aria-labelledby="h-g"><h2 id="h-g"><span aria-hidden="true">✕</span> Removed or rolled back (${groups.gone.length})</h2>${mini(groups.gone)}</section></div>
${extra}
${tally(st.mine, libItem ? versions.length : null)}
<section aria-labelledby="h-t"><h2 id="h-t">Timeline (newest first)</h2>
<ol class="list timeline" style="margin-top:12px">${st.mine.map((cr) => {
      const vs = (cr.artifacts || []).filter((a) => a.library_slug === feature.flow_artifact_slug).map((a) => `v${a.version}`);
      return `<li class="item" data-nav><div class="meta">${vs.length ? `<b>${vs.join(', ')}</b>` : ''} ${badge(cr)} <span>${fmtDate(cr.date)}</span> ${kindChip(cr.kind)}</div>
<a class="t" href="/library/ledger/cr/${esc(cr.cr_id)}">${esc(cr.title)} — ${esc(cr.cr_id)}</a></li>`;
    }).join('')}</ol></section>`,
    active: 'products', chain,
  };
}

function crPage({ cr, product, features, chain, libItems, extra = '' }) {
  const feats = (cr.features || []).map((f) => features.get(f)).filter(Boolean);
  const ev = cr.evidence || {};
  const repos = ev.repos || [];
  const commits = repos.reduce((n, r) => n + r.commits.length, 0);
  const files = repos.reduce((n, r) => n + ((r.diffstat && r.diffstat.files) || (r.files_touched || []).length || 0), 0);
  const ins = repos.reduce((n, r) => n + ((r.diffstat && r.diffstat.insertions) || 0), 0);
  const del = repos.reduce((n, r) => n + ((r.diffstat && r.diffstat.deletions) || 0), 0);
  const tests = ev.tests;
  return {
    title: `${cr.cr_id} ${cr.title} · Build Ledger`,
    body: `<nav aria-label="Breadcrumb" class="dim"><a href="/library/ledger/p/${esc(product ? product.slug : '')}">${esc(product ? product.name_en : cr.product_line)}</a>${feats.map((f) => ` › <a href="/library/ledger/f/${esc(f.slug)}">${esc(f.name_en)}</a>`).join(',')}</nav>
<div><p class="tag">${esc(cr.cr_id)} · Change record</p><h1 data-read>${esc(cr.title)}</h1></div>
<div class="meta" data-read>${kindChip(cr.kind)} ${badge(cr)}${cr.risk ? `<span>Risk: <b>${esc(cr.risk.toUpperCase())}</b></span>` : ''}${cr.user_impact ? `<span>Impact: <b>${esc(cr.user_impact.toUpperCase())}</b></span>` : ''}
<span>${fmtDate(cr.date, true)}</span><span class="dim">${cr.provenance && cr.provenance.source === 'backfill' ? `Backfilled (${esc(cr.provenance.confidence)} confidence)` : 'Claude Code session'}</span></div>
<section class="card" aria-labelledby="h-pw"><h2 id="h-pw">In plain words</h2><p data-read style="font-size:1.1rem;font-weight:700">${esc(cr.summary_plain)}</p>
${cr.why ? `<p data-read><b>Why:</b> ${esc(cr.why)}</p>` : ''}</section>
${(cr.what_changed || []).length || (cr.removed || []).length ? `<section class="card" aria-labelledby="h-wc"><h2 id="h-wc">What changed</h2><ul class="list" data-read>
${(cr.what_changed || []).map((w) => `<li><span class="plus">+ ADDED</span> ${esc(w)}</li>`).join('')}
${(cr.removed || []).map((w) => `<li><span class="minus">− REMOVED</span> ${esc(w)}</li>`).join('')}</ul></section>` : ''}
${(() => { const kv = `${cr.rollback_plan ? `<dt>Rollback</dt><dd data-read>${esc(cr.rollback_plan)}</dd>` : ''}
${(cr.open_items || []).length ? `<dt>Open items</dt><dd><ul>${cr.open_items.map((o) => `<li>${esc(o)}</li>`).join('')}</ul></dd>` : ''}
${cr.reverts ? `<dt>Reverts</dt><dd><a href="/library/ledger/cr/${esc(cr.reverts)}">${esc(cr.reverts)}</a></dd>` : ''}
${(cr.related || []).length ? `<dt>Related</dt><dd>${cr.related.map((r) => `<a href="/library/ledger/cr/${esc(r)}">${esc(r)}</a>`).join(' · ')}</dd>` : ''}
${(cr.evidence && cr.evidence.flags || []).length ? `<dt>Flags</dt><dd>${cr.evidence.flags.map((f) => `<span class="mono">${esc(f.name)}</span>${f.env === 'code' ? ' <span class="dim">(setting read by the new code)</span>' : `${f.to != null ? ` → ${esc(f.to)}` : ''}${f.env ? ` (${esc(f.env)})` : ''}`}`).join('<br>')}</dd>` : ''}
${cr.override_reason ? `<dt>Path-map override</dt><dd>${esc(cr.override_reason)}</dd>` : ''}`; return kv.trim() ? `<dl class="kv card">${kv}</dl>` : ''; })()}
<section class="card" aria-labelledby="h-sh"><h2 id="h-sh">Status history</h2><ol class="list">${cr.history.map((h) => `<li>${badgeFor(h.to)}${h.from === 'live' && h.to === 'live' ? ' <b>confirmed</b>' : ''} ${fmtDate(h.at, true)} · by ${actorWord(h.actor)}${h.note && h.note !== 'recorded' ? ` · ${esc(h.note)}` : ''}${h.evidence && h.evidence.deploy_id ? ` · deploy <span class="mono">${esc(h.evidence.deploy_id)}</span>` : ''}</li>`).join('')}</ol>
${cr.current === 'live' && cr.live_proof === 'inferred' ? '<p class="dim">◍ “Live (inferred)” means the record says live but there is no deploy proof attached and you have not confirmed it.</p>' : ''}</section>
${extra}
${(cr.artifacts || []).length ? `<section class="card" aria-labelledby="h-pg"><h2 id="h-pg">Pages</h2><ul>${cr.artifacts.map((a) => {
      const li = libItems.find((i) => i.slug === a.library_slug);
      return `<li><a href="/library/${esc(a.library_slug)}/v${a.version}">${esc(li ? li.title : a.library_slug)} v${a.version}</a> <span class="dim">(${esc(a.role)})</span></li>`;
    }).join('')}</ul></section>` : ''}
${!(cr.artifacts || []).some((a) => a.role === 'flow') && ['build', 'modify', 'remove'].includes(cr.kind) && feats.some((f) => ['consumer-flow', 'partner-api'].includes(f.type)) ? '<p class="card">⚠ Flow page not updated by this change.</p>' : ''}
<details class="card"><summary>Evidence (filled in by the script): ${commits} ${commits === 1 ? 'commit' : 'commits'} · ${files} files · +${ins} / −${del} · ${(ev.flags || []).length} flags · ${(ev.migrations || []).length} migrations${tests ? ` · tests ${esc(tests.passed)} passed, ${esc(tests.failed || 0)} failed` : ''}</summary>
${repos.map((r) => `<h3 style="margin-top:10px">${esc(r.repo)}${r.branch ? ` · ${esc(r.branch)}` : ''}</h3><p class="mono">${r.commits.map(esc).join(' ')}</p>${(r.files_touched || []).length ? `<ul class="mono">${r.files_touched.slice(0, 60).map((f) => `<li>${esc(f)}</li>`).join('')}${r.files_touched.length > 60 ? `<li>… ${r.files_touched.length - 60} more</li>` : ''}</ul>` : ''}`).join('')}
${(ev.migrations || []).length ? `<h3>Migrations</h3><ul class="mono">${ev.migrations.map((m) => `<li>${esc(m.id)}${m.reversible === false ? ' (no down)' : ''}</li>`).join('')}</ul>` : ''}
${(ev.deploys || []).length ? `<h3>Deploys</h3><ul class="mono">${ev.deploys.map((d) => `<li>${esc(d.env || '')} ${esc(d.deploy_id || '')} ${esc(d.at || '')}</li>`).join('')}</ul>` : ''}
${tests ? `<p>Tests: <span class="mono">${esc(tests.command || '')}</span></p>` : ''}
${ev.no_code ? '<p>No code in this change.</p>' : ''}</details>
${cr.amendments.length ? `<section class="card" aria-labelledby="h-am"><h2 id="h-am">Amendments (${cr.amendments.length})</h2><ol class="list">${cr.amendments.map((a) => `<li class="item"><p><b>AMENDED</b> ${fmtDate(a.at, true)} by ${actorWord(a.actor)} — ${esc(a.reason)}</p>
<dl class="kv">${Object.keys(a.patch).map((k) => `<dt>${esc(k)}</dt><dd><span class="minus">was:</span> ${esc(showVal(a.original[k]))}<br><span class="plus">now:</span> ${esc(showVal(a.patch[k]))}</dd>`).join('')}</dl></li>`).join('')}</ol></section>` : ''}
${(cr.unlinked || []).length ? `<section class="card" aria-labelledby="h-ul"><h2 id="h-ul">Commits removed from this record</h2><ul>${cr.unlinked.map((u) => `<li><span class="mono">${u.commits.map((c) => esc(c.slice(0, 8))).join(' ')}</span> ${fmtDate(u.at, true)} by ${actorWord(u.actor)} — ${esc(u.note)}</li>`).join('')}</ul></section>` : ''}
${(cr.redactions || []).length ? `<section class="card" aria-labelledby="h-rd"><h2 id="h-rd">Redactions</h2><ul>${cr.redactions.map((r) => `<li><b>REDACTED</b> ${fmtDate(r.at, true)} by ${actorWord(r.actor)}: ${esc(r.fields.join(', '))} — ${esc(r.reason)}</li>`).join('')}</ul></section>` : ''}
<p class="dim">Integrity: entry ${cr.seq} · hash <span class="mono">${esc(cr.hash.slice(7, 19))}</span> · ${chain.ok ? '✓ chain verified' : '✕ chain broken'} · ${cr.amendments.length ? 'amended' : 'not amended'} · session <span class="mono">${esc(cr.session.session_id.slice(0, 13))}</span></p>`,
    active: 'products', chain,
  };
}

function notFound(what) {
  return { title: 'Not found · Build Ledger', body: `<h1>❌ Not found</h1><p>${esc(what)}</p><p><a href="/library/ledger">Back to the ledger</a></p>` };
}

module.exports = { shell, homePage, productsPage, productPage, featurePage, crPage, notFound, featureState, statusWords, statusKey, esc, KIND, STATUS,
  badge, badgeFor, kindChip, fmtDate, crItem, tally, actorWord, showVal };
