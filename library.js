// Via One Library: a private shelf of reference pages at /library.
//
// Pages (HTML) and their versions live on disk in LIBRARY_DIR (a Railway volume in
// production), never in this repository. Every version is kept, so an older one can
// always be opened again.
//
//   GET  /library                    list of pages                    [login]
//   GET  /library/<slug>             latest version of a page         [login]
//   GET  /library/<slug>/v<N>        one specific version             [login]
//   GET  /library/s/<token>          one version, for outside people  [link only]
//   POST /library/api/items          add a page or a new version      [upload token]
//   GET  /library/api/items          the list as JSON                 [upload token]
//   POST /library/api/revoke         kill a version's outside link    [upload token]
//
// Env: LIBRARY_SECRET (signs sessions and outside links), LIBRARY_LOGINS
// ("email|saltHex|scryptHex" entries separated by ";"), LIBRARY_UPLOAD_TOKEN,
// LIBRARY_DIR. Without LIBRARY_SECRET the whole library answers 503 (fails closed).

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DIR = process.env.LIBRARY_DIR || path.join(__dirname, 'library-data');
const SECRET = process.env.LIBRARY_SECRET || '';
const UPLOAD_TOKEN = process.env.LIBRARY_UPLOAD_TOKEN || '';
const COOKIE = 'vo_lib';
const SESSION_DAYS = 30;
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;

const logins = new Map(); // email -> { salt, hash }
for (const entry of String(process.env.LIBRARY_LOGINS || '').split(';')) {
  const [email, salt, hash] = entry.trim().split('|');
  if (email && /^[0-9a-f]{16,}$/i.test(salt || '') && /^[0-9a-f]{64,}$/i.test(hash || '')) {
    logins.set(email.toLowerCase(), { salt: Buffer.from(salt, 'hex'), hash: Buffer.from(hash, 'hex') });
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hmac = (text) => crypto.createHmac('sha256', SECRET).update(text).digest('base64url');
const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const niceDate = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  return isNaN(d) ? esc(iso) : d.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

// ---------- storage ----------
const manifestPath = () => path.join(DIR, 'index.json');
function readItems() {
  try { return JSON.parse(fs.readFileSync(manifestPath(), 'utf8')); } catch (e) { return []; }
}
function writeItems(items) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${manifestPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, manifestPath());
}
const filePath = (slug, v) => path.join(DIR, 'items', slug, `v${v}.html`);
const shareToken = (slug, ver) => hmac(`share:${slug}:${ver.v}:${ver.salt}`).slice(0, 26);
const latest = (item) => item.versions[item.versions.length - 1];
const publicItem = (item, base) => ({
  slug: item.slug, title: item.title, summary: item.summary, category: item.category,
  versions: item.versions.map((ver) => ({
    v: ver.v, date: ver.date, note: ver.note, bytes: ver.bytes,
    url: `${base}/library/${item.slug}/v${ver.v}`, shareUrl: `${base}/library/s/${shareToken(item.slug, ver)}`,
  })),
});

// ---------- sessions ----------
function sessionEmail(req) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [e, exp, sig] = m[1].split('.');
  if (!e || !exp || !sig || Number(exp) < Date.now()) return null;
  let email; try { email = Buffer.from(e, 'base64url').toString('utf8'); } catch (err) { return null; }
  if (!sameText(sig, hmac(`session:${email}:${exp}`)) || !logins.has(email)) return null;
  return email;
}
function setSession(res, email) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const value = `${Buffer.from(email).toString('base64url')}.${exp}.${hmac(`session:${email}:${exp}`)}`;
  res.cookie(COOKIE, value, { httpOnly: true, secure: process.env.NODE_ENV !== 'development', sameSite: 'lax', path: '/library', maxAge: SESSION_DAYS * 864e5 });
}
const attempts = new Map(); // ip -> timestamps of failed logins, max 8 per 15 minutes
setInterval(() => {
  const cutoff = Date.now() - 900e3;
  for (const [ip, ts] of attempts) if (!ts.some((t) => t > cutoff)) attempts.delete(ip);
}, 300e3).unref();

