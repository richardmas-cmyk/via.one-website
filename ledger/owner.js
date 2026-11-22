// Build Ledger phase 2: owner actions, backfill inbox, partner share links, audit,
// compare views, synonyms editor, the Needs-you panel and the nightly sealed copy.
//
// Owner pages (Library sign-in; every POST carries a CSRF token):
//   POST /library/ledger/act/status      mark live / roll back / retire / …  (new entry)
//   GET  /library/ledger/cr/<id>/amend   correction form → POST /act/amend
//   GET  /library/ledger/cr/<id>/redact  redaction form  → POST /act/redact
//   GET  /library/ledger/cr/<id>/share · /f/<slug>/share → POST /act/share
//   GET  /library/ledger/shares          every outside link + access log; revoke / extend
//   GET  /library/ledger/inbox           backfill candidates, one at a time (A E M D)
//   GET  /library/ledger/audit           status matrix + week in review; /audit.csv; /audit/print
//   GET  /library/ledger/audit/spot-check  10 records to check by hand
//   GET  /library/ledger/f/<slug>/compare?a=&b=&view=text|side|overlay
//   GET  /library/ledger/synonyms        search words editor
//   GET  /library/ledger/needs           everything that needs you
// Outside (no sign-in, link only):
//   GET  /library/ledger/s/<token>       partner view of one record or feature
//   GET  /library/ledger/s/<token>/flow  the pinned flow page
// Agent API (token): POST/GET /inbox, POST/GET /needs, POST /amend, GET /export

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { LedgerError, TRANSITIONS, AMENDABLE, REDACTABLE, KINDS, STATUSES } = require('./store');
const { scan, describe } = require('./scan');
const { diffSteps, summary: diffSummary } = require('./diff');

const DAY = 864e5;
const todayET = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
const SPOT_CHECK_FROM = '2026-12-06';
const OWNER_ACTOR = { kind: 'owner' };
const STATUS_ACTION = {
  live: ['● Mark live', 'You confirm it is on for everyone it is meant for.'],
  staged: ['◇ Mark staged', 'On for a limited group (for example your phones).'],
  built_flag_off: ['◐ Mark built, flag off', 'The code is there but switched off.'],
  rolled_back: ['↺ Record roll back', 'Records that it was turned off or undone. It does not change the platform.'],
  retired: ['✕ Mark retired', 'It is gone for good.'],
  abandoned: ['⊘ Mark abandoned', 'It will not ship.'],
};

