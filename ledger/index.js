// Build Ledger routes, mounted beside the Library (same sign-in, same volume).
//
//   GET  /library/ledger                 home = search              [owner sign-in]
//   GET  /library/ledger/products        product lines              [owner sign-in]
//   GET  /library/ledger/p/<slug>        one product line + tally   [owner sign-in]
//   GET  /library/ledger/f/<slug>        feature "living spec"      [owner sign-in]
//   GET  /library/ledger/cr/<CR-NNNN>    change-record sheet        [owner sign-in]
//   GET  /library/ledger/search.json     search documents           [owner sign-in]
//   GET  /library/ledger/verify          chain check (JSON)         [owner sign-in]
//   POST /library/api/ledger/change      append a change record     [agent token]
//   POST /library/api/ledger/status      append a status event      [agent token]
//   POST /library/api/ledger/link        attach commits/pages later [agent token]
//   GET  /library/api/ledger/recorded    commits + pages already recorded
//   GET  /library/api/ledger/cr/<id>     one record (effective view)
//   GET  /library/api/ledger/registry    products, features, synonyms
//   PUT  /library/api/ledger/registry    replace products/synonyms (old copy kept)
//   GET  /library/api/ledger/verify      chain check
//
// Env: LEDGER_AGENT_TOKEN (append-only), LEDGER_DIR (default: beside LIBRARY_DIR).
// There is no edit or delete route. Owner actions (mark live, roll back, amend,
// redact), the backfill inbox, partner links, audit and compare live in owner.js.

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Ledger, LedgerError } = require('./store');
const V = require('./views');

const AGENT_TOKEN = process.env.LEDGER_AGENT_TOKEN || '';

const stripHtml = (html) => String(html || '')
  .replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();
function steps(html) {
  const out = [];
  const clean = String(html || '').replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, ' ');
  for (const m of clean.matchAll(/<(h[1-4]|li)[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = stripHtml(m[2]).slice(0, 200);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 120) break;
  }
  return out;
}

const DEFAULT_KIND_WORDS = {
  remove: ['remove', 'removed', 'delete', 'deleted', 'borrar', 'borrado', 'eliminar', 'eliminado', 'quitar', 'quitado'],
  build: ['new', 'build', 'built', 'nuevo', 'nueva', 'crear', 'creado'],
  modify: ['change', 'changed', 'cambio', 'edit', 'modificar', 'modificado'],
  incident_fix: ['bug', 'fix', 'fixed', 'arreglo', 'error', 'incident', 'incidente'],
  config_flag: ['flag', 'switch', 'bandera', 'interruptor'],
  revert: ['revert', 'reverted', 'undo', 'deshacer'],
};