// ---------- pages ----------
const SHELL_CSS = `
:root{--bg:#F3F5F9;--card:#FFFFFF;--ink:#0A1628;--muted:#33415C;--line:#0A1628;--soft:#B8C2D6;--bar:#0A1628;--bar-ink:#FFFFFF;--link:#0B3FB0;--bad:#8E0F1B}
@media (prefers-color-scheme:dark){:root{--bg:#070E1A;--card:#101B30;--ink:#F2F5FB;--muted:#C3CDE0;--line:#F2F5FB;--soft:#3B4A69;--bar:#101B30;--bar-ink:#FFFFFF;--link:#9CC0FF;--bad:#FFA3AB;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:500 19px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{background:var(--bar);color:var(--bar-ink);border-bottom:2px solid var(--soft)}
.in{max-width:1000px;margin:0 auto;padding:0 max(16px,env(safe-area-inset-right,0px)) 0 max(16px,env(safe-area-inset-left,0px))}
header .in{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center;justify-content:space-between;padding-block:14px}
header img{height:34px;width:auto;display:block}
header b{font-size:1.25rem;font-weight:800}
.brand{display:flex;align-items:center;gap:14px}
main.in{padding-block:28px 60px;display:flex;flex-direction:column;gap:22px}
h1{font-size:clamp(1.9rem,5vw,2.6rem);font-weight:800;line-height:1.15;margin:0}
h2{font-size:1.45rem;font-weight:800;line-height:1.2;margin:0}
p{margin:0}
a{color:var(--link);font-weight:700;text-underline-offset:3px}
.muted{color:var(--muted)}
.tag{font-size:.9rem;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.card{background:var(--card);border:2px solid var(--line);border-radius:10px;padding:20px;display:flex;flex-direction:column;gap:14px}
.row{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center}
.btn,button{font:800 1.05rem/1.2 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;border:2px solid var(--line);border-radius:8px;padding:12px 18px;background:var(--ink);color:var(--bg);cursor:pointer;text-decoration:none;display:inline-block}
.btn.alt,button.alt{background:var(--card);color:var(--ink)}
header button{background:transparent;color:var(--bar-ink);border-color:var(--bar-ink);padding:8px 14px;font-size:1rem}
:focus-visible{outline:4px solid #F2A900;outline-offset:2px}
input{font:600 1.1rem/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;width:100%;padding:13px 14px;border:2px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
label{font-weight:800;display:flex;flex-direction:column;gap:6px}
.share{display:flex;flex-direction:column;gap:8px;border-top:2px solid var(--soft);padding-top:14px}
.share .row{flex-wrap:nowrap}
.share input{font-size:.95rem;min-width:0}
.share button{flex:none}
.older{margin:0;padding-left:1.2rem;display:flex;flex-direction:column;gap:6px}
.err{border:2px solid var(--bad);color:var(--bad);font-weight:800;border-radius:8px;padding:12px 14px}
form.login{max-width:460px}
`;
function shell({ title, body, nonce, signedIn }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><link rel="icon" href="/favicon.png"><style>${SHELL_CSS}</style></head><body>
<header><div class="in"><a class="brand" href="/library" style="color:inherit;text-decoration:none"><img src="/logo-light.png" alt="Via One"><b>Library</b></a>
${signedIn ? '<div class="row"><a class="btn alt" href="/library/ledger" style="padding:8px 14px;font-size:1rem">Build Ledger</a><form method="post" action="/library/logout"><button type="submit">Sign out</button></form></div>' : ''}</div></header>
<main class="in">${body}</main>${nonce ? `<script nonce="${nonce}">
document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;var f=document.getElementById(b.getAttribute('data-copy'));f.select();
var done=function(){b.textContent='\\u2705 Copied'};if(navigator.clipboard){navigator.clipboard.writeText(f.value).then(done,function(){document.execCommand('copy');done()})}else{document.execCommand('copy');done()}});
var q=document.getElementById('q');if(q)q.addEventListener('input',function(){var t=q.value.toLowerCase();document.querySelectorAll('[data-text]').forEach(function(c){c.hidden=c.getAttribute('data-text').indexOf(t)<0})});
</script>` : ''}</body></html>`;
}
function shellHeaders(res, nonce) {
  res.set({
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; script-src ${nonce ? `'nonce-${nonce}'` : "'none'"}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
}

function loginPage(res, { error, next, status = 200 }) {
  shellHeaders(res);
  res.status(status).send(shell({
    title: 'Sign in · Via One Library',
    body: `<h1>Sign in to the library</h1>
<p class="muted">Use your Via One email and password.</p>
${error ? `<p class="err" role="alert">❌ ${esc(error)}</p>` : ''}
<form class="card login" method="post" action="/library/login">
<input type="hidden" name="next" value="${esc(next || '')}">
<label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>
<label>Password<input type="password" name="password" autocomplete="current-password" required></label>
<div><button type="submit">Sign in</button></div></form>`,
  }));
}

function indexPage(req, res) {
  const base = `${req.protocol}://${req.get('host')}`;
  const items = readItems().slice().sort((a, b) => String(latest(b).date).localeCompare(String(latest(a).date)) || a.title.localeCompare(b.title));
  const nonce = crypto.randomBytes(16).toString('base64');
  const cards = items.map((item, i) => {
    const last = latest(item);
    const older = item.versions.slice(0, -1).reverse();
    return `<article class="card" data-text="${esc(`${item.title} ${item.category || ''} ${item.summary || ''}`.toLowerCase())}">
<div><p class="tag">${esc(item.category || 'General')}</p><h2>${esc(item.title)}</h2></div>
${item.summary ? `<p>${esc(item.summary)}</p>` : ''}
<div class="row"><a class="btn" href="/library/${esc(item.slug)}/v${last.v}">Open version ${last.v}</a>
<span class="muted"><b>${niceDate(last.date)}</b>${last.note ? ` · ${esc(last.note)}` : ''}</span></div>
${older.length ? `<div><p><b>Earlier versions</b></p><ul class="older">${older.map((ver) => `<li><a href="/library/${esc(item.slug)}/v${ver.v}">Version ${ver.v}</a> · ${niceDate(ver.date)}${ver.note ? ` · ${esc(ver.note)}` : ''}</li>`).join('')}</ul></div>` : ''}
<div class="share"><label for="s${i}">Link for people outside Via One (version ${last.v}, no sign-in needed)</label>
<div class="row"><input id="s${i}" readonly value="${esc(`${base}/library/s/${shareToken(item.slug, last)}`)}"><button type="button" class="alt" data-copy="s${i}">Copy link</button></div></div>
</article>`;
  }).join('');
  shellHeaders(res, nonce);
  res.send(shell({
    title: 'Via One Library', nonce, signedIn: true,
    body: `<h1>Library</h1>
<p class="muted">${items.length} ${items.length === 1 ? 'page' : 'pages'}. Every version is kept.</p>
${items.length > 6 ? '<label>Find a page<input id="q" type="search" autocomplete="off"></label>' : ''}
${cards || '<p class="card">Nothing here yet.</p>'}`,
  }));
}

