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
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const redacted = e.payload && e.payload.redacted === true;
      if (e.corrupt || e.seq !== i + 1 || e.prev_hash !== prev
        || (!redacted && sha(canonical(e.payload)) !== e.payload_hash)
        || envelopeHash(e) !== e.hash) { brokenAt = i + 1; break; }
      prev = e.hash;
    }
    this.chain = { ok: brokenAt === null, count: this.entries.length, head: prev, brokenAt, checkedAt: new Date().toISOString() };
    return this.chain;
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
  state() {
    if (this._state && this._state.count === this.entries.length) return this._state;
    const crs = new Map();
    const features = new Map();
    for (const e of this.entries) {
      if (e.corrupt || !e.payload) continue;
      const p = e.payload;
      if (e.type === 'change') {
        if (p.redacted) continue;
        const cr = {
          ...p, seq: e.seq, recorded_at: e.at, actor: e.actor, hash: e.hash,
          history: [{ to: p.status, at: e.at, actor: e.actor, note: 'recorded', evidence: null, seq: e.seq }],
          amendments: [], links: [], current: p.status,
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
      } else if (e.type === 'amend') {
        const cr = crs.get(p.cr_id);
        if (!cr) continue;
        cr.amendments.push({ patch: p.patch, reason: p.reason, at: e.at, actor: e.actor, original: Object.fromEntries(Object.keys(p.patch || {}).map((k) => [k, cr[k]])) });
        Object.assign(cr, p.patch);
      }
    }
    for (const cr of crs.values()) {
      const deployed = ((cr.evidence && cr.evidence.deploys) || []).length > 0;
      const ownerLive = cr.history.some((h) => h.to === 'live' && h.actor && h.actor.kind === 'owner');
      const evLive = cr.history.some((h) => h.to === 'live' && h.evidence && (h.evidence.deploy_id || h.evidence.flag_snapshot));
      cr.live_proof = cr.current !== 'live' ? null : ownerLive ? 'owner-confirmed' : (deployed || evLive) ? 'deploy' : 'inferred';
      cr.date = cr.occurred_at || cr.recorded_at;
    }
    this._state = { count: this.entries.length, crs, features };
    return this._state;
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
    if (!(TRANSITIONS[cr.current] || []).includes(to)) throw new LedgerError(`cannot go from ${cr.current} to ${to}`);
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
    if (body.note) p.note = String(body.note).slice(0, 300);
    if (!p.artifacts && !p.repos && !p.deploys) throw new LedgerError('nothing to link');
    return this.append('link', p, actor);
  }

  // All commit SHAs any record points to (for the stop-hook check).
  commits() {
    const out = [];
    for (const cr of this.state().crs.values()) for (const r of (cr.evidence && cr.evidence.repos) || []) out.push(...r.commits);
    return out;
  }
}

module.exports = { Ledger, LedgerError, KINDS, STATUSES, TRANSITIONS, canonical, GENESIS };