module.exports = function mountLedger(app, lib) {
  const dir = process.env.LEDGER_DIR || path.join(path.dirname(lib.DIR), 'ledger');
  const ledger = new Ledger(dir);
  console.log(`ledger: ${ledger.chain.count} entries, chain ${ledger.chain.ok ? 'verified' : `BROKEN at ${ledger.chain.brokenAt}`}`);
  // Re-verify the whole chain every 6 hours (also on every boot).
  setInterval(() => ledger.verify(), 6 * 3600e3).unref();

  const send = (res, page, status = 200) => {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.set({
      'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    });
    res.status(status).send(V.shell({ ...page, nonce }));
  };
  const libItems = () => lib.readItems();
  const ctx = () => {
    const { crs, features } = ledger.state();
    return { crs, features, products: ledger.products(), chain: ledger.chain, libItems: libItems() };
  };

  // ---------- search documents (owner only, never outside links) ----------
  let cache = { key: '', value: null };
  const resetSearch = () => { cache.key = ''; };
  function searchDocs() {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(lib.DIR, 'index.json')).mtimeMs; } catch (e) { /* no library yet */ }
    const key = `${ledger.entries.length}:${mtime}`;
    if (cache.key === key) return cache.value;
    const { crs, features, products, libItems: items } = ctx();
    const all = [...crs.values()];
    const docs = [];
    const e = V.esc;
    for (const p of products) {
      const mine = all.filter((cr) => cr.product_line === p.slug);
      docs.push({ type: 'product', id: p.slug, url: `/library/ledger/p/${p.slug}`, product: p.slug, title: p.name_en, titleHtml: e(p.name_en),
        metaHtml: `<span class="dim">${e(p.name_es)}</span> <b>${mine.length} changes</b>`, names: [p.name_en, p.name_es, ...(p.aliases || [])].join(' '),
        summary: p.summary || '', summaryHtml: e(p.summary || ''), body: '', code: p.slug, tags: '' });
    }
    for (const f of features.values()) {
      const item = items.find((i) => i.slug === f.flow_artifact_slug);
      const st = V.featureState(f, all, item);
      const top = st.retiredBy ? null : (st.live || st.next || (st.mine[0] && { cr: st.mine[0] }));
      const prod = products.find((p) => p.slug === f.product_line);
      docs.push({ type: 'feature', id: f.slug, url: `/library/ledger/f/${f.slug}`, product: f.product_line, title: f.name_en, titleHtml: e(f.name_en),
        status: st.retiredBy ? 'retired' : top ? V.statusKey(top.cr) : '',
        metaHtml: `${st.retiredBy ? '<span class="st st-ret">✕ RETIRED</span>' : top ? `<span class="st">${e(V.statusWords(top.cr))}${top.v ? ` v${top.v}` : ''}</span>` : ''} <span class="dim">${e(prod ? prod.name_en : '')} · ${e(f.name_es)}</span>`,
        names: [f.name_en, f.name_es, ...(f.aliases || [])].join(' '), summary: f.summary || '', summaryHtml: e(f.summary || ''), body: '', code: [f.slug, f.flow_artifact_slug].join(' '), tags: f.type });
    }
    for (const cr of all) {
      const prod = products.find((p) => p.slug === cr.product_line);
      const feats = (cr.features || []).map((s) => features.get(s)).filter(Boolean);
      const ev = cr.evidence || {};
      const code = [cr.cr_id, ...(ev.repos || []).flatMap((r) => [...r.commits, ...(r.files_touched || []).flatMap((f) => [f, path.basename(f)])]),
        ...(ev.flags || []).map((x) => x.name), ...(ev.migrations || []).map((m) => m.id), ...(cr.artifacts || []).map((a) => a.library_slug)].join(' ');
      docs.push({ type: 'change', id: cr.cr_id, url: `/library/ledger/cr/${cr.cr_id}`, product: cr.product_line, kind: cr.kind, status: V.statusKey(cr), date: cr.date,
        title: cr.title, titleHtml: `${e(cr.cr_id)} · ${e(cr.title)}`,
        metaHtml: `<span class="kd">${e(V.KIND[cr.kind])}</span> <span class="st">${e(V.statusWords(cr))}</span> <span>${e(String(cr.date).slice(0, 10))}</span> <span class="dim">${e(prod ? prod.name_en : cr.product_line)}${feats.length ? ` › ${feats.map((f) => e(f.name_en)).join(', ')}` : ''}</span>`,
        names: [prod && prod.name_en, prod && prod.name_es, ...feats.flatMap((f) => [f.name_en, f.name_es, ...(f.aliases || [])])].filter(Boolean).join(' '),
        tags: [...(cr.tags || []), ...(cr.search_terms_es || [])].join(' '),
        summary: cr.summary_plain, summaryHtml: e(cr.summary_plain),
        body: [cr.why, ...(cr.what_changed || []), ...(cr.removed || []), ...(cr.open_items || []), cr.rollback_plan].filter(Boolean).join(' '), code });
    }
    for (const item of items) {
      let text = '';
      const last = item.versions[item.versions.length - 1];
      try { text = stripHtml(fs.readFileSync(lib.filePath(item.slug, last.v), 'utf8')).slice(0, 4000); } catch (err) { /* missing file */ }
      docs.push({ type: 'page', id: item.slug, url: `/library/${item.slug}/v${last.v}`, title: item.title, titleHtml: `${e(item.title)} v1–v${last.v}`,
        metaHtml: `<span class="dim">${e(item.category || '')} · ${item.versions.length} ${item.versions.length === 1 ? 'version' : 'versions'} · ${e(last.date)}</span>`,
        names: item.category || '', summary: item.summary || '', summaryHtml: e(item.summary || ''),
        body: `${item.versions.map((v) => v.note).join(' ')} ${text}`, code: item.slug, tags: '', date: last.date });
    }
    const syn = { ...(ledger.synonyms().groups || {}) };
    for (const p of products) syn[p.slug] = [...new Set([...(syn[p.slug] || []), p.name_en, p.name_es, ...(p.aliases || [])])];
    for (const f of features.values()) if ((f.aliases || []).length) syn[`f:${f.slug}`] = [f.name_en, f.name_es, ...f.aliases];
    const value = { docs, synonyms: syn, kindWords: ledger.synonyms().kinds || DEFAULT_KIND_WORDS };
    cache = { key, value };
    return value;
  }

  // ---------- agent API ----------
  const api = express.Router();
  api.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    if (!lib.configured()) return res.status(503).json({ ok: false, error: 'library not configured' });
    const sent = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!AGENT_TOKEN || !sent || !lib.sameText(sent, AGENT_TOKEN)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    req.actor = { kind: 'agent', session_id: String(req.get('X-Ledger-Session') || '').slice(0, 80) || null };
    next();
  });
  const wrap = (fn) => (req, res) => {
    try { fn(req, res); } catch (err) {
      if (err instanceof LedgerError) return res.status(err.status).json({ ok: false, error: err.message });
      console.error('ledger api error:', err.message);
      res.status(500).json({ ok: false, error: 'server error' });
    }
    return undefined;
  };
  const base = (req) => `${req.protocol}://${req.get('host')}`;
  const json = express.json({ limit: '512kb' });
  api.post('/change', json, wrap((req, res) => {
    const e = ledger.addChange(req.body || {}, req.actor);
    console.log(`ledger: ${e.payload.cr_id} recorded (seq ${e.seq})`);
    res.json({ ok: true, cr_id: e.payload.cr_id, seq: e.seq, hash: e.hash, url: `${base(req)}/library/ledger/cr/${e.payload.cr_id}` });
  }));
  api.post('/status', json, wrap((req, res) => {
    const e = ledger.addStatus(req.body || {}, req.actor);
    res.json({ ok: true, cr_id: e.payload.cr_id, from: e.payload.from, to: e.payload.to, seq: e.seq });
  }));
  api.post('/link', json, wrap((req, res) => {
    const e = ledger.addLink(req.body || {}, req.actor);
    res.json({ ok: true, cr_id: e.payload.cr_id, seq: e.seq });
  }));
  api.get('/recorded', wrap((req, res) => {
    const arts = [];
    for (const cr of ledger.state().crs.values()) for (const a of cr.artifacts || []) arts.push(`${a.library_slug}@${a.version}`);
    res.json({ ok: true, commits: ledger.commits(), artifacts: arts, count: ledger.entries.length });
  }));
  api.get('/cr/:id', wrap((req, res) => {
    const cr = ledger.state().crs.get(req.params.id);
    if (!cr) return res.status(404).json({ ok: false, error: 'no such record' });
    res.json({ ok: true, record: { ...cr, status_display: V.statusWords(cr) } });
    return undefined;
  }));
  api.get('/registry', wrap((req, res) => {
    res.json({ ok: true, products: ledger.products(), synonyms: ledger.synonyms(), features: [...ledger.state().features.values()] });
  }));
  api.put('/registry', json, wrap((req, res) => {
    const b = req.body || {};
    if (b.products) {
      if (!Array.isArray(b.products) || b.products.some((p) => !/^[a-z0-9][a-z0-9-]{1,60}$/.test(String(p.slug || '')) || !p.name_en || !p.name_es)) {
        throw new LedgerError('products need slug, name_en and name_es');
      }
      // A product with records can never disappear from the registry.
      const used = new Set([...ledger.state().crs.values()].map((cr) => cr.product_line));
      for (const s of used) if (!b.products.some((p) => p.slug === s)) throw new LedgerError(`product "${s}" has records and cannot be removed`);
      ledger.writeRegistry('products.json', b.products);
    }
    if (b.synonyms) ledger.writeRegistry('synonyms.json', b.synonyms);
    cache.key = '';
    res.json({ ok: true, products: ledger.products().length });
  }));
  api.get('/verify', wrap((req, res) => res.json({ ok: true, chain: ledger.verify() })));
  // ---------- owner pages ----------
  const pages = express.Router();
  pages.use((req, res, next) => {
    res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' });
    if (!lib.configured()) return res.status(503).type('text/plain').send('Library is not configured.');
    if (lib.sessionEmail(req)) return next();
    if (req.method !== 'GET' || req.path.endsWith('.json')) return res.status(401).type('text/plain').send('Sign in first.');
    res.redirect(302, `/library/login?next=${encodeURIComponent(`/library/ledger${req.path === '/' ? '' : req.path}`)}`);
    return undefined;
  });
  // Phase 2 (owner.js): owner actions, inbox, shares, audit, compare, synonyms, Needs
  // you, nightly sealed copy. Registered AFTER the sign-in check above; the outside
  // share view is mounted on app at /library/ledger/s, ahead of this router.
  const owner = require('./owner')({ app, pages, api, ledger, lib, V, ctx, send, steps, resetSearch });
  app.use('/library/api/ledger', api, (req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  const page = (req, res, p, status) => owner.page(req, res, p, status);
  pages.get('/', (req, res) => page(req, res, V.homePage({ ...ctx(), needsHtml: owner.needsPanel() })));
  pages.get('/products', (req, res) => page(req, res, V.productsPage(ctx())));
  pages.get('/search.json', (req, res) => res.json(searchDocs()));
  pages.get('/verify', (req, res) => res.json({ ok: true, chain: ledger.verify() }));
  pages.get('/p/:slug', (req, res) => {
    const c = ctx();
    const product = c.products.find((p) => p.slug === req.params.slug);
    if (!product) return page(req, res, V.notFound('No such product line.'), 404);
    return page(req, res, V.productPage({ ...c, product }));
  });
  pages.get('/f/:slug', (req, res) => {
    const c = ctx();
    const feature = c.features.get(req.params.slug);
    if (!feature) return page(req, res, V.notFound('No such feature.'), 404);
    const product = c.products.find((p) => p.slug === feature.product_line) || { slug: feature.product_line, name_en: feature.product_line };
    const libItem = c.libItems.find((i) => i.slug === feature.flow_artifact_slug);
    const st = V.featureState(feature, [...c.crs.values()], libItem);
    const asked = Number(req.query.v) || null;
    const versions = libItem ? libItem.versions.map((v) => v.v) : [];
    const shown = asked && versions.includes(asked) ? asked : st.live ? st.live.v : st.next ? st.next.v : versions[versions.length - 1];
    let stepsText = [];
    if (shown) { try { stepsText = steps(fs.readFileSync(lib.filePath(libItem.slug, shown), 'utf8')); } catch (e) { /* missing */ } }
    const extra = `<div class="row noprint"><a class="btn" href="/library/ledger/f/${V.esc(feature.slug)}/share">⇗ Share with a partner</a></div>`;
    return page(req, res, V.featurePage({ ...c, feature, product, libItem, showV: shown, stepsText, extra }));
  });
  pages.get('/cr/:id', (req, res) => {
    const c = ctx();
    const cr = c.crs.get(req.params.id.toUpperCase());
    if (!cr) return page(req, res, V.notFound(`No record ${req.params.id}.`), 404);
    return page(req, res, V.crPage({ ...c, cr, product: c.products.find((p) => p.slug === cr.product_line), extra: owner.ownerPanel(req, cr) }));
  });
  pages.use((req, res) => page(req, res, V.notFound('That page does not exist.'), 404));
  app.use('/library/ledger', pages);

  return ledger;
};