// A stored page is either a full HTML document or a body fragment (how Claude writes
// artifact pages). Fragments get a document skeleton; signed-in readers get a slim bar.
function renderDoc(html, { title, bar }) {
  if (/^\s*(<!doctype|<html[\s>])/i.test(html)) {
    return bar ? html.replace(/<body[^>]*>/i, (m) => m + bar) : html;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow"><title>${esc(title)}</title><link rel="icon" href="/favicon.png"><style>*,*::before,*::after{box-sizing:border-box}body{margin:0}</style></head><body>${bar || ''}
${html}
</body></html>`;
}
function sendDoc(res, item, ver, { signedIn, embed }) {
  let html;
  try { html = fs.readFileSync(filePath(item.slug, ver.v), 'utf8'); } catch (e) { return false; }
  const A = 'color:#fff;font:inherit;text-decoration:underline;text-underline-offset:3px';
  const others = item.versions.filter((x) => x.v !== ver.v).map((x) => `<a style="${A}" href="/library/${esc(item.slug)}/v${x.v}">v${x.v}</a>`).join(' ');
  const bar = signedIn && !embed ? `<nav aria-label="Via One Library" style="all:initial;display:flex;flex-wrap:wrap;gap:6px 22px;align-items:center;padding:12px 16px;background:#0A1628;color:#fff;font:700 17px/1.35 system-ui,-apple-system,'Segoe UI',sans-serif">
<a style="${A}" href="/library">← Library</a><span style="font:inherit;color:#fff">${esc(item.title)} · version ${ver.v} of ${latest(item).v} · ${niceDate(ver.date)}</span>${others ? `<span style="font:inherit;color:#fff">Other versions: ${others}</span>` : ''}</nav>` : '';
  res.set({
    // The page runs in its own sandbox: it cannot read this site's cookies or storage.
    'Content-Security-Policy': 'sandbox allow-scripts allow-popups allow-forms',
    'Content-Type': 'text/html; charset=utf-8',
  });
  // Embedded in the ledger's compare view: report scroll position to the parent and
  // follow its scroll, so two versions side by side move together.
  const sync = embed ? `<script>(function(){var lock=0;function r(){var h=document.documentElement;return (h.scrollHeight-h.clientHeight)||1}
addEventListener('scroll',function(){if(lock){lock=0;return}parent.postMessage({bl:'scroll',y:scrollY/r()},'*')},{passive:true});
addEventListener('message',function(e){if(e.source===parent&&e.data&&e.data.bl==='scrollTo'){lock=1;scrollTo(0,e.data.y*r())}});})();</script>` : '';
  let doc = renderDoc(html, { title: `${item.title} v${ver.v} · Via One`, bar });
  if (sync) doc = /<\/body>/i.test(doc) ? doc.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${sync}</body>`) : doc + sync;
  res.send(doc);
  return true;
}

