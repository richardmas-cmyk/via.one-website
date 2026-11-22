// Build Ledger storage: one append-only JSONL file with a hash chain.
//
//   envelope = { seq, type, at, actor, payload, payload_hash, prev_hash, hash }
//   payload_hash = sha256(canonical(payload))
//   hash         = sha256(seq|type|at|canonical(actor)|payload_hash|prev_hash)
//
// Nothing is ever edited or deleted. Status changes, corrections and late links are
// new entries. A broken chain puts the ledger in read-only mode.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { scan, describe } = require('./scan');

const GENESIS = `sha256:${'0'.repeat(64)}`;
const sha = (s) => `sha256:${crypto.createHash('sha256').update(s).digest('hex')}`;
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const envelopeHash = (e) => sha(`${e.seq}|${e.type}|${e.at}|${canonical(e.actor)}|${e.payload_hash}|${e.prev_hash}`);

const KINDS = ['build', 'modify', 'remove', 'config_flag', 'incident_fix', 'doc', 'revert'];
const STATUSES = ['proposed', 'built_flag_off', 'staged', 'live', 'rolled_back', 'retired', 'abandoned'];
const TRANSITIONS = {
  proposed: ['built_flag_off', 'staged', 'live', 'abandoned'],
  built_flag_off: ['staged', 'live', 'abandoned'],
  staged: ['live', 'built_flag_off', 'rolled_back', 'abandoned'],
  live: ['rolled_back', 'retired'],
  rolled_back: ['built_flag_off', 'staged'],
  retired: [],
  abandoned: [],
};
const FEATURE_TYPES = ['consumer-flow', 'partner-api', 'internal-tool', 'job', 'integration'];
const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;
const ROLES = ['flow', 'sheet', 'diagram', 'evidence'];