module.exports = function mountOwner({ app, pages, api, ledger, lib, V, ctx, send, steps, resetSearch }) {
  const e = V.esc;
  const owners = String(process.env.LEDGER_OWNERS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const isOwner = (email) => Boolean(email) && (!owners.length || owners.includes(email));
  const csrfFor = (email) => lib.sign(`csrf:${email}`).slice(0, 32);
  const csrfField = (req) => `<input type="hidden" name="_csrf" value="${e(csrfFor(lib.sessionEmail(req)))}">`;
  const form = express.urlencoded({ extended: true, limit: '64kb' });

  // ---------- workflow files ----------
  const inbox = () => ledger.readJSON('inbox.json', []);
  const shares = () => ledger.readJSON('shares.json', []);
  const report = () => ledger.readJSON('needs.json', null);
  const pendingInbox = () => inbox().filter((c) => c.state === 'pending');

  // ---------- nightly sealed copy (checked hourly; one per ET day) ----------
  const anchorNow = () => {
    try { const a = ledger.anchor(todayET()); if (a) console.log(`ledger: sealed copy ${a.date} (${a.count} entries)`); } catch (err) { console.error('ledger anchor failed:', err.message); }
  };
  if (ledger.chain.ok) anchorNow();
  setInterval(() => { if (ledger.chain.ok) anchorNow(); }, 3600e3).unref();

  // ---------- Needs you ----------
  function needs() {
    const { crs, features, libItems } = ctx();
    const all = [...crs.values()];
    const out = [];
    const add = (sev, text, href, list) => out.push({ sev, text, href, list: list || [] });
    const r = report();
    if (!r) add('warn', 'The nightly check from the Mac has not reported yet.', null);
    else {
      const age = Date.now() - Date.parse(r.generated_at);
      if (age > 36 * 3600e3) add('bad', `The nightly check from the Mac last reported ${V.fmtDate(r.generated_at, true)}. It may have stopped.`, null);
      const recordedNow = ledger.commits();
      // Commits waiting in the Inbox, or in a candidate you discarded, are not "no record".
      const waiting = inbox().filter((x) => x.state === 'pending' || x.state === 'discarded').flatMap((x) => ((x.draft.evidence || {}).repos || []).flatMap((rp) => rp.commits));
      const known = (sha) => [...recordedNow, ...waiting].some((c) => sha.startsWith(c) || c.startsWith(sha));
      const un = (r.unrecorded_commits || []).filter((c) => !known(String(c.sha)));
      if (un.length) add('bad', `${un.length} ${un.length === 1 ? 'commit' : 'commits'} on main with no record`, '/library/ledger/needs#unrecorded', un.slice(0, 50).map((c) => `${c.repo} ${String(c.sha).slice(0, 8)} · ${String(c.date || '').slice(0, 10)} · ${c.subject || ''}`));
      const gu = r.hook_giveups || [];
      if (gu.length) add('warn', `${gu.length} ${gu.length === 1 ? 'session' : 'sessions'} ended without recording, after being asked twice`, '/library/ledger/needs#giveups', gu.slice(0, 20).map((g) => `${String(g.at).slice(0, 16)} · ${g.items}`));
      if (r.backup && !r.backup.ok) add('bad', `Mac backup check failed: ${r.backup.problem || 'unknown problem'}`, null);
    }
    const anchors = ledger.anchors();
    const lastA = anchors[anchors.length - 1];
    if (!lastA || Date.now() - Date.parse(lastA.at) > 36 * 3600e3) add('bad', 'No sealed daily copy of the ledger in the last 36 hours.', null);
    const stale = all.filter((cr) => ['built_flag_off', 'staged'].includes(cr.current) && Date.now() - Date.parse(cr.history[cr.history.length - 1].at) > 30 * DAY);
    if (stale.length) add('warn', `${stale.length} not fully on for 30+ days`, null, stale.map((cr) => ({ href: `/library/ledger/cr/${cr.cr_id}`, text: `${cr.cr_id} · ${V.statusWords(cr)} · ${cr.title}` })));
    const inferred = all.filter((cr) => cr.current === 'live' && cr.live_proof === 'inferred');
    if (inferred.length) add('warn', `${inferred.length} marked live with no deploy proof — confirm or correct`, null, inferred.map((cr) => ({ href: `/library/ledger/cr/${cr.cr_id}`, text: `${cr.cr_id} · ${cr.title}` })));
    const flowOut = [];
    for (const f of features.values()) {
      if (!f.flow_artifact_slug || !['consumer-flow', 'partner-api'].includes(f.type)) continue;
      const mine = all.filter((cr) => (cr.features || []).includes(f.slug)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const item = libItems.find((i) => i.slug === f.flow_artifact_slug);
      const tied = Math.max(0, ...mine.flatMap((cr) => (cr.artifacts || []).filter((a) => a.library_slug === f.flow_artifact_slug).map((a) => a.version)));
      const latest = item ? item.versions[item.versions.length - 1].v : 0;
      if (latest > tied) flowOut.push({ href: `/library/ledger/f/${f.slug}`, text: `${f.name_en}: flow page v${latest} is not tied to any record` });
      const lastFlowCr = [...mine].reverse().find((cr) => (cr.artifacts || []).some((a) => a.role === 'flow' && a.library_slug === f.flow_artifact_slug));
      const lastCode = [...mine].reverse().find((cr) => ['build', 'modify', 'remove'].includes(cr.kind) && !['abandoned', 'rolled_back'].includes(cr.current));
      if (lastCode && lastCode !== lastFlowCr && (!lastFlowCr || String(lastCode.date) > String(lastFlowCr.date))) flowOut.push({ href: `/library/ledger/cr/${lastCode.cr_id}`, text: `${f.name_en}: ${lastCode.cr_id} changed it but the flow page was not updated` });
    }
    if (flowOut.length) add('warn', `${flowOut.length} flow ${flowOut.length === 1 ? 'page' : 'pages'} out of date`, null, flowOut);
    const p = pendingInbox().length;
    if (p) add('warn', `${p} backfilled ${p === 1 ? 'record' : 'records'} waiting in the Inbox`, '/library/ledger/inbox');
    if (todayET() >= SPOT_CHECK_FROM) {
      const done = spotChecks().length;
      if (done < 10) add('warn', `Spot-check due: ${10 - done} of 10 records left to check by hand (are the plain words right?)`, '/library/ledger/audit/spot-check');
    }
    return out;
  }
  const needsList = (items, full) => (items.length ? `<ol class="list needs">${items.map((n) => `<li class="item${n.sev === 'bad' ? ' bad' : ''}" data-nav>
<p data-read><b>${n.sev === 'bad' ? '<span aria-hidden="true">✕</span> ' : '<span aria-hidden="true">⚠</span> '}${n.href ? `<a href="${e(n.href)}">${e(n.text)}</a>` : e(n.text)}</b></p>
${n.list.length ? `<details${full ? ' open' : ''}><summary>Show ${n.list.length}</summary><ul>${n.list.map((x) => (typeof x === 'string' ? `<li class="mono">${e(x)}</li>` : `<li><a href="${e(x.href)}">${e(x.text)}</a></li>`)).join('')}</ul></details>` : ''}</li>`).join('')}</ol>`
    : '<p class="banner"><span aria-hidden="true">✓</span> Nothing needs you right now.</p>');
  const needsPanel = () => {
    const n = needs();
    return `<section aria-labelledby="h-needs" style="margin-bottom:24px"><h2 id="h-needs">Needs you (${n.length})</h2><div style="margin-top:12px">${needsList(n.slice(0, 6))}</div>
${n.length > 6 ? `<p><a href="/library/ledger/needs">All ${n.length} items</a></p>` : ''}</section>`;
  };

  // ---------- owner guard for POSTs ----------
  const ownerPost = (fn) => [form, (req, res) => {
    const email = lib.sessionEmail(req);
    if (!isOwner(email)) return res.status(403).type('text/plain').send('Only the owner can do this.');
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).type('text/plain').send('Wrong origin.');
    if (!lib.sameText(String((req.body || {})._csrf || ''), csrfFor(email))) return res.status(403).type('text/plain').send('This form expired. Go back, reload the page and try again.');
    try { return fn(req, res); } catch (err) {
      const msg = err instanceof LedgerError ? err.message : 'Something went wrong. Nothing was saved.';
      if (!(err instanceof LedgerError)) console.error('ledger owner action error:', err.message);
      const back = safeBack(req.body.back);
      return res.redirect(303, `${back}${back.includes('?') ? '&' : '?'}err=${encodeURIComponent(msg)}`);
    }
  }];
  const safeBack = (v) => (/^\/library\/ledger(\/[A-Za-z0-9/_?=&.-]*)?$/.test(String(v || '')) ? String(v) : '/library/ledger');
  const done = (res, back, msg) => res.redirect(303, `${back}${back.includes('?') ? '&' : '?'}ok=${encodeURIComponent(msg)}`);
  const flash = (req) => (req.query.ok ? { text: String(req.query.ok).slice(0, 300) } : req.query.err ? { text: String(req.query.err).slice(0, 300), bad: true } : null);
  const page = (req, res, p, status) => send(res, { ...p, flash: flash(req), inboxCount: pendingInbox().length }, status);

  // ---------- status actions ----------
  pages.post('/act/status', ...ownerPost((req, res) => {
    const b = req.body;
    const evidence = b.deploy_id ? { env: 'prod', deploy_id: String(b.deploy_id).slice(0, 80) } : null;
    const ev = ledger.addStatus({ cr_id: b.cr_id, to: b.to, note: b.note || '', evidence }, OWNER_ACTOR);
    resetSearch();
    const p = ev.payload;
    return done(res, `/library/ledger/cr/${p.cr_id}`, p.from === p.to ? `${p.cr_id}: you confirmed it is live.` : `${p.cr_id}: ${V.STATUS[p.from][1]} → ${V.STATUS[p.to][1]}`);
  }));

  function ownerPanel(req, cr) {
    const next = (TRANSITIONS[cr.current] || []).filter((t) => STATUS_ACTION[t]);
    const confirmLive = cr.current === 'live' && cr.live_proof === 'inferred';
    return `<section class="card noprint" aria-labelledby="h-act"><h2 id="h-act">Your actions</h2>
<p class="dim">Each action is added as a new entry with your name on it. Nothing is overwritten.</p>
${confirmLive ? `<form method="post" action="/library/ledger/act/status" class="stack">${csrfField(req)}<input type="hidden" name="cr_id" value="${e(cr.cr_id)}"><input type="hidden" name="back" value="/library/ledger/cr/${e(cr.cr_id)}">
<p data-read><b>◍ Live (inferred):</b> there is no deploy proof. If you know it is on for everyone, confirm it.</p>
<div class="row"><button type="submit" name="to" value="live" class="primary">● Confirm live</button></div></form>` : ''}
${next.length ? `<form method="post" action="/library/ledger/act/status" class="stack">${csrfField(req)}<input type="hidden" name="cr_id" value="${e(cr.cr_id)}"><input type="hidden" name="back" value="/library/ledger/cr/${e(cr.cr_id)}">
<label>Note (optional)<input type="text" name="note" maxlength="300" placeholder="for example: checked on my phone"></label>
${next.includes('live') ? '<label>Deploy id (optional)<input type="text" name="deploy_id" maxlength="80" placeholder="Railway deployment id, if you have it"></label>' : ''}
<div class="row">${next.map((t) => `<button type="submit" name="to" value="${t}"${t === 'live' ? ' class="primary"' : ''} title="${e(STATUS_ACTION[t][1])}">${e(STATUS_ACTION[t][0])}</button>`).join('')}</div>
<ul class="dim">${next.map((t) => `<li><b>${e(STATUS_ACTION[t][0].replace(/^\S+ /, ''))}:</b> ${e(STATUS_ACTION[t][1])}</li>`).join('')}</ul></form>` : '<p>No further status change is possible for this record.</p>'}
<div class="row"><a class="btn" href="/library/ledger/cr/${e(cr.cr_id)}/amend">✎ Amend</a><a class="btn" href="/library/ledger/cr/${e(cr.cr_id)}/share">⇗ Share with a partner</a><a class="btn" href="/library/ledger/cr/${e(cr.cr_id)}/redact">Redact…</a></div></section>`;
  }

  // ---------- amend ----------
  const lines = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);
  const AMEND_FORM_FIELDS = ['title', 'summary_plain', 'why', 'what_changed', 'removed', 'open_items', 'rollback_plan', 'product_line', 'features', 'kind', 'risk', 'user_impact'];
  function fieldInputs(cr, c, { prefix = '' } = {}) {
    const val = (k) => (Array.isArray(cr[k]) ? cr[k].join('\n') : cr[k] || '');
    const sel = (k, opts, allowBlank) => `<label>${k}<select name="${prefix}${k}">${allowBlank ? '<option value="">(none)</option>' : ''}${opts.map(([v, l]) => `<option value="${e(v)}"${cr[k] === v ? ' selected' : ''}>${e(l)}</option>`).join('')}</select></label>`;
    const feats = [...c.features.values()];
    return `<label>Title (80 characters at most)<input type="text" name="${prefix}title" maxlength="80" value="${e(val('title'))}" required></label>
<label>In plain words<textarea name="${prefix}summary_plain" rows="3" maxlength="400" required>${e(val('summary_plain'))}</textarea></label>
<label>Why<textarea name="${prefix}why" rows="2" maxlength="600">${e(val('why'))}</textarea></label>
<label>What was added (one per line)<textarea name="${prefix}what_changed" rows="4">${e(val('what_changed'))}</textarea></label>
<label>What was removed (one per line)<textarea name="${prefix}removed" rows="2">${e(val('removed'))}</textarea></label>
<label>Open items (one per line)<textarea name="${prefix}open_items" rows="2">${e(val('open_items'))}</textarea></label>
<label>Rollback<textarea name="${prefix}rollback_plan" rows="2" maxlength="400">${e(val('rollback_plan'))}</textarea></label>
<div class="row">${sel('product_line', c.products.map((p) => [p.slug, p.name_en]))}${sel('kind', KINDS.map((k) => [k, V.KIND[k]]))}
${sel('risk', [['low', 'low'], ['medium', 'medium'], ['high', 'high']], true)}${sel('user_impact', ['none', 'internal', 'partner', 'consumer'].map((x) => [x, x]), true)}</div>
<fieldset><legend><b>Features</b></legend>${feats.map((f) => `<label style="flex-direction:row;gap:8px;font-weight:400"><input type="checkbox" name="${prefix}features" value="${e(f.slug)}"${(cr.features || []).includes(f.slug) ? ' checked' : ''}> ${e(f.name_en)} <span class="dim">(${e(f.product_line)})</span></label>`).join('')}</fieldset>`;
  }
  function readFields(body, prefix = '') {
    const out = {};
    for (const k of AMEND_FORM_FIELDS) {
      const v = body[prefix + k];
      if (v === undefined) { if (k === 'features') out.features = []; continue; }
      if (['what_changed', 'removed', 'open_items'].includes(k)) out[k] = lines(v);
      else if (k === 'features') out.features = [].concat(v).filter(Boolean);
      else out[k] = String(v).trim();
    }
    for (const k of ['why', 'rollback_plan', 'risk', 'user_impact']) if (out[k] === '') delete out[k];
    return out;
  }
  pages.get('/cr/:id/amend', (req, res) => {
    const c = ctx();
    const cr = c.crs.get(req.params.id.toUpperCase());
    if (!cr) return page(req, res, V.notFound(`No record ${req.params.id}.`), 404);
    return page(req, res, {
      title: `Amend ${cr.cr_id} · Build Ledger`, active: 'products',
      body: `<nav class="dim" aria-label="Breadcrumb"><a href="/library/ledger/cr/${e(cr.cr_id)}">${e(cr.cr_id)}</a> › Amend</nav><h1>Amend ${e(cr.cr_id)}</h1>
<p data-read>Change what is wrong. The old values stay visible on the record, marked “was”. Give a short reason.</p>
<form method="post" action="/library/ledger/act/amend" class="card stack">${csrfField(req)}<input type="hidden" name="cr_id" value="${e(cr.cr_id)}"><input type="hidden" name="back" value="/library/ledger/cr/${e(cr.cr_id)}/amend">
${fieldInputs(cr, c)}
<label>Reason for the correction<input type="text" name="reason" maxlength="300" required placeholder="for example: wrong product line"></label>
<div class="row"><button type="submit" class="primary">Save amendment</button><a class="btn" href="/library/ledger/cr/${e(cr.cr_id)}">Cancel</a></div></form>`,
    });
  });
  pages.post('/act/amend', ...ownerPost((req, res) => {
    const cr = ledger.state().crs.get(String(req.body.cr_id));
    if (!cr) throw new LedgerError('no such record');
    const patch = readFields(req.body);
    for (const k of Object.keys(patch)) if (JSON.stringify(patch[k]) === JSON.stringify(cr[k]) || (patch[k] === undefined)) delete patch[k];
    for (const k of ['why', 'rollback_plan']) if (req.body[k] === '' && cr[k]) patch[k] = '';
    const ev = ledger.addAmend({ cr_id: cr.cr_id, patch, reason: req.body.reason }, OWNER_ACTOR);
    resetSearch();
    return done(res, `/library/ledger/cr/${cr.cr_id}`, `${cr.cr_id} amended: ${Object.keys(ev.payload.patch).join(', ')}`);
  }));

  // ---------- redact ----------
  pages.get('/cr/:id/redact', (req, res) => {
    const cr = ledger.state().crs.get(req.params.id.toUpperCase());
    if (!cr) return page(req, res, V.notFound(`No record ${req.params.id}.`), 404);
    return page(req, res, {
      title: `Redact ${cr.cr_id} · Build Ledger`, active: 'products',
      body: `<nav class="dim" aria-label="Breadcrumb"><a href="/library/ledger/cr/${e(cr.cr_id)}">${e(cr.cr_id)}</a> › Redact</nav><h1>Redact ${e(cr.cr_id)}</h1>
<p class="banner bad" data-read>Only for an accident, like a phone number that slipped in. The chosen fields are replaced by “REDACTED — your reason” everywhere, including the sealed daily copies on the server. Use Amend for normal corrections.</p>
<form method="post" action="/library/ledger/act/redact" class="card stack">${csrfField(req)}<input type="hidden" name="cr_id" value="${e(cr.cr_id)}"><input type="hidden" name="back" value="/library/ledger/cr/${e(cr.cr_id)}/redact">
<fieldset><legend><b>Fields to redact</b></legend>${REDACTABLE.map((f) => `<label style="flex-direction:row;gap:8px;font-weight:400"><input type="checkbox" name="fields" value="${f}"> <b>${f}</b>${f !== 'status_notes' && cr[f] ? ` <span class="dim">${e(V.showVal(cr[f]).slice(0, 90))}</span>` : ''}</label>`).join('')}</fieldset>
<label>Reason (shown in the marker)<input type="text" name="reason" maxlength="120" required placeholder="for example: phone number"></label>
<label>Type <span class="mono">REDACT ${e(cr.cr_id)}</span> to confirm<input type="text" name="confirm" required autocomplete="off"></label>
<div class="row"><button type="submit" class="primary">Redact</button><a class="btn" href="/library/ledger/cr/${e(cr.cr_id)}">Cancel</a></div></form>`,
    });
  });
  pages.post('/act/redact', ...ownerPost((req, res) => {
    const ev = ledger.redact({ cr_id: req.body.cr_id, fields: req.body.fields, reason: req.body.reason, confirm: req.body.confirm }, OWNER_ACTOR);
    resetSearch();
    return done(res, `/library/ledger/cr/${ev.payload.cr_id}`, `Redacted ${ev.payload.fields.join(', ')} on ${ev.payload.cr_id}. The chain still verifies.`);
  }));

  // ---------- partner share links ----------
  const tokenHash = (t) => crypto.createHash('sha256').update(`share:${t}`).digest('hex');
  function shareForm(req, res, target, label, versions) {
    return page(req, res, {
      title: `Share ${label} · Build Ledger`, active: 'shares',
      body: `<h1>Share with a partner</h1><p data-read>An outside link to <b>${e(label)}</b>, in partner view: no file names, sessions, risk notes, rollback steps or evidence.</p>
<form method="post" action="/library/ledger/act/share" class="card stack">${csrfField(req)}<input type="hidden" name="type" value="${e(target.type)}"><input type="hidden" name="id" value="${e(target.id)}"><input type="hidden" name="back" value="${e(req.originalUrl.split('?')[0])}">
<label>Who it is for (a company or a word, not a person's email)<input type="text" name="label" maxlength="60" required placeholder="for example: PPN"></label>
<label style="flex-direction:row;gap:8px"><input type="checkbox" name="pinned" value="1" checked> Pin it to how it reads now${versions ? ` (flow page v${versions})` : ''}. Recommended: later changes do not show up.</label>
<label>Expires<select name="days"><option value="7">in 7 days</option><option value="30" selected>in 30 days</option><option value="90">in 90 days</option><option value="0">never (until you revoke it)</option></select></label>
<div class="row"><button type="submit" class="primary">Make the link</button></div></form>`,
    });
  }
  pages.get('/cr/:id/share', (req, res) => {
    const cr = ledger.state().crs.get(req.params.id.toUpperCase());
    if (!cr) return page(req, res, V.notFound(`No record ${req.params.id}.`), 404);
    return shareForm(req, res, { type: 'cr', id: cr.cr_id }, `${cr.cr_id} · ${cr.title}`);
  });
  pages.get('/f/:slug/share', (req, res) => {
    const c = ctx();
    const f = c.features.get(req.params.slug);
    if (!f) return page(req, res, V.notFound('No such feature.'), 404);
    const item = c.libItems.find((i) => i.slug === f.flow_artifact_slug);
    const st = V.featureState(f, [...c.crs.values()], item);
    const v = st.live ? st.live.v : item ? item.versions[item.versions.length - 1].v : null;
    return shareForm(req, res, { type: 'feature', id: f.slug }, f.name_en, v);
  });
  pages.post('/act/share', ...ownerPost((req, res) => {
    const b = req.body;
    const c = ctx();
    const type = b.type === 'feature' ? 'feature' : 'cr';
    if (type === 'cr' && !c.crs.has(String(b.id))) throw new LedgerError('no such record');
    if (type === 'feature' && !c.features.has(String(b.id))) throw new LedgerError('no such feature');
    const label = String(b.label || '').trim().slice(0, 60);
    if (!label) throw new LedgerError('say who the link is for');
    let version = null;
    if (type === 'feature') {
      const f = c.features.get(b.id);
      const item = c.libItems.find((i) => i.slug === f.flow_artifact_slug);
      const st = V.featureState(f, [...c.crs.values()], item);
      version = st.live ? st.live.v : item ? item.versions[item.versions.length - 1].v : null;
    }
    const pinned = b.pinned === '1';
    const days = [0, 7, 30, 90].includes(Number(b.days)) ? Number(b.days) : 30;
    const token = crypto.randomBytes(24).toString('base64url');
    const sh = {
      id: `SH-${String(shares().length + 1).padStart(4, '0')}`, token_hash: tokenHash(token), type, target: String(b.id), label, pinned,
      as_of_seq: pinned ? ledger.entries.length : null, version: pinned ? version : null,
      created_at: new Date().toISOString(), expires_at: days ? new Date(Date.now() + days * DAY).toISOString() : null, revoked_at: null,
    };
    ledger.addEvent('share', { action: 'create', share_id: sh.id, type, target: sh.target, label, pinned, version: sh.version, expires_at: sh.expires_at }, OWNER_ACTOR);
    ledger.writeState('shares.json', [...shares(), sh]);
    const url = `${req.protocol}://${req.get('host')}/library/ledger/s/${token}`;
    return page(req, res, {
      title: 'Link ready · Build Ledger', active: 'shares',
      body: `<h1><span aria-hidden="true">✓</span> Link ready (${e(sh.id)})</h1>
<p data-read>Copy it now. For safety it is shown only this once; you can revoke it any time on the Shares page.</p>
<div class="card"><label class="big" for="link">Outside link for ${e(label)}</label><input type="text" id="link" readonly value="${e(url)}">
<div class="row"><button type="button" class="primary" data-act="copy" data-target="link">Copy link</button><a class="btn" href="/library/ledger/shares">All shares</a></div>
<p class="dim">${pinned ? 'Pinned to how it reads now.' : 'Follows the latest version.'} ${sh.expires_at ? `Expires ${V.fmtDate(sh.expires_at)}.` : 'Does not expire.'}</p></div>`,
    });
  }));
  pages.post('/act/share-revoke', ...ownerPost((req, res) => {
    const list = shares();
    const sh = list.find((x) => x.id === req.body.id);
    if (!sh || sh.revoked_at) throw new LedgerError('no active share with that id');
    sh.revoked_at = new Date().toISOString();
    ledger.addEvent('share', { action: 'revoke', share_id: sh.id }, OWNER_ACTOR);
    ledger.writeState('shares.json', list);
    return done(res, '/library/ledger/shares', `${sh.id} revoked. The link stopped working.`);
  }));
  pages.post('/act/share-extend', ...ownerPost((req, res) => {
    const list = shares();
    const sh = list.find((x) => x.id === req.body.id);
    if (!sh || sh.revoked_at) throw new LedgerError('no active share with that id');
    const days = Number(req.body.days) || 30;
    sh.expires_at = new Date(Math.max(Date.now(), Date.parse(sh.expires_at || 0)) + days * DAY).toISOString();
    ledger.addEvent('share', { action: 'extend', share_id: sh.id, expires_at: sh.expires_at }, OWNER_ACTOR);
    ledger.writeState('shares.json', list);
    return done(res, '/library/ledger/shares', `${sh.id} now expires ${V.fmtDate(sh.expires_at)}.`);
  }));
  const accessLog = () => {
    const f = path.join(ledger.dir, 'shares-access.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (err) { return null; } }).filter(Boolean) : [];
  };
  pages.get('/shares', (req, res) => {
    const log = accessLog();
    const list = shares().slice().reverse();
    const now = Date.now();
    const state = (sh) => (sh.revoked_at ? ['✕', 'REVOKED', 'st-rb'] : sh.expires_at && Date.parse(sh.expires_at) < now ? ['⊘', 'EXPIRED', 'st-ret'] : ['●', 'ACTIVE', 'st-live']);
    return page(req, res, {
      title: 'Shares · Build Ledger', active: 'shares',
      body: `<h1>Partner links (${list.length})</h1><p data-read>Every outside link you made, who it was for, and each time it was opened.</p>
${list.length ? `<ol class="list">${list.map((sh) => {
        const s = state(sh);
        const hits = log.filter((l) => l.share_id === sh.id);
        const href = sh.type === 'cr' ? `/library/ledger/cr/${e(sh.target)}` : `/library/ledger/f/${e(sh.target)}`;
        return `<li class="item" data-nav><div class="meta"><b>${e(sh.id)}</b> <span class="st ${s[2]}"><span aria-hidden="true">${s[0]}</span> ${s[1]}</span> for <b>${e(sh.label)}</b> · <a href="${href}">${e(sh.target)}</a></div>
<p class="dim" data-read>Made ${V.fmtDate(sh.created_at)} · ${sh.pinned ? `pinned${sh.version ? ` to flow v${sh.version}` : ''}` : 'follows latest'} · ${sh.expires_at ? `expires ${V.fmtDate(sh.expires_at)}` : 'no expiry'} · opened ${hits.length} ${hits.length === 1 ? 'time' : 'times'}</p>
${hits.length ? `<details><summary>Access log</summary><ul class="mono">${hits.slice(-50).reverse().map((h) => `<li>${e(V.fmtDate(h.at, true))} · ${e(h.ip)} · ${e(h.ua)}</li>`).join('')}</ul></details>` : ''}
${s[1] === 'ACTIVE' || s[1] === 'EXPIRED' ? `<div class="row noprint">${s[1] === 'ACTIVE' ? `<form method="post" action="/library/ledger/act/share-revoke">${csrfField(req)}<input type="hidden" name="id" value="${e(sh.id)}"><input type="hidden" name="back" value="/library/ledger/shares"><button type="submit">✕ Revoke</button></form>` : ''}
${!sh.revoked_at ? `<form method="post" action="/library/ledger/act/share-extend">${csrfField(req)}<input type="hidden" name="id" value="${e(sh.id)}"><input type="hidden" name="days" value="30"><input type="hidden" name="back" value="/library/ledger/shares"><button type="submit">+30 days</button></form>` : ''}</div>` : ''}</li>`;
      }).join('')}</ol>` : '<p class="card">No partner links yet. Use “Share with a partner” on a record or a feature.</p>'}`,
    });
  });

  // Outside view. Mounted before the sign-in check.
  const pub = express.Router();
  pub.use((req, res, next) => { res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
  const findShare = (token) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    const h = tokenHash(token);
    const sh = shares().find((x) => lib.sameText(x.token_hash, h));
    if (!sh || sh.revoked_at || (sh.expires_at && Date.parse(sh.expires_at) < Date.now())) return null;
    return sh;
  };
  const gone = (res) => send(res, { title: 'Link not active · Via One', partner: true, body: '<h1>❌ This link is no longer active</h1><p>Ask the person who sent it to you for a new one.</p>' }, 404);
  const logAccess = (req, sh) => {
    const ip = String(req.ip || '').replace(/^::ffff:/, '');
    const masked = ip.includes(':') ? `${ip.split(':').slice(0, 3).join(':')}::/48` : `${ip.split('.').slice(0, 3).join('.')}.0/24`;
    fs.appendFileSync(path.join(ledger.dir, 'shares-access.jsonl'), `${JSON.stringify({ share_id: sh.id, at: new Date().toISOString(), ip: masked, ua: String(req.get('user-agent') || '').slice(0, 80) })}\n`);
  };
  const partnerFlowVersion = (sh, c) => {
    const f = c.features.get(sh.target);
    const item = f && c.libItems.find((i) => i.slug === f.flow_artifact_slug);
    if (!item) return { f, item: null, v: null };
    const st = V.featureState(f, [...c.crs.values()], item);
    const v = sh.pinned && sh.version ? sh.version : st.live ? st.live.v : item.versions[item.versions.length - 1].v;
    return { f, item, v, st };
  };
  pub.get('/:token', (req, res) => {
    const sh = findShare(req.params.token);
    if (!sh) return gone(res);
    logAccess(req, sh);
    const st = ledger.state(sh.pinned ? sh.as_of_seq : undefined);
    const c = { ...ctx(), crs: st.crs, features: st.features };
    const asOf = sh.pinned ? ` · as of ${V.fmtDate(sh.created_at)}` : '';
    if (sh.type === 'cr') {
      const cr = c.crs.get(sh.target);
      if (!cr) return gone(res);
      const prod = c.products.find((p) => p.slug === cr.product_line);
      const feats = (cr.features || []).map((s) => c.features.get(s)).filter(Boolean);
      return send(res, {
        title: `${cr.title} · Via One`, partner: true,
        body: `<p class="tag">Via One · change record ${e(cr.cr_id)}${asOf}</p><h1 data-read>${e(cr.title)}</h1>
<div class="meta" data-read>${V.kindChip(cr.kind)} ${V.badge(cr)} <span>${V.fmtDate(cr.date)}</span><span class="dim">${e(prod ? prod.name_en : '')}${feats.length ? ` › ${feats.map((f) => e(f.name_en)).join(', ')}` : ''}</span></div>
<section class="card"><h2>In plain words</h2><p data-read style="font-size:1.1rem;font-weight:700">${e(cr.summary_plain)}</p>${cr.why ? `<p data-read><b>Why:</b> ${e(cr.why)}</p>` : ''}</section>
${(cr.what_changed || []).length || (cr.removed || []).length ? `<section class="card"><h2>What changed</h2><ul class="list" data-read>${(cr.what_changed || []).map((w) => `<li><span class="plus">+ ADDED</span> ${e(w)}</li>`).join('')}${(cr.removed || []).map((w) => `<li><span class="minus">− REMOVED</span> ${e(w)}</li>`).join('')}</ul></section>` : ''}`,
      });
    }
    const { f, item, v } = partnerFlowVersion(sh, c);
    if (!f) return gone(res);
    const fst = V.featureState(f, [...c.crs.values()], item);
    let stepList = [];
    if (item && v) { try { stepList = steps(fs.readFileSync(lib.filePath(item.slug, v), 'utf8')); } catch (err) { /* missing */ } }
    return send(res, {
      title: `${f.name_en} · Via One`, partner: true,
      body: `<p class="tag">Via One · feature${asOf}</p><h1 data-read>${e(f.name_en)}</h1><p class="dim">${e(f.name_es)}</p>
<div class="card now" data-read><p>STATUS: ${fst.retiredBy ? V.badgeFor('retired') : fst.live ? `${V.badge(fst.live.cr)} since ${V.fmtDate(fst.live.cr.date)}` : 'Not live yet'}</p>${f.summary ? `<p style="font-weight:400">${e(f.summary)}</p>` : ''}</div>
${item && v ? `<section><h2>Flow — version ${v}</h2><div class="row noprint" style="margin-top:10px"><button type="button" data-act="zoom-out" aria-label="Zoom flow out">−</button><button type="button" data-act="zoom-in" aria-label="Zoom flow in">+</button></div>
<div class="frame" style="margin-top:12px"><iframe id="flow" title="${e(f.name_en)} flow version ${v}" src="/library/ledger/s/${e(req.params.token)}/flow" sandbox="allow-scripts allow-popups"></iframe></div>
${stepList.length ? `<details style="margin-top:10px"><summary>Steps as text</summary><ol data-read>${stepList.map((s) => `<li>${e(s)}</li>`).join('')}</ol></details>` : ''}</section>` : ''}`,
    });
  });
  pub.get('/:token/flow', (req, res) => {
    const sh = findShare(req.params.token);
    if (!sh || sh.type !== 'feature') return gone(res);
    const { item, v } = partnerFlowVersion(sh, ctx());
    const ver = item && item.versions.find((x) => x.v === v);
    if (!ver || !lib.sendDoc(res, item, ver, { signedIn: false, embed: true })) return gone(res);
    return undefined;
  });
  app.use('/library/ledger/s', pub);

  // ---------- compare ----------
  pages.get('/f/:slug/compare', (req, res) => {
    const c = ctx();
    const f = c.features.get(req.params.slug);
    if (!f) return page(req, res, V.notFound('No such feature.'), 404);
    const item = c.libItems.find((i) => i.slug === f.flow_artifact_slug);
    const versions = item ? item.versions.map((x) => x.v) : [];
    if (versions.length < 2) return page(req, res, { ...V.notFound('This feature has fewer than two flow versions to compare.') }, 404);
    let a = Number(req.query.a); let b = Number(req.query.b);
    if (!versions.includes(b)) b = versions[versions.length - 1];
    if (!versions.includes(a) || a === b) a = versions[Math.max(0, versions.indexOf(b) - 1)];
    const view = ['text', 'side', 'overlay'].includes(req.query.view) ? req.query.view : 'text';
    const read = (v) => { try { return steps(fs.readFileSync(lib.filePath(item.slug, v), 'utf8')); } catch (err) { return []; } };
    const d = diffSteps(read(a), read(b));
    const sum = diffSummary(d, a, b);
    const verCr = new Map();
    for (const cr of c.crs.values()) for (const art of cr.artifacts || []) if (art.library_slug === item.slug) verCr.set(art.version, cr);
    const verLabel = (v) => { const cr = verCr.get(v); return `v${v}${cr ? ` · ${V.statusWords(cr)} · ${cr.cr_id}` : ''}`; };
    const sel = (name, cur) => `<label>${name === 'a' ? 'Older' : 'Newer'} <select name="${name}">${versions.map((v) => `<option value="${v}"${v === cur ? ' selected' : ''}>${e(verLabel(v))}</option>`).join('')}</select></label>`;
    const tab = (k, l) => `<a class="btn${view === k ? ' primary' : ''}"${view === k ? ' aria-current="page"' : ''} href="?a=${a}&b=${b}&view=${k}">${l}</a>`;
    const src = (v) => `/library/${e(item.slug)}/v${v}?embed=1`;
    const body = view === 'text'
      ? `<section class="card"><h2 data-read>${e(sum)}</h2><ol class="diff" data-read>${d.map((x) => `<li class="${x.op}">${x.op === 'add' ? '<span class="plus">+ ADDED</span> ' : x.op === 'del' ? '<span class="minus">− REMOVED</span> ' : ''}${e(x.text)}</li>`).join('')}</ol>
${d.length ? '' : '<p class="dim">Neither version has headings or list items to compare. Use side by side.</p>'}</section>`
      : view === 'side'
        ? `<p class="dim" data-read>${e(sum)} Scrolling one side scrolls the other.</p><div class="pair"><div><h3>v${a}</h3><div class="frame"><iframe id="cmp-a" data-sync title="Version ${a}" src="${src(a)}" sandbox="allow-scripts allow-popups"></iframe></div></div>
<div><h3>v${b}</h3><div class="frame"><iframe id="cmp-b" data-sync title="Version ${b}" src="${src(b)}" sandbox="allow-scripts allow-popups"></iframe></div></div></div>`
        : `<p class="dim" data-read>${e(sum)} Drag the slider: left shows v${a}, right shows v${b}.</p>
<label class="big" for="ov">Overlay: v${a} ⇄ v${b}<input type="range" id="ov" min="0" max="100" value="50" aria-valuetext="50 percent of version ${b}"></label>
<div class="overlay"><iframe title="Version ${a}" src="${src(a)}" sandbox="allow-scripts allow-popups" data-sync></iframe><iframe id="ov-top" title="Version ${b}" src="${src(b)}" sandbox="allow-scripts allow-popups" data-sync style="clip-path:inset(0 0 0 50%)"></iframe></div>`;
    return page(req, res, {
      title: `Compare ${f.name_en} v${a} ↔ v${b} · Build Ledger`, active: 'products',
      body: `<nav class="dim" aria-label="Breadcrumb"><a href="/library/ledger/f/${e(f.slug)}">${e(f.name_en)}</a> › Compare</nav><h1>Compare v${a} ↔ v${b}</h1>
<form method="get" class="row noprint">${sel('a', a)}${sel('b', b)}<input type="hidden" name="view" value="${view}"><button type="submit">Compare</button></form>
<div class="row noprint" role="group" aria-label="View">${tab('text', 'Steps added / removed')}${tab('side', 'Side by side')}${tab('overlay', 'Overlay slider')}</div>${body}`,
    });
  });

  // ---------- audit ----------
  const mondayOf = (iso) => {
    const d = new Date(`${iso}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  const etDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(iso));
  pages.get('/audit', (req, res) => {
    const c = ctx();
    const all = [...c.crs.values()];
    const cols = ['proposed', 'built_flag_off', 'staged', 'live', 'live_inferred', 'rolled_back', 'retired', 'abandoned'];
    const cnt = (p, s) => all.filter((cr) => cr.product_line === p && V.statusKey(cr) === s).length;
    const matrix = `<table class="mx"><caption class="sr">Changes by product line and status</caption><thead><tr><th scope="col">Product line</th>${cols.map((s) => `<th scope="col"><span aria-hidden="true">${V.STATUS[s][0]}</span> ${e(V.STATUS[s][1])}</th>`).join('')}</tr></thead>
<tbody>${c.products.map((p) => `<tr><th scope="row"><a href="/library/ledger/p/${e(p.slug)}">${e(p.name_en)}</a></th>${cols.map((s) => { const n = cnt(p.slug, s); return `<td>${n ? `<a href="/library/ledger?product=${e(p.slug)}&status=${s}">${n}</a>` : '<span class="dim">0</span>'}</td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
    const feats = [...c.features.values()].map((f) => [f, V.featureState(f, all, c.libItems.find((i) => i.slug === f.flow_artifact_slug))]);
    const fmatrix = `<table class="mx"><caption class="sr">What is live and what is switched off, per feature</caption><thead><tr><th scope="col">Feature</th><th scope="col">Live now</th><th scope="col">Built but not fully on</th></tr></thead><tbody>
${feats.map(([f, st]) => `<tr><th scope="row"><a href="/library/ledger/f/${e(f.slug)}">${e(f.name_en)}</a></th><td>${st.retiredBy ? V.badgeFor('retired') : st.live ? `${V.badge(st.live.cr)} v${st.live.v}` : st.mine.filter((cr) => cr.current === 'live').map((cr) => V.badge(cr)).slice(0, 1).join('') || '<span class="dim">—</span>'}</td>
<td>${st.mine.filter((cr) => ['built_flag_off', 'staged', 'proposed'].includes(cr.current)).map((cr) => `${V.badge(cr)} <a href="/library/ledger/cr/${e(cr.cr_id)}">${e(cr.cr_id)}</a>`).join('<br>') || '<span class="dim">—</span>'}</td></tr>`).join('')}</tbody></table>`;
    const wk = /^\d{4}-\d{2}-\d{2}$/.test(req.query.week || '') ? mondayOf(req.query.week) : mondayOf(todayET());
    const wkEnd = new Date(Date.parse(`${wk}T12:00:00Z`) + 6 * DAY).toISOString().slice(0, 10);
    const inWeek = (iso) => { const d = etDate(iso); return d >= wk && d <= wkEnd; };
    const made = all.filter((cr) => inWeek(cr.date)).sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const events = ledger.entries.filter((en) => !en.corrupt && inWeek(en.at) && ['status', 'amend', 'redact', 'share', 'inbox', 'review'].includes(en.type));
    const statusEv = events.filter((en) => en.type === 'status');
    const shift = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
    const byKind = {};
    for (const cr of made) byKind[cr.kind] = (byKind[cr.kind] || 0) + 1;
    const sentence = `Week of ${V.fmtDate(`${wk}T12:00:00Z`)}: ${made.length} ${made.length === 1 ? 'change' : 'changes'}${Object.keys(byKind).length ? ` (${Object.entries(byKind).map(([k, n]) => `${n} ${V.KIND[k].toLowerCase()}`).join(', ')})` : ''}, ${statusEv.length} status ${statusEv.length === 1 ? 'update' : 'updates'}, ${events.filter((en) => en.type === 'amend').length} amendments.`;
    const evLine = (en) => {
      const p = en.payload || {};
      const who = V.actorWord(en.actor);
      if (en.type === 'status') return `${V.badgeFor(p.to)} <a href="/library/ledger/cr/${e(p.cr_id)}">${e(p.cr_id)}</a> by ${who}${p.note ? ` — ${e(p.note)}` : ''}`;
      if (en.type === 'amend') return `<b>AMENDED</b> <a href="/library/ledger/cr/${e(p.cr_id)}">${e(p.cr_id)}</a> by ${who} — ${e(p.reason)}`;
      if (en.type === 'redact') return `<b>REDACTED</b> <a href="/library/ledger/cr/${e(p.cr_id)}">${e(p.cr_id)}</a> by ${who}`;
      if (en.type === 'share') return `<b>SHARE ${e(String(p.action).toUpperCase())}</b> ${e(p.share_id)}${p.label ? ` for ${e(p.label)}` : ''}`;
      if (en.type === 'inbox') return `<b>INBOX ${e(String(p.action).toUpperCase())}</b> ${e(p.title || p.candidate_id)}`;
      if (en.type === 'review') return `<b>SPOT-CHECK</b> <a href="/library/ledger/cr/${e(p.cr_id)}">${e(p.cr_id)}</a> ${p.verdict === 'ok' ? '✓ right' : '✕ wrong'}`;
      return e(en.type);
    };
    return page(req, res, {
      title: 'Audit · Build Ledger', active: 'audit', chain: ledger.chain,
      body: `<h1>Audit</h1>
<div class="row noprint"><a class="btn" href="/library/ledger/audit/print">▤ Print pack</a><a class="btn" href="/library/ledger/audit.csv">⇩ CSV of every record</a><a class="btn" href="/library/ledger/audit/spot-check">Spot-check</a><a class="btn" href="/library/ledger/synonyms">Search words</a></div>
<section aria-labelledby="h-wk"><h2 id="h-wk">Week in review</h2>
<div class="row noprint" style="margin-top:10px"><a class="btn" href="?week=${shift(wk, -7)}">← Previous week</a>${wk < mondayOf(todayET()) ? `<a class="btn" href="?week=${shift(wk, 7)}">Next week →</a>` : ''}</div>
<p class="tally" data-read style="margin-top:10px">${e(sentence)}</p>
${made.length ? `<ol class="list">${made.map((cr) => V.crItem(cr, c.products, c.features)).join('')}</ol>` : ''}
${events.length ? `<h3 style="margin-top:14px">Other entries this week</h3><ul class="list">${events.map((en) => `<li class="item"><div class="meta"><span>${V.fmtDate(en.at, true)}</span> <span>${evLine(en)}</span></div></li>`).join('')}</ul>` : ''}</section>
<section aria-labelledby="h-mx"><h2 id="h-mx">Live vs switched off, per feature</h2><div style="margin-top:12px;overflow-x:auto">${fmatrix}</div></section>
<section aria-labelledby="h-pm"><h2 id="h-pm">Every record by product line and status</h2><div style="margin-top:12px;overflow-x:auto">${matrix}</div></section>
<section class="card" aria-labelledby="h-ch"><h2 id="h-ch">Integrity</h2>${chainProof()}</section>`,
    });
  });
  function chainProof() {
    const ch = ledger.verify();
    const anchors = ledger.anchors();
    const last = anchors[anchors.length - 1];
    const r = report();
    return `<dl class="kv" data-read><dt>Chain</dt><dd>${ch.ok ? '✓ verified' : `✕ BROKEN at entry ${ch.brokenAt}`} · ${ch.count} entries · head <span class="mono">${e(ch.head.slice(7, 23))}</span> · checked ${V.fmtDate(ch.checkedAt, true)}</dd>
<dt>Sealed daily copies</dt><dd>${anchors.length} on the server${last ? ` · latest ${e(last.date)} (${last.count} entries, head <span class="mono">${e(String(last.head).slice(7, 23))}</span>)` : ''}</dd>
<dt>Mac backup</dt><dd>${r && r.backup ? `${r.backup.ok ? '✓' : '✕'} ${V.fmtDate(r.generated_at, true)} · ${r.backup.count} entries · ${r.backup.anchors} heads kept on the Mac${r.backup.problem ? ` · ${e(r.backup.problem)}` : ''}` : 'not reported yet'}</dd></dl>`;
  }
  const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  pages.get('/audit.csv', (req, res) => {
    const c = ctx();
    const head = ['cr_id', 'date', 'product_line', 'features', 'kind', 'title', 'status', 'live_proof', 'source', 'confidence', 'risk', 'user_impact', 'commits', 'repos', 'deploys', 'flow_pages', 'amended', 'summary_plain'];
    const rows = [...c.crs.values()].map((cr) => {
      const repos = (cr.evidence && cr.evidence.repos) || [];
      return [cr.cr_id, cr.date, cr.product_line, (cr.features || []).join(' '), cr.kind, cr.title, cr.current, cr.live_proof || '', (cr.provenance || {}).source, (cr.provenance || {}).confidence || '', cr.risk || '', cr.user_impact || '',
        repos.reduce((n, r) => n + r.commits.length, 0), repos.map((r) => r.repo).join(' '), ((cr.evidence && cr.evidence.deploys) || []).map((d) => d.deploy_id).join(' '),
        (cr.artifacts || []).map((a) => `${a.library_slug}@${a.version}`).join(' '), cr.amendments.length, cr.summary_plain];
    });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="build-ledger-${todayET()}.csv"` });
    res.send(`﻿${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`);
  });
  pages.get('/audit/print', (req, res) => {
    const c = ctx();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '2000-01-01';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '2999-12-31';
    const list = [...c.crs.values()].filter((cr) => { const d = etDate(cr.date); return d >= from && d <= to; }).sort((x, y) => String(x.date).localeCompare(String(y.date)));
    const sheet = (cr) => {
      const prod = c.products.find((p) => p.slug === cr.product_line);
      const repos = (cr.evidence && cr.evidence.repos) || [];
      return `<article class="card"><p class="tag">${e(cr.cr_id)} · ${e(prod ? prod.name_en : cr.product_line)} · ${V.fmtDate(cr.date)}</p><h2>${e(cr.title)}</h2>
<div class="meta">${V.kindChip(cr.kind)} ${V.badge(cr)}${cr.provenance && cr.provenance.source === 'backfill' ? `<span class="tag">Backfilled · ${e(cr.provenance.confidence)}</span>` : ''}</div>
<p>${e(cr.summary_plain)}</p>${cr.why ? `<p><b>Why:</b> ${e(cr.why)}</p>` : ''}
${(cr.what_changed || []).length || (cr.removed || []).length ? `<ul>${(cr.what_changed || []).map((w) => `<li>+ ${e(w)}</li>`).join('')}${(cr.removed || []).map((w) => `<li>− ${e(w)}</li>`).join('')}</ul>` : ''}
<p class="dim">Status: ${cr.history.map((h) => `${e(V.STATUS[h.to] ? V.STATUS[h.to][1] : h.to)} ${e(etDate(h.at))} (${V.actorWord(h.actor)})`).join(' → ')}</p>
<p class="dim mono">${repos.map((r) => `${e(r.repo)}: ${r.commits.map((x) => e(x.slice(0, 8))).join(' ')}`).join(' · ') || 'no commits'} · entry ${cr.seq} · ${e(cr.hash.slice(7, 23))}${cr.amendments.length ? ` · amended ${cr.amendments.length}×` : ''}</p></article>`;
    };
    return page(req, res, {
      title: `Build Ledger audit pack ${todayET()}`, active: 'audit',
      body: `<h1>Build Ledger — audit pack</h1><p data-read>Printed ${V.fmtDate(new Date().toISOString(), true)} · ${list.length} records${from !== '2000-01-01' || to !== '2999-12-31' ? ` from ${e(from)} to ${e(to)}` : ''}.</p>
<form method="get" class="row noprint"><label>From <input type="date" name="from" value="${from === '2000-01-01' ? '' : e(from)}"></label><label>To <input type="date" name="to" value="${to === '2999-12-31' ? '' : e(to)}"></label><button type="submit">Apply</button><button type="button" class="primary" data-act="print">▤ Print</button></form>
<section class="card"><h2>Integrity</h2>${chainProof()}</section>
${list.map(sheet).join('')}`,
    });
  });

  // ---------- spot-check (riskiest assumption: the plain words are right) ----------
  const spotChecks = () => ledger.entries.filter((en) => en.type === 'review' && en.payload && en.payload.kind === 'spotcheck');
  pages.get('/audit/spot-check', (req, res) => {
    const c = ctx();
    const checked = new Set(spotChecks().map((en) => en.payload.cr_id));
    const all = [...c.crs.values()].filter((cr) => !checked.has(cr.cr_id));
    // Stable for the week, so reloading does not reshuffle.
    const seed = mondayOf(todayET());
    const pickList = all.map((cr) => [crypto.createHash('sha1').update(seed + cr.cr_id).digest('hex'), cr]).sort((x, y) => x[0].localeCompare(y[0])).slice(0, Math.max(0, 10 - checked.size)).map((x) => x[1]);
    const verdicts = spotChecks();
    const wrong = verdicts.filter((en) => en.payload.verdict === 'wrong').length;
    return page(req, res, {
      title: 'Spot-check · Build Ledger', active: 'audit',
      body: `<h1>Spot-check</h1><p data-read>Is what Claude wrote right — the product, an honest summary, a true status? Check ${10} records by hand. If more than 2 are wrong, the template gets tightened.</p>
<p class="tally" data-read>${verdicts.length} checked so far · ${verdicts.length - wrong} right · ${wrong} wrong</p>
${pickList.length ? `<ol class="list">${pickList.map((cr) => `<li class="item" data-nav>${V.crItem(cr, c.products, c.features).replace(/^<li class="item" data-nav>|<\/li>$/g, '')}
<form method="post" action="/library/ledger/act/spot-check" class="row">${csrfField(req)}<input type="hidden" name="cr_id" value="${e(cr.cr_id)}"><input type="hidden" name="back" value="/library/ledger/audit/spot-check">
<input type="text" name="note" maxlength="200" placeholder="what is wrong (optional)" aria-label="What is wrong"><button type="submit" name="verdict" value="ok">✓ Right</button><button type="submit" name="verdict" value="wrong">✕ Something is wrong</button></form></li>`).join('')}</ol>` : '<p class="banner">✓ 10 records checked.</p>'}`,
    });
  });
  pages.post('/act/spot-check', ...ownerPost((req, res) => {
    const cr = ledger.state().crs.get(String(req.body.cr_id));
    if (!cr) throw new LedgerError('no such record');
    const verdict = req.body.verdict === 'wrong' ? 'wrong' : 'ok';
    ledger.addEvent('review', { kind: 'spotcheck', cr_id: cr.cr_id, verdict, note: String(req.body.note || '').slice(0, 200) }, OWNER_ACTOR);
    return done(res, '/library/ledger/audit/spot-check', `${cr.cr_id}: ${verdict === 'ok' ? 'right' : 'wrong — amend it when you can'}`);
  }));

  // ---------- backfill inbox ----------
  function candidateSheet(cand, c) {
    const d = cand.draft;
    const prod = c.products.find((p) => p.slug === d.product_line);
    const feats = (d.features || []).map((s) => c.features.get(s) || (d.new_feature && d.new_feature.slug === s ? d.new_feature : { name_en: s }));
    const repos = (d.evidence && d.evidence.repos) || [];
    return `<article class="card" aria-labelledby="cand-h"><p class="tag">Candidate ${e(cand.id)} · backfilled · ${e(d.provenance.confidence)} confidence</p>
<h2 id="cand-h" data-read>${e(d.title)}</h2>
<div class="meta" data-read>${V.kindChip(d.kind)} ${V.badgeFor(d.status === 'live' ? 'live_inferred' : d.status)} <span>${V.fmtDate(d.occurred_at || cand.added_at)}</span><span class="dim">${e(prod ? prod.name_en : d.product_line)} › ${feats.map((f) => e(f.name_en)).join(', ')}</span></div>
<p data-read style="font-weight:700">${e(d.summary_plain)}</p>${d.why ? `<p data-read><b>Why:</b> ${e(d.why)}</p>` : ''}
${(d.what_changed || []).length || (d.removed || []).length ? `<ul data-read>${(d.what_changed || []).map((w) => `<li><span class="plus">+ ADDED</span> ${e(w)}</li>`).join('')}${(d.removed || []).map((w) => `<li><span class="minus">− REMOVED</span> ${e(w)}</li>`).join('')}</ul>` : ''}
<p class="dim">Source: ${e((d.provenance.notes || []).join(' · ') || 'not given')}</p>
<p class="dim mono">${repos.map((r) => `${e(r.repo)}: ${r.commits.map((x) => e(x.slice(0, 8))).join(' ')}`).join(' · ') || 'no commits'}</p></article>`;
  }
  pages.get('/inbox', (req, res) => {
    const c = ctx();
    const pend = pendingInbox();
    const skip = Math.max(0, Number(req.query.skip) || 0) % Math.max(1, pend.length);
    const cand = pend[skip];
    const decided = inbox().filter((x) => x.state !== 'pending');
    if (!cand) {
      return page(req, res, {
        title: 'Inbox · Build Ledger', active: 'inbox',
        body: `<h1>Inbox</h1><p class="banner"><span aria-hidden="true">✓</span> Nothing waiting. ${decided.length} decided so far.</p>
<p data-read>Backfilled records (rebuilt from old notes and commits) land here one at a time for you to accept, edit, merge into an existing record, or discard.</p>`,
      });
    }
    const near = [...c.crs.values()].filter((cr) => cr.product_line === cand.draft.product_line).sort((x, y) => Math.abs(Date.parse(x.date) - Date.parse(cand.draft.occurred_at || 0)) - Math.abs(Date.parse(y.date) - Date.parse(cand.draft.occurred_at || 0))).slice(0, 12);
    const hidden = `${csrfField(req)}<input type="hidden" name="id" value="${e(cand.id)}"><input type="hidden" name="back" value="/library/ledger/inbox">`;
    return page(req, res, {
      title: 'Inbox · Build Ledger', active: 'inbox',
      body: `<h1>Inbox — ${pend.length} waiting</h1><p class="dim" data-read>Card ${skip + 1} of ${pend.length}. Keys: A accept · E edit · M merge · D discard · N next.</p>
${candidateSheet(cand, c)}
<div class="row noprint">
<form method="post" action="/library/ledger/act/inbox">${hidden}<button type="submit" name="action" value="accept" class="primary" data-key="a"><span><u>A</u>ccept</span></button></form>
<a class="btn" href="/library/ledger/inbox/${e(cand.id)}/edit" data-key="e"><span><u>E</u>dit</span></a>
<a class="btn" href="?skip=${skip + 1}" data-key="n"><span><u>N</u>ext</span></a></div>
<details class="card noprint" id="merge"><summary data-key="m"><u>M</u>erge into an existing record</summary>
<form method="post" action="/library/ledger/act/inbox" class="stack">${hidden}<input type="hidden" name="action" value="merge">
<label>Record<select name="into">${near.map((cr) => `<option value="${e(cr.cr_id)}">${e(cr.cr_id)} · ${e(String(cr.date).slice(0, 10))} · ${e(cr.title)}</option>`).join('')}</select></label>
<p class="dim">Its commits and pages are attached to that record. The candidate's words are not kept.</p><div><button type="submit">Merge</button></div></form></details>
<details class="card noprint" id="discard"><summary data-key="d"><u>D</u>iscard</summary>
<form method="post" action="/library/ledger/act/inbox" class="stack">${hidden}<input type="hidden" name="action" value="discard">
<label>Why (optional)<input type="text" name="reason" maxlength="200" placeholder="for example: not product work"></label><div><button type="submit">Discard</button></div></form></details>`,
    });
  });
  pages.get('/inbox/:id/edit', (req, res) => {
    const c = ctx();
    const cand = pendingInbox().find((x) => x.id === req.params.id);
    if (!cand) return page(req, res, V.notFound('No such waiting candidate.'), 404);
    const d = cand.draft;
    return page(req, res, {
      title: `Edit ${cand.id} · Build Ledger`, active: 'inbox',
      body: `<nav class="dim" aria-label="Breadcrumb"><a href="/library/ledger/inbox">Inbox</a> › Edit ${e(cand.id)}</nav><h1>Edit, then accept</h1>
<form method="post" action="/library/ledger/act/inbox" class="card stack">${csrfField(req)}<input type="hidden" name="id" value="${e(cand.id)}"><input type="hidden" name="action" value="accept"><input type="hidden" name="edited" value="1"><input type="hidden" name="back" value="/library/ledger/inbox/${e(cand.id)}/edit">
${fieldInputs({ ...d, features: d.features }, d.new_feature ? { ...c, features: new Map([...c.features, [d.new_feature.slug, { ...d.new_feature, product_line: d.product_line }]]) } : c)}
<div class="row"><label>Status<select name="status">${['proposed', 'built_flag_off', 'staged', 'live', 'abandoned'].map((s) => `<option value="${s}"${d.status === s ? ' selected' : ''}>${e(V.STATUS[s === 'live' ? 'live_inferred' : s][1])}</option>`).join('')}</select></label>
<label>Confidence<select name="confidence">${['high', 'medium', 'low'].map((x) => `<option${d.provenance.confidence === x ? ' selected' : ''}>${x}</option>`).join('')}</select></label></div>
<div class="row"><button type="submit" class="primary">Save and accept</button><a class="btn" href="/library/ledger/inbox">Cancel</a></div></form>`,
    });
  });
  pages.post('/act/inbox', ...ownerPost((req, res) => {
    const list = inbox();
    const cand = list.find((x) => x.id === req.body.id && x.state === 'pending');
    if (!cand) throw new LedgerError('that candidate is no longer waiting');
    const action = String(req.body.action);
    const now = new Date().toISOString();
    let msg;
    if (action === 'accept') {
      const draft = JSON.parse(JSON.stringify(cand.draft));
      if (req.body.edited === '1') {
        Object.assign(draft, readFields(req.body));
        for (const k of ['why', 'rollback_plan', 'risk', 'user_impact']) if (!req.body[k]) delete draft[k];
        if (STATUSES.includes(req.body.status)) draft.status = req.body.status;
        if (['high', 'medium', 'low'].includes(req.body.confidence)) draft.provenance.confidence = req.body.confidence;
        if (draft.new_feature && !draft.features.includes(draft.new_feature.slug)) delete draft.new_feature;
      }
      draft.provenance = { ...draft.provenance, reviewed_by: 'owner', reviewed_at: now, candidate_id: cand.id, ...(req.body.edited === '1' ? { edited_by_owner: true } : {}) };
      const ev = ledger.addChange(draft, OWNER_ACTOR);
      Object.assign(cand, { state: 'accepted', decided_at: now, cr_id: ev.payload.cr_id });
      msg = `Accepted as ${ev.payload.cr_id}.`;
    } else if (action === 'merge') {
      const into = String(req.body.into || '');
      const repos = (cand.draft.evidence && cand.draft.evidence.repos) || [];
      ledger.addLink({ cr_id: into, ...(repos.length ? { repos } : {}), ...((cand.draft.artifacts || []).length ? { artifacts: cand.draft.artifacts } : {}), note: `merged backfill candidate ${cand.id}` }, OWNER_ACTOR);
      Object.assign(cand, { state: 'merged', decided_at: now, cr_id: into });
      msg = `Merged into ${into}.`;
    } else if (action === 'discard') {
      const commits = ((cand.draft.evidence || {}).repos || []).flatMap((r) => r.commits);
      ledger.addEvent('inbox', { action: 'discard', candidate_id: cand.id, title: cand.draft.title, reason: String(req.body.reason || '').slice(0, 200), commits }, OWNER_ACTOR);
      Object.assign(cand, { state: 'discarded', decided_at: now, reason: String(req.body.reason || '').slice(0, 200) });
      msg = 'Discarded.';
    } else throw new LedgerError('unknown action');
    ledger.writeState('inbox.json', list);
    resetSearch();
    return done(res, '/library/ledger/inbox', `${cand.id}: ${msg}`);
  }));

  // ---------- synonyms editor ----------
  const groupsText = (obj) => Object.entries(obj || {}).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n');
  const parseGroups = (text, what) => {
    const out = {};
    for (const [i, ln] of String(text || '').split('\n').entries()) {
      if (!ln.trim()) continue;
      const m = /^\s*([a-z0-9_-]{1,40})\s*:\s*(.+)$/i.exec(ln);
      if (!m) throw new LedgerError(`${what}, line ${i + 1}: write it as  name: word, word, word`);
      out[m[1].toLowerCase()] = [...new Set(m[2].split(',').map((x) => x.trim()).filter(Boolean))].slice(0, 40);
    }
    return out;
  };
  pages.get('/synonyms', (req, res) => {
    const syn = ledger.synonyms();
    return page(req, res, {
      title: 'Search words · Build Ledger', active: 'audit',
      body: `<h1>Search words</h1><p data-read>When a search contains any word of a group, the other words of that group are searched too. One group per line: a name, a colon, then the words separated by commas. Product and feature names are added on their own.</p>
<form method="post" action="/library/ledger/act/synonyms" class="card stack">${csrfField(req)}<input type="hidden" name="back" value="/library/ledger/synonyms">
<label>Word groups<textarea name="groups" rows="14" spellcheck="false">${e(groupsText(syn.groups))}</textarea></label>
<label>Words that mean a kind of change (names must be: ${KINDS.join(', ')})<textarea name="kinds" rows="7" spellcheck="false">${e(groupsText(syn.kinds || {}))}</textarea></label>
<p class="dim">Leave the second box empty to use the built-in words. The previous version is kept on the server every time you save.</p>
<div><button type="submit" class="primary">Save search words</button></div></form>`,
    });
  });
  pages.post('/act/synonyms', ...ownerPost((req, res) => {
    const groups = parseGroups(req.body.groups, 'Word groups');
    const kinds = parseGroups(req.body.kinds, 'Kinds');
    for (const k of Object.keys(kinds)) if (!KINDS.includes(k)) throw new LedgerError(`Kinds: "${k}" is not a kind of change`);
    const f = scan({ groups, kinds });
    if (f.length) throw new LedgerError(`refused: sensitive data in ${describe(f)}`);
    ledger.writeRegistry('synonyms.json', { groups, ...(Object.keys(kinds).length ? { kinds } : {}) });
    ledger.addEvent('registry', { what: 'synonyms', groups: Object.keys(groups).length, kinds: Object.keys(kinds).length }, OWNER_ACTOR);
    resetSearch();
    return done(res, '/library/ledger/synonyms', `Saved ${Object.keys(groups).length} word groups.`);
  }));

  // ---------- needs page ----------
  pages.get('/needs', (req, res) => {
    const n = needs();
    return page(req, res, { title: 'Needs you · Build Ledger', active: 'home', body: `<h1>Needs you (${n.length})</h1>${needsList(n, true)}` });
  });

  // ---------- agent API ----------
  const json = express.json({ limit: '2mb' });
  const wrapApi = (fn) => (req, res) => {
    try { return fn(req, res); } catch (err) {
      if (err instanceof LedgerError) return res.status(err.status).json({ ok: false, error: err.message });
      console.error('ledger api error:', err.message);
      return res.status(500).json({ ok: false, error: 'server error' });
    }
  };
  api.post('/inbox', json, wrapApi((req, res) => {
    const cands = Array.isArray(req.body && req.body.candidates) ? req.body.candidates : null;
    if (!cands || !cands.length || cands.length > 200) throw new LedgerError('send { candidates: [draft, …] } (1–200)');
    const list = inbox();
    const recordedCommits = new Set(ledger.commits());
    const waitingCommits = new Set(list.filter((x) => x.state === 'pending').flatMap((x) => ((x.draft.evidence || {}).repos || []).flatMap((r) => r.commits)));
    const added = []; const skipped = [];
    cands.forEach((d, i) => {
      const draft = JSON.parse(JSON.stringify(d));
      if (!draft.provenance || draft.provenance.source !== 'backfill') throw new LedgerError(`candidate ${i + 1}: provenance.source must be "backfill"`);
      const commits = ((draft.evidence || {}).repos || []).flatMap((r) => r.commits || []);
      if (commits.length && commits.every((c) => recordedCommits.has(c) || waitingCommits.has(c))) { skipped.push({ i: i + 1, why: 'its commits are already recorded or waiting' }); return; }
      try { ledger.validateChange(JSON.parse(JSON.stringify(draft)), 'agent'); } catch (err) { throw new LedgerError(`candidate ${i + 1} (${draft.title || 'untitled'}): ${err.message}`); }
      const f = scan(draft);
      if (f.length) throw new LedgerError(`candidate ${i + 1}: sensitive data in ${describe(f)}`);
      const id = `BF-${String(list.length + 1).padStart(4, '0')}`;
      list.push({ id, state: 'pending', added_at: new Date().toISOString(), session_id: req.actor.session_id, draft });
      commits.forEach((c) => waitingCommits.add(c));
      added.push(id);
    });
    ledger.writeState('inbox.json', list);
    res.json({ ok: true, added, skipped, waiting: list.filter((x) => x.state === 'pending').length });
  }));
  api.get('/inbox', wrapApi((req, res) => res.json({ ok: true, inbox: inbox().map((x) => ({ id: x.id, state: x.state, title: x.draft.title, cr_id: x.cr_id || null })) })));
  api.post('/needs', json, wrapApi((req, res) => {
    const b = req.body || {};
    const clean = (s, n) => String(s == null ? '' : s).slice(0, n);
    const r = {
      generated_at: new Date().toISOString(),
      unrecorded_commits: (Array.isArray(b.unrecorded_commits) ? b.unrecorded_commits : []).slice(0, 500).map((c) => {
        const subject = clean(c.subject, 120);
        return { repo: clean(c.repo, 40), sha: clean(c.sha, 40), date: clean(c.date, 30), subject: scan({ subject }).length ? '(subject hidden: looked sensitive)' : subject };
      }),
      hook_giveups: (Array.isArray(b.hook_giveups) ? b.hook_giveups : []).slice(0, 100).map((g) => ({ at: clean(g.at, 30), items: clean(g.items, 300) })),
      backup: b.backup && typeof b.backup === 'object' ? { ok: Boolean(b.backup.ok), count: Number(b.backup.count) || 0, anchors: Number(b.backup.anchors) || 0, problem: clean(b.backup.problem, 300) || null } : null,
    };
    ledger.writeState('needs.json', r);
    res.json({ ok: true });
  }));
  api.get('/needs', wrapApi((req, res) => res.json({ ok: true, needs: needs() })));
  api.post('/amend', json, wrapApi((req, res) => {
    const ev = ledger.addAmend(req.body || {}, req.actor);
    resetSearch();
    res.json({ ok: true, cr_id: ev.payload.cr_id, fields: Object.keys(ev.payload.patch), seq: ev.seq });
  }));
  // Full copy of the ledger for the Mac's own backup and independent check.
  api.get('/export', wrapApi((req, res) => {
    res.set({ 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    res.send(fs.existsSync(ledger.file) ? fs.readFileSync(ledger.file) : '');
  }));

  return { needsPanel, ownerPanel, isOwner, page };
};