// ---------- routes ----------
module.exports = function mountLibrary(app) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    if (!SECRET) return res.status(503).type('text/plain').send('Library is not configured.');
    next();
  });

  // --- upload API (token) ---
  const api = express.Router();
  api.use((req, res, next) => {
    const sent = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!UPLOAD_TOKEN || !sent || !sameText(sent, UPLOAD_TOKEN)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    next();
  });
  api.get('/items', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, items: readItems().map((item) => publicItem(item, base)) });
  });
  api.post('/items', express.json({ limit: '20mb' }), (req, res) => {
    const b = req.body || {};
    const slug = String(b.slug || '').trim();
    const html = typeof b.html === 'string' ? b.html : '';
    if (!SLUG.test(slug)) return res.status(400).json({ ok: false, error: 'slug must be lowercase letters, numbers and dashes' });
    if (html.trim().length < 20) return res.status(400).json({ ok: false, error: 'html is required' });
    const items = readItems();
    let item = items.find((x) => x.slug === slug);
    if (!item) {
      if (!String(b.title || '').trim()) return res.status(400).json({ ok: false, error: 'title is required for a new page' });
      item = { slug, title: '', summary: '', category: '', versions: [] };
      items.push(item);
    }
    for (const k of ['title', 'summary', 'category']) if (typeof b[k] === 'string' && b[k].trim()) item[k] = b[k].trim().slice(0, k === 'summary' ? 400 : 120);
    const ver = {
      v: item.versions.length ? latest(item).v + 1 : 1,
      date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : todayET(),
      note: String(b.note || '').trim().slice(0, 200),
      salt: crypto.randomBytes(9).toString('base64url'),
      bytes: Buffer.byteLength(html),
    };
    fs.mkdirSync(path.dirname(filePath(slug, ver.v)), { recursive: true });
    fs.writeFileSync(filePath(slug, ver.v), html, { flag: 'wx' }); // never overwrites a stored version
    item.versions.push(ver);
    writeItems(items);
    const base = `${req.protocol}://${req.get('host')}`;
    console.log(`library: stored ${slug} v${ver.v} (${ver.bytes} bytes)`);
    res.json({ ok: true, slug, v: ver.v, url: `${base}/library/${slug}/v${ver.v}`, shareUrl: `${base}/library/s/${shareToken(slug, ver)}` });
  });
  // New salt => the old outside link stops working at once; the page itself stays.
  api.post('/revoke', express.json({ limit: '10kb' }), (req, res) => {
    const items = readItems();
    const item = items.find((x) => x.slug === String((req.body || {}).slug));
    const ver = item && item.versions.find((x) => x.v === Number(req.body.v));
    if (!ver) return res.status(404).json({ ok: false, error: 'no such page or version' });
    ver.salt = crypto.randomBytes(9).toString('base64url');
    writeItems(items);
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ ok: true, slug: item.slug, v: ver.v, shareUrl: `${base}/library/s/${shareToken(item.slug, ver)}` });
  });
  router.use('/api', api, (req, res) => res.status(404).json({ ok: false, error: 'not found' }));

  // --- outside link: one pinned version, no sign-in ---
  router.get('/s/:token', (req, res) => {
    for (const item of readItems()) {
      for (const ver of item.versions) {
        if (sameText(req.params.token, shareToken(item.slug, ver))) {
          if (sendDoc(res, item, ver, { signedIn: false })) return undefined;
        }
      }
    }
    // Unknown or revoked link: say so plainly instead of sending an outsider to the sign-in page.
    shellHeaders(res);
    res.status(404).send(shell({
      title: 'Link not active · Via One',
      body: '<h1>❌ This link is no longer active</h1><p class="muted">Ask the person who sent it to you for a new one.</p>',
    }));
    return undefined;
  });

  // --- sign in / out ---
  const safeNext = (v) => (/^\/library(\/[A-Za-z0-9/_-]*)?$/.test(String(v || '')) ? v : '/library');
  router.get('/login', (req, res) => {
    if (sessionEmail(req)) return res.redirect(302, '/library');
    loginPage(res, { next: safeNext(req.query.next) });
  });
  router.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
    const now = Date.now();
    const fails = (attempts.get(req.ip) || []).filter((t) => now - t < 900e3);
    const next = safeNext(req.body.next);
    if (fails.length >= 8) return loginPage(res, { status: 429, next, error: 'Too many tries. Wait 15 minutes and try again.' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const user = logins.get(email);
    // scrypt always runs, so a wrong email takes as long as a wrong password
    const got = crypto.scryptSync(String(req.body.password || ''), user ? user.salt : Buffer.alloc(16), user ? user.hash.length : 64);
    if (!user || !crypto.timingSafeEqual(got, user.hash)) {
      fails.push(now); attempts.set(req.ip, fails);
      return loginPage(res, { status: 401, next, error: 'That email and password did not match.' });
    }
    setSession(res, email);
    res.redirect(303, next);
  });
  router.post('/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/library' });
    res.redirect(303, '/library/login');
  });

  // --- everything below needs a session ---
  router.use((req, res, next) => {
    if (sessionEmail(req)) return next();
    if (req.method !== 'GET') return res.status(401).type('text/plain').send('Sign in first.');
    res.redirect(302, `/library/login${req.path !== '/' ? `?next=${encodeURIComponent(`/library${req.path}`)}` : ''}`);
  });
  router.get('/', indexPage);
  router.get('/:slug/:ver?', (req, res, next) => {
    const item = readItems().find((x) => x.slug === req.params.slug);
    if (!item) return next();
    const m = /^v(\d{1,4})$/.exec(req.params.ver || '');
    if (req.params.ver && !m) return next();
    const ver = m ? item.versions.find((x) => x.v === Number(m[1])) : latest(item);
    if (!ver || !sendDoc(res, item, ver, { signedIn: true, embed: req.query.embed === '1' })) return next();
    return undefined;
  });

  app.use('/library', router);
};

// Shared with the Build Ledger (ledger/index.js): same sign-in, same volume.
module.exports.DIR = DIR;
module.exports.readItems = readItems;
module.exports.filePath = filePath;
module.exports.sessionEmail = sessionEmail;
module.exports.sameText = sameText;
module.exports.configured = () => Boolean(SECRET);
module.exports.sendDoc = sendDoc;
module.exports.sign = (text) => hmac(`ledger:${text}`);