const AMENDABLE = ['product_line', 'features', 'kind', 'title', 'summary_plain', 'why', 'what_changed', 'removed', 'open_items', 'rollback_plan', 'risk', 'user_impact', 'tags', 'search_terms_es'];
const REDACTABLE = ['title', 'summary_plain', 'why', 'what_changed', 'removed', 'open_items', 'rollback_plan', 'status_notes'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

class LedgerError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'ledger.jsonl');
    this.entries = [];
    this.chain = { ok: true, count: 0, head: GENESIS, brokenAt: null, checkedAt: null };
    this.load();
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    const text = fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : '';
    this.entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { this.entries.push(JSON.parse(line)); } catch (e) { this.entries.push({ seq: this.entries.length + 1, corrupt: true }); }
    }
    this.verify();
  }

  verify() {
    let prev = GENESIS;
    let brokenAt = null;
    // A redacted entry no longer matches its payload_hash. It is accepted only when a
    // later "redact" entry names it and carries the hash of the redacted payload.
    const vouched = new Map();
    for (const e of this.entries) {
      if (e && e.type === 'redact' && e.payload) for (const t of e.payload.targets || []) vouched.set(t.seq, t.redacted_payload_hash);
    }
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const ph = e.corrupt ? null : sha(canonical(e.payload));
      const payloadOk = ph === e.payload_hash || (e.payload && e.payload.redacted && vouched.get(e.seq) === ph);
      if (e.corrupt || e.seq !== i + 1 || e.prev_hash !== prev || !payloadOk || envelopeHash(e) !== e.hash) { brokenAt = i + 1; break; }
      prev = e.hash;
    }
    const anchor = brokenAt === null ? this.checkAnchors() : null;
    this.chain = {
      ok: brokenAt === null && !anchor, count: this.entries.length, head: prev, brokenAt: brokenAt || (anchor && anchor.seq) || null,
      anchorProblem: anchor ? anchor.problem : null, checkedAt: new Date().toISOString(),
    };
    return this.chain;
  }

  // ---------- sealed daily copies ("anchors") ----------
  // anchors.jsonl holds { date, count, head, file_sha256 } per day; anchors/<date>.jsonl
  // is the copy. A later rewrite of history shows up as a head that no longer matches.
  anchors() {
    const f = path.join(this.dir, 'anchors.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  }
  checkAnchors() {
    for (const a of this.anchors()) {
      if (!a.count) continue;
      if (a.count > this.entries.length) return { seq: this.entries.length, problem: `entries are missing: the ${a.date} copy had ${a.count}, now ${this.entries.length}` };
      const e = this.entries[a.count - 1];
      if (!e || e.hash !== a.head) return { seq: a.count, problem: `entry ${a.count} no longer matches the sealed copy of ${a.date}` };
    }
    return null;
  }
  anchor(date, { keepDays = 60 } = {}) {
    const list = this.anchors();
    if (list.some((a) => a.date === date)) return null;
    const dir = path.join(this.dir, 'anchors');
    fs.mkdirSync(dir, { recursive: true });
    const text = fs.existsSync(this.file) ? fs.readFileSync(this.file) : Buffer.alloc(0);
    const copy = path.join(dir, `${date}.jsonl`);
    fs.writeFileSync(copy, text, { flag: 'wx' });
    const last = this.entries[this.entries.length - 1];
    const a = { date, count: this.entries.length, head: last ? last.hash : GENESIS, file_sha256: sha(text), at: new Date().toISOString() };
    fs.appendFileSync(path.join(this.dir, 'anchors.jsonl'), `${JSON.stringify(a)}\n`);
    const cutoff = Date.now() - keepDays * 864e5;
    for (const name of fs.readdirSync(dir)) {
      const d = Date.parse(name.slice(0, 10));
      if (!isNaN(d) && d < cutoff) { try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* ignore */ } }
    }
    return a;
  }

  readJSON(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch (e) { return fallback; }
  }

  // Product registry (names, aliases, path hints). Kept beside the ledger; every
  // replacement keeps the previous copy.
  products() { return this.readJSON('products.json', []); }
  synonyms() { return this.readJSON('synonyms.json', {}); }
  writeRegistry(name, value) {
    const target = path.join(this.dir, name);
    if (fs.existsSync(target)) fs.copyFileSync(target, path.join(this.dir, `${name}.${Date.now()}.bak`));
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
  }

  // Workflow files (inbox, shares, nightly report): replaced atomically, not history.
  writeState(name, value) {
    const target = path.join(this.dir, name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, target);
  }

  append(type, payload, actor) {
    if (!this.chain.ok) throw new LedgerError(`ledger is read-only: chain broken at entry ${this.chain.brokenAt}`, 503);
    const findings = scan(payload);
    if (findings.length) throw new LedgerError(`refused: sensitive data in ${describe(findings)}`);
    const last = this.entries[this.entries.length - 1];
    const e = {
      seq: this.entries.length + 1, type, at: new Date().toISOString(), actor,
      payload, payload_hash: sha(canonical(payload)), prev_hash: last ? last.hash : GENESIS,
    };
    e.hash = envelopeHash(e);
    const fd = fs.openSync(this.file, 'a');
    try { fs.writeSync(fd, `${JSON.stringify(e)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.entries.push(e);
    this.chain = { ...this.chain, count: e.seq, head: e.hash, checkedAt: new Date().toISOString() };
    return e;
  }

  // ---------- derived state (a pure fold over the entries) ----------
  // upto = only the first N entries (how the ledger read at that moment; used by
  // pinned partner links).
  state(upto) {
    const pinned = upto != null && upto < this.entries.length;
    if (!pinned && this._state && this._state.count === this.entries.length) return this._state;
    const crs = new Map();
    const features = new Map();
    for (const e of pinned ? this.entries.slice(0, upto) : this.entries) {
      if (e.corrupt || !e.payload) continue;
      const p = e.payload;
      if (e.type === 'change') {
        const cr = {
          ...p, seq: e.seq, recorded_at: e.at, actor: e.actor, hash: e.hash,
          history: [{ to: p.status, at: e.at, actor: e.actor, note: 'recorded', evidence: null, seq: e.seq }],
          amendments: [], links: [], current: p.status, redactions: [],
        };
        crs.set(p.cr_id, cr);
        if (p.new_feature) {
          features.set(p.new_feature.slug, {
            ...p.new_feature, product_line: p.product_line, created_by_cr: p.cr_id,
          });
        }
      } else if (e.type === 'status') {
        const cr = crs.get(p.cr_id);
        if (!cr) continue;
        cr.history.push({ from: p.from, to: p.to, at: e.at, actor: e.actor, note: p.note || '', evidence: p.evidence || null, seq: e.seq });
        cr.current = p.to;
      } else if (e.type === 'link') {
        const cr = crs.get(p.cr_id);
        if (!cr) continue;
        cr.links.push({ ...p, at: e.at, seq: e.seq });
        if (p.artifacts) cr.artifacts = [...(cr.artifacts || []), ...p.artifacts];
        if (p.repos) cr.evidence = { ...cr.evidence, repos: [...((cr.evidence && cr.evidence.repos) || []), ...p.repos] };
        if (p.deploys) cr.evidence = { ...cr.evidence, deploys: [...((cr.evidence && cr.evidence.deploys) || []), ...p.deploys] };
        if (p.unlink_commits) {
          const gone = (c) => p.unlink_commits.some((u) => c.startsWith(u));
          cr.evidence = { ...cr.evidence, repos: ((cr.evidence && cr.evidence.repos) || []).map((r) => ({ ...r, commits: r.commits.filter((c) => !gone(c)) })).filter((r) => r.commits.length) };
          cr.unlinked = [...(cr.unlinked || []), { commits: p.unlink_commits, note: p.note, at: e.at, actor: e.actor }];
        }
      } else if (e.type === 'amend') {
        const cr = crs.get(p.cr_id);
        if (!cr) continue;
        cr.amendments.push({ patch: p.patch, reason: p.reason, at: e.at, actor: e.actor, original: Object.fromEntries(Object.keys(p.patch || {}).map((k) => [k, cr[k]])) });
        Object.assign(cr, p.patch);
      } else if (e.type === 'redact') {
        const cr = crs.get(p.cr_id);
        if (cr) cr.redactions.push({ fields: p.fields, reason: p.reason, at: e.at, actor: e.actor });
      } else if (e.type === 'retire_feature') {
        const f = features.get(p.feature);
        if (f) f.retired = { at: e.at, actor: e.actor, reason: p.reason };
      }
    }
    for (const cr of crs.values()) {
      const deployed = ((cr.evidence && cr.evidence.deploys) || []).length > 0;
      const ownerLive = cr.history.some((h) => h.to === 'live' && h.actor && h.actor.kind === 'owner');
      const evLive = cr.history.some((h) => h.to === 'live' && h.evidence && (h.evidence.deploy_id || h.evidence.flag_snapshot));
      cr.live_proof = cr.current !== 'live' ? null : ownerLive ? 'owner-confirmed' : (deployed || evLive) ? 'deploy' : 'inferred';
      cr.date = cr.occurred_at || cr.recorded_at;
    }
    const out = { count: pinned ? upto : this.entries.length, crs, features };
    if (!pinned) this._state = out;
    return out;
  }

  nextId() {
    const n = this.entries.filter((e) => e.type === 'change').length + 1;
    return `CR-${String(n).padStart(4, '0')}`;
  }

  // ---------- validation of incoming writes ----------
  validateChange(p, actorKind) {
    const err = (m) => { throw new LedgerError(m); };
    if (!p || typeof p !== 'object') err('body must be a change record');
    const allowed = ['cr_id', 'schema', 'occurred_at', 'product_line', 'features', 'new_feature', 'kind', 'title', 'summary_plain', 'why',
      'what_changed', 'removed', 'removes_feature', 'user_impact', 'risk', 'status', 'rollback_plan', 'open_items', 'session', 'evidence', 'artifacts',
      'reverts', 'supersedes', 'related', 'incident', 'tags', 'search_terms_es', 'provenance', 'attest_no_sensitive_data', 'override_reason'];
    for (const k of Object.keys(p)) if (!allowed.includes(k)) err(`unknown field "${k}"`);
    const str = (k, max, req = true) => {
      if (p[k] == null || p[k] === '') { if (req) err(`"${k}" is required`); return; }
      if (typeof p[k] !== 'string' || p[k].length > max) err(`"${k}" must be text of at most ${max} characters`);
    };
    const list = (k, maxItems, maxLen) => {
      if (p[k] == null) return;
      if (!Array.isArray(p[k]) || p[k].length > maxItems || p[k].some((x) => typeof x !== 'string' || x.length > maxLen)) err(`"${k}" must be a list of at most ${maxItems} short texts`);
    };
    p.schema = 'change-record.v1';
    if (p.attest_no_sensitive_data !== true) err('"attest_no_sensitive_data" must be true');
    const products = this.products();
    if (!products.some((x) => x.slug === p.product_line)) err(`unknown product_line "${p.product_line}" (known: ${products.map((x) => x.slug).join(', ')})`);
    if (!KINDS.includes(p.kind)) err(`kind must be one of ${KINDS.join(', ')}`);
    if (!STATUSES.includes(p.status) || ['rolled_back', 'retired'].includes(p.status)) err('status must be proposed, built_flag_off, staged, live or abandoned');
    str('title', 80); str('summary_plain', 400); str('why', 600, false); str('rollback_plan', 400, false);
    str('occurred_at', 40, false); str('reverts', 20, false); str('incident', 80, false); str('override_reason', 300, false);
    if (p.occurred_at && isNaN(Date.parse(p.occurred_at))) err('"occurred_at" must be a date');
    list('what_changed', 12, 160); list('removed', 12, 160); list('open_items', 12, 200); list('tags', 20, 40);
    list('search_terms_es', 20, 60); list('supersedes', 20, 20); list('related', 20, 20);
    if (p.user_impact != null && !['none', 'internal', 'partner', 'consumer'].includes(p.user_impact)) err('user_impact must be none, internal, partner or consumer');
    if (p.risk != null && !['low', 'medium', 'high'].includes(p.risk)) err('risk must be low, medium or high');
    if (!Array.isArray(p.features) || !p.features.length || p.features.some((f) => !SLUG.test(String(f)))) err('"features" must list at least one feature slug');

    const { features } = this.state();
    if (p.new_feature) {
      const nf = p.new_feature;
      if (p.kind !== 'build') err('only a build record can create a feature');
      if (!SLUG.test(String(nf.slug || ''))) err('new_feature.slug must be lowercase letters, numbers and dashes');
      if (features.has(nf.slug)) err(`feature "${nf.slug}" already exists`);
      if (!nf.name_en || !nf.name_es) err('new_feature needs name_en and name_es');
      if (!FEATURE_TYPES.includes(nf.type)) err(`new_feature.type must be one of ${FEATURE_TYPES.join(', ')}`);
      if (!p.features.includes(nf.slug)) p.features.unshift(nf.slug);
      for (const k of Object.keys(nf)) if (!['slug', 'name_en', 'name_es', 'type', 'aliases', 'flow_artifact_slug', 'summary'].includes(k)) err(`unknown new_feature field "${k}"`);
    }
    for (const f of p.features) {
      if (!features.has(f) && !(p.new_feature && p.new_feature.slug === f)) err(`unknown feature "${f}" — only a build record with new_feature can create one`);
    }

    const ev = p.evidence = p.evidence || {};
    const repos = ev.repos || [];
    const commitCount = repos.reduce((n, r) => n + ((r && r.commits) || []).length, 0);
    for (const r of repos) {
      if (!r || typeof r.repo !== 'string' || !Array.isArray(r.commits) || r.commits.some((c) => !/^[0-9a-f]{7,40}$/.test(c))) err('evidence.repos entries need repo and commit SHAs');
      if (r.diff || r.patch) err('code diffs are never stored — diffstat and file names only');
    }
    if (!commitCount && ev.no_code !== true && !(p.artifacts || []).length) err('a record needs commits, a library page, or evidence.no_code = true');
    for (const a of p.artifacts || []) {
      if (!SLUG.test(String(a.library_slug || '')) || !Number.isInteger(a.version) || !ROLES.includes(a.role)) err('artifacts need library_slug, version (number) and role (flow, sheet, diagram, evidence)');
    }
    const prov = p.provenance = p.provenance || { source: 'session' };
    if (!['session', 'backfill', 'owner'].includes(prov.source)) err('provenance.source must be session, backfill or owner');
    if (prov.source === 'owner' && actorKind !== 'owner') err('only the owner can file owner records');
    if (prov.source === 'backfill' && !['high', 'medium', 'low'].includes(prov.confidence)) err('backfilled records need provenance.confidence (high, medium, low)');
    if (p.status === 'live' && prov.source === 'session' && !(ev.deploys || []).some((d) => d && d.deploy_id)) {
      err('status "live" needs proof: evidence.deploys with a deploy_id (or record it as staged / built_flag_off)');
    }
    if (!p.session || typeof p.session.session_id !== 'string') err('session.session_id is required');
    p.session.agent = p.session.agent || 'claude-code';
    if (p.reverts && !this.state().crs.has(p.reverts)) err(`reverts: no record ${p.reverts}`);
    if (p.removes_feature != null && typeof p.removes_feature !== 'boolean') err('removes_feature must be true or false');
    if (p.removes_feature && p.kind !== 'remove') err('removes_feature needs kind "remove"');
    return p;
  }

  addChange(body, actor) {
    const p = this.validateChange({ ...body }, actor.kind);
    p.cr_id = this.nextId();
    return this.append('change', p, actor);
  }

  addStatus(body, actor) {
    const { crs } = this.state();
    const cr = crs.get(String(body.cr_id || ''));
    if (!cr) throw new LedgerError(`no record ${body.cr_id}`, 404);
    const to = String(body.to || '');
    // The owner may confirm a record that is live without proof (live → live, owner-confirmed).
    const confirming = to === 'live' && cr.current === 'live' && cr.live_proof !== 'owner-confirmed' && actor.kind === 'owner';
    if (!confirming && !(TRANSITIONS[cr.current] || []).includes(to)) throw new LedgerError(`cannot go from ${cr.current} to ${to}`);
    const evidence = body.evidence && typeof body.evidence === 'object' ? body.evidence : null;
    if (actor.kind === 'agent') {
      if (!['built_flag_off', 'staged', 'live', 'abandoned'].includes(to)) throw new LedgerError('only the owner can mark a record rolled back or retired', 403);
      if (to === 'live' && !(evidence && evidence.deploy_id)) throw new LedgerError('live needs proof: evidence.deploy_id (or ask the owner to mark it live)');
    }
    const note = body.note == null ? '' : String(body.note).slice(0, 300);
    return this.append('status', { cr_id: cr.cr_id, from: cr.current, to, note, evidence }, actor);
  }

  addLink(body, actor) {
    const { crs } = this.state();
    const cr = crs.get(String(body.cr_id || ''));
    if (!cr) throw new LedgerError(`no record ${body.cr_id}`, 404);
    const p = { cr_id: cr.cr_id };
    if (body.artifacts) {
      for (const a of body.artifacts) if (!SLUG.test(String(a.library_slug || '')) || !Number.isInteger(a.version) || !ROLES.includes(a.role)) throw new LedgerError('artifacts need library_slug, version and role');
      p.artifacts = body.artifacts;
    }
    if (body.repos) {
      for (const r of body.repos) if (!r || typeof r.repo !== 'string' || !Array.isArray(r.commits) || r.commits.some((c) => !/^[0-9a-f]{7,40}$/.test(c))) throw new LedgerError('repos need repo and commit SHAs');
      p.repos = body.repos;
    }
    if (body.deploys) p.deploys = body.deploys;
    // A commit attached by mistake: a visible correction entry, never an edit.
    if (body.unlink_commits) {
      const list = [].concat(body.unlink_commits).map(String);
      const mine = ((cr.evidence && cr.evidence.repos) || []).flatMap((r) => r.commits);
      for (const c of list) if (!/^[0-9a-f]{7,40}$/.test(c) || !mine.some((m) => m.startsWith(c))) throw new LedgerError(`commit ${c} is not on ${cr.cr_id}`);
      if (!body.note || String(body.note).trim().length < 8) throw new LedgerError('unlinking a commit needs a note saying why');
      p.unlink_commits = list;
    }
    if (body.note) p.note = String(body.note).slice(0, 300);
    if (!p.artifacts && !p.repos && !p.deploys && !p.unlink_commits) throw new LedgerError('nothing to link');
    return this.append('link', p, actor);
  }

  // A correction. The original values stay visible on the record page.
  addAmend(body, actor) {
    const { crs } = this.state();
    const cr = crs.get(String(body.cr_id || ''));
    if (!cr) throw new LedgerError(`no record ${body.cr_id}`, 404);
    const reason = String(body.reason || '').trim();
    if (reason.length < 4) throw new LedgerError('an amendment needs a reason');
    const patch = body.patch && typeof body.patch === 'object' ? { ...body.patch } : null;
    if (!patch || !Object.keys(patch).length) throw new LedgerError('nothing to amend');
    for (const k of Object.keys(patch)) {
      if (!AMENDABLE.includes(k)) throw new LedgerError(`"${k}" cannot be amended (allowed: ${AMENDABLE.join(', ')})`);
      if (JSON.stringify(patch[k]) === JSON.stringify(cr[k])) delete patch[k];
    }
    if (!Object.keys(patch).length) throw new LedgerError('nothing changed');
    // Re-validate the record as it would read after the amendment.
    const merged = { ...pick(cr, ['product_line', 'features', 'kind', 'title', 'summary_plain', 'why', 'what_changed', 'removed', 'open_items', 'rollback_plan', 'risk', 'user_impact', 'tags', 'search_terms_es']), ...patch };
    this.validateFields(merged);
    return this.append('amend', { cr_id: cr.cr_id, patch, reason: reason.slice(0, 300) }, actor);
  }

  // Owner only. Replaces chosen fields of a record (and of its amendments) with a
  // visible marker, rewrites those lines in place, and appends a "redact" entry that
  // vouches for each rewritten line, so the chain still verifies.
  redact(body, actor) {
    if (actor.kind !== 'owner') throw new LedgerError('only the owner can redact', 403);
    if (!this.chain.ok) throw new LedgerError('ledger is read-only', 503);
    const { crs } = this.state();
    const cr = crs.get(String(body.cr_id || ''));
    if (!cr) throw new LedgerError(`no record ${body.cr_id}`, 404);
    if (String(body.confirm || '').trim().toUpperCase() !== `REDACT ${cr.cr_id}`) throw new LedgerError(`type REDACT ${cr.cr_id} to confirm`);
    const reason = String(body.reason || '').trim();
    if (reason.length < 4) throw new LedgerError('a redaction needs a reason');
    const fields = (Array.isArray(body.fields) ? body.fields : [body.fields]).filter((f) => REDACTABLE.includes(f));
    if (!fields.length) throw new LedgerError(`choose fields to redact (${REDACTABLE.join(', ')})`);
    const marker = `REDACTED — ${reason}`.slice(0, 78);
    const blank = (v) => (Array.isArray(v) ? v.map(() => marker) : marker);
    const targets = [];
    const rewritten = this.entries.map((e) => {
      if (!e.payload || e.payload.cr_id !== cr.cr_id) return e;
      let hit = null;
      if (e.type === 'change') for (const f of fields) if (e.payload[f] != null) { hit = hit || { ...e.payload }; hit[f] = blank(e.payload[f]); }
      if (e.type === 'amend' && e.payload.patch) {
        for (const f of fields) if (e.payload.patch[f] != null) { hit = hit || { ...e.payload, patch: { ...e.payload.patch } }; hit.patch[f] = blank(e.payload.patch[f]); }
      }
      if (e.type === 'status' && fields.includes('status_notes') && e.payload.note) { hit = hit || { ...e.payload }; hit.note = marker; }
      if (!hit) return e;
      hit.redacted = true;
      targets.push({ seq: e.seq, redacted_payload_hash: sha(canonical(hit)) });
      return { ...e, payload: hit };
    });
    if (!targets.length) throw new LedgerError('those fields are empty on this record');
    if (scan({ reason }).length) throw new LedgerError('the reason itself contains sensitive data');
    const rewrite = (file, entries) => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''));
      fs.renameSync(tmp, file);
    };
    // The redact entry goes first in memory so verify() accepts the rewritten lines.
    const last = this.entries[this.entries.length - 1];
    const payload = { cr_id: cr.cr_id, fields, reason: reason.slice(0, 300), targets };
    const e = { seq: this.entries.length + 1, type: 'redact', at: new Date().toISOString(), actor, payload, payload_hash: sha(canonical(payload)), prev_hash: last.hash };
    e.hash = envelopeHash(e);
    rewrite(this.file, [...rewritten, e]);
    // Sealed copies get the same treatment (their heads stay valid: hashes do not change).
    const adir = path.join(this.dir, 'anchors');
    if (fs.existsSync(adir)) {
      for (const name of fs.readdirSync(adir)) {
        const f = path.join(adir, name);
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
        rewrite(f, lines.map((x) => { const r = rewritten[x.seq - 1]; return r && r.hash === x.hash ? r : x; }));
      }
    }
    this.load();
    return e;
  }

  // Free-form audit events that are not about one record's content: shares, inbox
  // decisions, registry edits, feature retirement.
  addEvent(type, payload, actor) {
    if (!['share', 'inbox', 'registry', 'retire_feature', 'review'].includes(type)) throw new LedgerError(`unknown event ${type}`);
    return this.append(type, payload, actor);
  }

  validateFields(p) {
    const err = (m) => { throw new LedgerError(m); };
    const str = (k, max, req = true) => {
      if (p[k] == null || p[k] === '') { if (req) err(`"${k}" is required`); return; }
      if (typeof p[k] !== 'string' || p[k].length > max) err(`"${k}" must be text of at most ${max} characters`);
    };
    const list = (k, maxItems, maxLen) => {
      if (p[k] == null) return;
      if (!Array.isArray(p[k]) || p[k].length > maxItems || p[k].some((x) => typeof x !== 'string' || x.length > maxLen)) err(`"${k}" must be a list of at most ${maxItems} short texts`);
    };
    if (!this.products().some((x) => x.slug === p.product_line)) err(`unknown product_line "${p.product_line}"`);
    if (!KINDS.includes(p.kind)) err(`kind must be one of ${KINDS.join(', ')}`);
    str('title', 80); str('summary_plain', 400); str('why', 600, false); str('rollback_plan', 400, false);
    list('what_changed', 12, 160); list('removed', 12, 160); list('open_items', 12, 200); list('tags', 20, 40); list('search_terms_es', 20, 60);
    if (p.user_impact != null && !['none', 'internal', 'partner', 'consumer'].includes(p.user_impact)) err('user_impact must be none, internal, partner or consumer');
    if (p.risk != null && !['low', 'medium', 'high'].includes(p.risk)) err('risk must be low, medium or high');
    const { features } = this.state();
    if (!Array.isArray(p.features) || !p.features.length || p.features.some((f) => !features.has(f))) err('"features" must list known feature slugs');
  }

  // All commit SHAs any record points to (for the stop-hook check).
  commits() {
    const out = [];
    for (const cr of this.state().crs.values()) for (const r of (cr.evidence && cr.evidence.repos) || []) out.push(...r.commits);
    return out;
  }
}

module.exports = { Ledger, LedgerError, KINDS, STATUSES, TRANSITIONS, AMENDABLE, REDACTABLE, canonical, GENESIS, sha };
