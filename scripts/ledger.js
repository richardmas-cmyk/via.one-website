#!/usr/bin/env node
// Build Ledger CLI — records every build / change / removal session as a Change Record.
//
//   ledger help                          format of a draft + product and feature lists
//   ledger pending [--session ID]        what this session made that is not recorded yet
//   ledger record --draft d.json [--dry-run] [--session ID]
//   ledger link CR-0007 --session-work   attach this session's unrecorded commits/pages to a record
//   ledger link CR-0007 --commits latcom-fix:abc1234,def5678 [--artifact slug:2:flow] [--deploy prod:ID]
//   ledger link CR-0007 --unlink abc1234 --note "attached by mistake: another session's work"
//   ledger status CR-0007 staged|built_flag_off|live|abandoned [--deploy env:ID] [--note "..."]
//   ledger skip --reason "memory notes only"   (this session's unrecorded work is not product work)
//   ledger show CR-0007 · ledger verify · ledger registry pull|push <file.json>
//   ledger amend CR-0007 --patch fix.json --reason "wrong product line"
//   ledger needs                         what the Needs-you panel shows
//   ledger backfill commits [--since 2026-11-01] [--until …]   unrecorded main commits as a candidate skeleton
//   ledger inbox add --draft candidates.json   send backfilled candidates to the owner's Inbox
//   ledger nightly [--quiet]             launchd: unrecorded main commits + Mac backup + independent chain check
//   ledger start / ledger check          Claude Code SessionStart / Stop hooks (read hook JSON on stdin)
//
// Local state lives in ~/.ledger (sessions, cache, config). Nothing secret is stored there;
// the agent token is read from ~/Secrets-vault/viaone-library/ledger-agent-token.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { scan, describe } = require('../ledger/scan');

const HOME = os.homedir();
const LDIR = process.env.LEDGER_HOME || path.join(HOME, '.ledger');
const SESS_DIR = path.join(LDIR, 'sessions');
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const writeJSON = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const config = readJSON(path.join(LDIR, 'config.json'), {});
const BASE = String(process.env.LEDGER_BASE || config.base || 'https://via.one').replace(/\/$/, '');
const TOKEN_FILE = process.env.LEDGER_TOKEN_FILE || config.token_file || path.join(HOME, 'Secrets-vault/viaone-library/ledger-agent-token');

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const opt = {}; const rest = [];
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); opt[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; } else rest.push(args[i]);
}
const fail = (m) => { console.error(`❌ ${m}`); process.exit(1); };
const token = () => {
  const t = process.env.LEDGER_AGENT_TOKEN || (fs.existsSync(TOKEN_FILE) ? fs.readFileSync(TOKEN_FILE, 'utf8').trim() : '');
  if (!t) fail(`no ledger token (env LEDGER_AGENT_TOKEN or ${TOKEN_FILE})`);
  return t;
};

async function call(method, route, body, { timeoutMs = 20000, session, raw } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/library/api/ledger/${route}`, {
      method, signal: ctl.signal,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', ...(session ? { 'X-Ledger-Session': session } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw && res.ok) return await res.text();
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(`${method} ${route} → ${res.status} ${json.error || ''}`);
    return json;
  } finally { clearTimeout(timer); }
}

// ---------- repos ----------
function repos() {
  const alias = { 'latcom-fix-main': 'latcom-fix', 'latcom-fix-review': 'latcom-fix', ...(config.repo_alias || {}) };
  const order = config.repo_order || ['latcom-fix-main', 'latcom-fix', 'via.one-website'];
  const found = [];
  const dirs = [...(config.repos || []), ...fs.readdirSync(HOME).map((d) => path.join(HOME, d))];
  for (const d of dirs) {
    try { if (fs.existsSync(path.join(d, '.git')) && !found.some((r) => r.path === d)) found.push({ path: d, name: alias[path.basename(d)] || path.basename(d) }); } catch (e) { /* unreadable */ }
  }
  found.sort((a, b) => ((order.indexOf(path.basename(a.path)) + 1) || 99) - ((order.indexOf(path.basename(b.path)) + 1) || 99));
  return found;
}
const git = (repo, a, input) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 << 20 });

// shas (short) -> [{ sha (full), repo, name }]
function resolveShas(shas) {
  const out = new Map();
  if (!shas.length) return out;
  for (const r of repos()) {
    const left = shas.filter((s) => !out.has(s));
    if (!left.length) break;
    let lines;
    try { lines = git(r.path, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${left.join('\n')}\n`).trim().split('\n'); } catch (e) { continue; }
    lines.forEach((ln, i) => { const [full, type] = ln.split(' '); if (type === 'commit') out.set(left[i], { sha: full, repo: r.path, name: r.name }); });
  }
  return out;
}

// ---------- sessions ----------
const sessFile = (id) => path.join(SESS_DIR, `${String(id).replace(/[^A-Za-z0-9_-]/g, '')}.json`);
function currentSession() {
  const id = opt.session || process.env.LEDGER_SESSION || process.env.CLAUDE_CODE_SESSION_ID;
  if (id) {
    const s = readJSON(sessFile(id), null);
    if (s) return s;
    if (opt.session || process.env.LEDGER_SESSION) fail(`no ledger session ${id}`);
  }
  // Fallback (old Claude Code without CLAUDE_CODE_SESSION_ID): the session whose
  // transcript was written to most recently. Can pick the wrong one when two run at once.
  let best = null; let bestT = 0;
  for (const f of fs.existsSync(SESS_DIR) ? fs.readdirSync(SESS_DIR) : []) {
    const s = readJSON(path.join(SESS_DIR, f), null);
    if (!s || !s.transcript_path) continue;
    let t = 0; try { t = fs.statSync(s.transcript_path).mtimeMs; } catch (e) { continue; }
    if (t > bestT) { best = s; bestT = t; }
  }
  if (!best) fail('no ledger session found — is the SessionStart hook installed? (pass --session ID)');
  return best;
}

// What this session made, read from its own transcript: `git commit` output lines
// ("[main abc1234] subject") and library-add output ("✅ slug is now at version N").
function sessionWork(s) {
  let text = '';
  try { text = fs.readFileSync(s.transcript_path, 'utf8'); } catch (e) { return { commits: [], artifacts: [] }; }
  // 1) `git commit` output lines — certain. 2) any other commit id the session showed
  // (quiet commits, `git log`) — counted only if committed after the session started.
  const sure = new Set();
  for (const m of text.matchAll(/\[(?:detached HEAD|[^\]\s"\\]{1,100})(?: \(root-commit\))? ([0-9a-f]{7,12})\] /g)) sure.add(m[1]);
  // Other ids count only when they appear in a tool's output (git log, quiet commits),
  // not in Claude's own words, and not in the ledger's own listings (nightly, needs,
  // pending, backfill), which print other sessions' commits.
  // Only the output of git commands (commit, log, show, rev-parse) is read.
  const toolText = [];
  const gitCalls = new Set();
  for (const ln of text.split('\n')) {
    if (!ln.includes('"tool_use"') && !ln.includes('"tool_result"')) continue;
    try {
      const d = JSON.parse(ln);
      for (const c of (d.message && Array.isArray(d.message.content) ? d.message.content : [])) {
        if (c.type === 'tool_use' && c.input && typeof c.input.command === 'string'
          && /(^|[\s;&|(])git(\s+-C\s+\S+)?\s+(commit|log|show|rev-parse)\b/.test(c.input.command) && !/(^|[;&|]\s*)(ledger|node\s+\S*ledger\.js)\s/.test(c.input.command)) gitCalls.add(c.id);
        if (c.type !== 'tool_result' || !gitCalls.has(c.tool_use_id)) continue;
        const parts = typeof c.content === 'string' ? [c.content] : (c.content || []).map((x) => x.text || '');
        toolText.push(...parts);
      }
    } catch (e) { /* not JSON */ }
  }
  const scanText = toolText.join('\n')
    .replace(/[\w.-]+ [0-9a-f]{8,12} · \d{4}-\d{2}-\d{2} · [^\n]*/g, '')
    .replace(/^ *commit [\w.-]+ [0-9a-f]{8,12} .*$/gm, '')
    .replace(/"_subjects": \[[^\]]*\]/g, '')
    .replace(/"[0-9a-f]{12}"/g, '');
  const maybe = new Set();
  for (const m of scanText.matchAll(/(?<![0-9a-zA-Z_-])([0-9a-f]{7,12})(?![0-9a-zA-Z_-])/g)) {
    if (/[a-f]/.test(m[1]) && /\d/.test(m[1]) && !sure.has(m[1])) maybe.add(m[1]);
    if (maybe.size >= 3000) break;
  }
  const resolved = resolveShas([...sure, ...maybe]);
  const since = Date.parse(s.started_at || 0) / 1000 - 60;
  const commits = [];
  for (const [short, c] of resolved) {
    if (commits.some((x) => x.sha === c.sha)) continue;
    if (!sure.has(short)) {
      let t = 0; try { t = Number(git(c.repo, ['show', '-s', '--format=%ct', c.sha]).trim()); } catch (e) { continue; }
      if (t < since) continue;
    }
    commits.push(c);
  }
  const artifacts = new Set();
  for (const m of text.matchAll(/✅ ([a-z0-9][a-z0-9-]{1,60}) is now at version (\d{1,4})/g)) artifacts.add(`${m[1]}@${m[2]}`);
  return { commits, artifacts: [...artifacts] };
}

const cacheFile = path.join(LDIR, 'recorded.json');
async function recorded(force) {
  let c = readJSON(cacheFile, null);
  if (force || !c) {
    const r = await call('GET', 'recorded', null, { timeoutMs: 6000 });
    c = { commits: r.commits, artifacts: r.artifacts, fetched_at: new Date().toISOString() };
    writeJSON(cacheFile, c);
  }
  return c;
}
const skippedFile = path.join(LDIR, 'skipped.json');
async function unrecorded(s, { refresh } = {}) {
  const work = sessionWork(s);
  const skipped = readJSON(skippedFile, []);
  const isSkipped = (k) => skipped.some((x) => x.key === k);
  const filter = (c) => ({
    commits: work.commits.filter((x) => !c.commits.some((r) => x.sha.startsWith(r) || r.startsWith(x.sha)) && !isSkipped(x.sha)),
    artifacts: work.artifacts.filter((a) => !c.artifacts.includes(a) && !isSkipped(a)),
  });
  let out = filter(await recorded(false));
  if ((out.commits.length || out.artifacts.length) && refresh !== false) out = filter(await recorded(true));
  return out;
}

// ---------- evidence auto-fill ----------
function evidenceFor(commits) {
  const byRepo = new Map();
  for (const c of commits) {
    if (!byRepo.has(c.repo)) byRepo.set(c.repo, { name: c.name, shas: [] });
    byRepo.get(c.repo).shas.push(c.sha);
  }
  const reposOut = []; const migrations = []; const flags = new Set();
  for (const [repo, { name, shas }] of byRepo) {
    // oldest first
    const ordered = shas.map((sha) => ({ sha, t: Number(git(repo, ['show', '-s', '--format=%ct', sha]).trim()) })).sort((a, b) => a.t - b.t).map((x) => x.sha);
    const files = new Set(); let ins = 0; let del = 0;
    for (const sha of ordered) {
      for (const ln of git(repo, ['show', '--numstat', '--format=', sha]).trim().split('\n')) {
        const [a, d, f] = ln.split('\t'); if (!f) continue;
        files.add(f); ins += Number(a) || 0; del += Number(d) || 0;
      }
      for (const f of git(repo, ['show', '--diff-filter=A', '--name-only', '--format=', sha]).trim().split('\n')) {
        if (/(^|\/)migrations?\/[^/]+\.(sql|js)$/i.test(f)) migrations.push({ id: f, direction: 'up', ...(/down/i.test(f) ? { reversible: true } : {}) });
      }
      const patch = git(repo, ['show', '-U0', '--format=', sha]);
      let file = '';
      for (const ln of patch.split('\n')) {
        if (ln.startsWith('+++ ')) { file = ln.slice(6); continue; }
        if (!ln.startsWith('+') || /(^|\/)(tests?|__tests__|scripts)\//.test(file)) continue;
        for (const m of ln.matchAll(/process\.env\.([A-Z][A-Z0-9_]{3,})|\benv\(['"]([A-Z][A-Z0-9_]{3,})['"]/g)) flags.add(m[1] || m[2]);
      }
    }
    let branch = '';
    try { branch = git(repo, ['branch', '--contains', ordered[ordered.length - 1], '--format=%(refname:short)']).trim().split('\n').find((b) => b === 'main' || b === 'master') || ''; } catch (e) { /* none */ }
    reposOut.push({ repo: name, ...(branch ? { branch } : {}), commits: ordered, diffstat: { files: files.size, insertions: ins, deletions: del }, files_touched: [...files].sort() });
  }
  return {
    repos: reposOut, migrations,
    flags: [...flags].filter((f) => !/^(NODE_ENV|PORT|DATABASE_URL|HOME|PATH)$/.test(f)).sort().map((name) => ({ name, env: 'code' })),
  };
}

const artifactLog = path.join(LDIR, 'artifacts.jsonl');
function artifactSha(slug, v) {
  const lines = fs.existsSync(artifactLog) ? fs.readFileSync(artifactLog, 'utf8').trim().split('\n') : [];
  for (const ln of lines.reverse()) { try { const a = JSON.parse(ln); if (a.slug === slug && a.v === v) return a.sha256; } catch (e) { /* skip */ } }
  return undefined;
}

function mapCheck(draft, ev) {
  const rules = config.path_map || [];
  if (!rules.length) return null;
  const hit = new Set();
  for (const r of ev.repos || []) {
    for (const f of r.files_touched || []) {
      for (const rule of rules) if ((!rule.repo || rule.repo === r.repo) && new RegExp(rule.match).test(f)) hit.add(rule.product);
    }
  }
  if (hit.size && !hit.has(draft.product_line) && !draft.override_reason) {
    return `the files touched belong to ${[...hit].join(', ')} by the path map, not "${draft.product_line}". Fix product_line or add "override_reason".`;
  }
  return null;
}

// ---------- commands ----------
async function cmdHelp() {
  console.log(`Build Ledger — record every build / change / removal session.

1. Write a draft JSON (plain words, written to be read aloud; no secrets, names, phones, card or account numbers):
{
  "product_line": "gift-cards",
  "features": ["card-gift-claim"],
  "kind": "modify",                 // build | modify | remove | config_flag | incident_fix | doc | revert
  "title": "Issue the card when the gift is claimed",          // ≤ 80 chars
  "summary_plain": "The card is now created when your friend claims the gift. It is on for your two phones only.",
  "why": "Unclaimed gifts were creating cards nobody used.",
  "what_changed": ["card created at claim", "claim page shows the card"],
  "removed": ["card created at send"],
  "user_impact": "consumer",        // none | internal | partner | consumer
  "risk": "medium",                 // low | medium | high
  "status": "staged",               // proposed | built_flag_off | staged | live (needs evidence.deploys) | abandoned
  "rollback_plan": "Set CARD_GIFT_ISSUE_AT_CLAIM=false. No data to undo.",
  "open_items": ["owner $1 test"],
  "evidence": { "deploys": [{ "env": "prod", "deploy_id": "<railway deployment id or build marker>" }],
                "tests": { "command": "npx jest card-gift", "passed": 23, "failed": 0 } },
  "new_feature": { "slug": "...", "name_en": "...", "name_es": "...", "type": "consumer-flow",
                   "flow_artifact_slug": "<library slug>", "aliases": ["..."], "summary": "..." }   // only kind=build
}
2. ledger record --draft draft.json        (commits, files, flags, migrations and Library pages are filled in for you)
3. Put "Ledger: CR-NNNN" in the next commit message if there is one.

Other: ledger pending · ledger link CR-NNNN --session-work · ledger status CR-NNNN staged · ledger skip --reason "..."
       ledger amend CR-NNNN --patch fix.json --reason "..." · ledger needs · ledger inbox list
Backfill: ledger backfill commits --since 2026-11-01 > c.json → fill in (provenance.source "backfill", confidence, notes) → ledger inbox add --draft c.json`);
  try {
    const r = await call('GET', 'registry', null, { timeoutMs: 6000 });
    console.log(`\nProduct lines: ${r.products.map((p) => p.slug).join(', ')}`);
    console.log(`Features:\n${r.features.map((f) => `  ${f.slug} (${f.product_line}${f.flow_artifact_slug ? `, flow page ${f.flow_artifact_slug}` : ''})`).join('\n') || '  (none yet)'}`);
  } catch (e) { console.log(`\n(registry not reachable: ${e.message})`); }
}

async function cmdPending() {
  const s = currentSession();
  const u = await unrecorded(s);
  console.log(`Session ${s.session_id} (started ${s.started_at})`);
  if (!u.commits.length && !u.artifacts.length) { console.log('✅ Nothing unrecorded.'); return; }
  for (const c of u.commits) console.log(`  commit ${c.name} ${c.sha.slice(0, 8)}  ${git(c.repo, ['show', '-s', '--format=%s', c.sha]).trim()}`);
  for (const a of u.artifacts) console.log(`  page   ${a.replace('@', ' v')}`);
}

async function cmdRecord() {
  if (!opt.draft) fail('usage: ledger record --draft draft.json [--dry-run]');
  let draft;
  try { draft = JSON.parse(fs.readFileSync(opt.draft, 'utf8')); } catch (e) { fail(`draft is not valid JSON: ${e.message}`); }
  const s = currentSession();
  const humanFields = Object.keys(draft);
  // Commits: this session's unrecorded ones, or the explicit list in the draft (backfill).
  let commits = [];
  let arts = [];
  if (draft.commits) {
    const want = Object.entries(draft.commits).flatMap(([, list]) => list);
    const res = resolveShas(want);
    for (const sha of want) if (!res.has(sha)) fail(`commit ${sha} not found in any repo under ${HOME}`);
    commits = [...res.values()];
    delete draft.commits;
  } else if (!opt['no-session-work']) {
    const u = await unrecorded(s);
    commits = u.commits; arts = u.artifacts;
  }
  const ev = { ...(draft.evidence || {}) };
  const auto = evidenceFor(commits);
  if (auto.repos.length) ev.repos = auto.repos;
  if (auto.migrations.length) ev.migrations = auto.migrations;
  if (auto.flags.length) ev.flags = [...(ev.flags || []), ...auto.flags.filter((f) => !(ev.flags || []).some((x) => x.name === f.name))];
  if (!auto.repos.length && !(draft.artifacts || []).length && !arts.length && ev.no_code == null && ['doc', 'config_flag'].includes(draft.kind)) ev.no_code = true;
  draft.evidence = ev;

  let registry = { features: [] };
  try { registry = await call('GET', 'registry', null, { timeoutMs: 8000 }); } catch (e) { /* server validates anyway */ }
  const flowSlugs = new Set([...registry.features.map((f) => f.flow_artifact_slug), draft.new_feature && draft.new_feature.flow_artifact_slug].filter(Boolean));
  const artifacts = [...(draft.artifacts || [])];
  for (const a of arts) {
    const [slug, v] = a.split('@');
    if (!artifacts.some((x) => x.library_slug === slug && x.version === Number(v))) artifacts.push({ library_slug: slug, version: Number(v), role: flowSlugs.has(slug) ? 'flow' : 'sheet' });
  }
  for (const a of artifacts) { const h = a.sha256 || artifactSha(a.library_slug, a.version); if (h) a.sha256 = h; }
  if (artifacts.length) draft.artifacts = artifacts;

  const problem = mapCheck(draft, ev);
  if (problem) fail(problem);
  draft.session = { session_id: s.session_id, agent: 'claude-code', started_at: s.started_at, ended_at: new Date().toISOString(), directed_by: 'owner' };
  draft.provenance = { source: 'session', ...(draft.provenance || {}), auto_fields: ['evidence.repos', 'evidence.migrations', 'evidence.flags', 'artifacts', 'session'], human_fields: humanFields.filter((k) => k !== 'provenance') };
  draft.attest_no_sensitive_data = true;
  const findings = scan(draft);
  if (findings.length) fail(`sensitive data found — remove it and run again: ${describe(findings)}`);
  if (opt['dry-run']) { console.log(JSON.stringify(draft, null, 2)); return; }
  const r = await call('POST', 'change', draft, { session: s.session_id });
  const c = readJSON(cacheFile, { commits: [], artifacts: [] });
  for (const rp of ev.repos || []) c.commits.push(...rp.commits);
  for (const a of artifacts) c.artifacts.push(`${a.library_slug}@${a.version}`);
  writeJSON(cacheFile, c);
  const n = (ev.repos || []).reduce((k, rp) => k + rp.commits.length, 0);
  console.log(`✅ ${r.cr_id} recorded (${n} commits, ${artifacts.length} pages)\n   ${r.url}\n   Put "Ledger: ${r.cr_id}" in the next commit message.`);
}

async function cmdLink() {
  const id = rest[0];
  if (!/^CR-\d{4,}$/.test(id || '')) fail('usage: ledger link CR-NNNN --session-work | --commits repo:sha,sha | --artifact slug:v[:role] | --deploy env:ID | --unlink sha,sha --note "why"');
  const body = { cr_id: id };
  let commits = [];
  let arts = [];
  if (opt['session-work']) { const u = await unrecorded(currentSession()); commits = u.commits; arts = u.artifacts; }
  if (opt.commits) {
    const want = String(opt.commits).split(':').slice(1).join(':').split(',').filter(Boolean);
    const res = resolveShas(want);
    for (const sha of want) if (!res.has(sha)) fail(`commit ${sha} not found`);
    commits.push(...res.values());
  }
  if (commits.length) body.repos = evidenceFor(commits).repos;
  const artList = arts.map((a) => { const [slug, v] = a.split('@'); return { library_slug: slug, version: Number(v), role: 'sheet' }; });
  if (opt.artifact) { const [slug, v, role] = String(opt.artifact).split(':'); artList.push({ library_slug: slug, version: Number(v), role: role || 'flow' }); }
  for (const a of artList) { const h = artifactSha(a.library_slug, a.version); if (h) a.sha256 = h; }
  if (artList.length) body.artifacts = artList;
  if (opt.deploy) { const [env, ...idp] = String(opt.deploy).split(':'); body.deploys = [{ env, deploy_id: idp.join(':'), at: new Date().toISOString() }]; }
  if (opt.unlink) body.unlink_commits = String(opt.unlink).split(',').filter(Boolean);
  if (opt.note) body.note = String(opt.note);
  const r = await call('POST', 'link', body);
  const c = readJSON(cacheFile, { commits: [], artifacts: [] });
  for (const rp of body.repos || []) c.commits.push(...rp.commits);
  for (const a of artList) c.artifacts.push(`${a.library_slug}@${a.version}`);
  writeJSON(cacheFile, c);
  console.log(`✅ linked to ${r.cr_id} (${commits.length} commits, ${artList.length} pages${body.deploys ? ', 1 deploy' : ''})`);
}

async function cmdStatus() {
  const [id, to] = rest;
  if (!/^CR-\d{4,}$/.test(id || '') || !to) fail('usage: ledger status CR-NNNN <built_flag_off|staged|live|abandoned> [--deploy env:ID] [--note "..."]');
  const body = { cr_id: id, to, note: opt.note || '' };
  if (opt.deploy) { const [env, ...idp] = String(opt.deploy).split(':'); body.evidence = { env, deploy_id: idp.join(':') }; }
  const r = await call('POST', 'status', body);
  console.log(`✅ ${r.cr_id}: ${r.from} → ${r.to}`);
}

async function cmdSkip() {
  if (!opt.reason || String(opt.reason).length < 8) fail('usage: ledger skip --reason "why this is not product work (8+ characters)"');
  const s = currentSession();
  const u = await unrecorded(s);
  const list = readJSON(skippedFile, []);
  for (const c of u.commits) list.push({ key: c.sha, repo: c.name, reason: String(opt.reason), session: s.session_id, at: new Date().toISOString() });
  for (const a of u.artifacts) list.push({ key: a, reason: String(opt.reason), session: s.session_id, at: new Date().toISOString() });
  writeJSON(skippedFile, list);
  console.log(`✅ skipped ${u.commits.length} commits and ${u.artifacts.length} pages (kept in ${skippedFile}; the nightly check will list them)`);
}

async function cmdShow() {
  const r = await call('GET', `cr/${encodeURIComponent(rest[0] || '')}`);
  console.log(JSON.stringify(r.record, null, 2));
}
async function cmdVerify() {
  const r = await call('GET', 'verify');
  console.log(r.chain.ok ? `✅ chain verified: ${r.chain.count} entries, head ${r.chain.head.slice(7, 19)}` : `❌ CHAIN BROKEN at entry ${r.chain.brokenAt}`);
  if (!r.chain.ok) process.exit(1);
}
async function cmdRegistry() {
  if (rest[0] === 'pull') { const r = await call('GET', 'registry'); console.log(JSON.stringify({ products: r.products, synonyms: r.synonyms }, null, 2)); return; }
  if (rest[0] === 'push' && rest[1]) { const r = await call('PUT', 'registry', readJSON(rest[1], null) || fail('registry file is not valid JSON')); console.log(`✅ registry saved (${r.products} product lines)`); return; }
  fail('usage: ledger registry pull | push <file.json>');
}


async function cmdAmend() {
  const id = rest[0];
  if (!/^CR-\d{4,}$/.test(id || '') || !opt.patch || !opt.reason) fail('usage: ledger amend CR-NNNN --patch fix.json --reason "why"');
  const patch = readJSON(opt.patch, null) || fail('patch file is not valid JSON');
  const findings = scan(patch);
  if (findings.length) fail(`sensitive data found: ${describe(findings)}`);
  const r = await call('POST', 'amend', { cr_id: id, patch, reason: String(opt.reason) });
  console.log(`✅ ${r.cr_id} amended: ${r.fields.join(', ')}`);
}

async function cmdNeeds() {
  const r = await call('GET', 'needs');
  if (!r.needs.length) { console.log('✅ Nothing needs the owner.'); return; }
  for (const n of r.needs) {
    console.log(`${n.sev === 'bad' ? '✕' : '⚠'} ${n.text}`);
    for (const x of n.list.slice(0, 15)) console.log(`    ${typeof x === 'string' ? x : x.text}`);
  }
}

// ---------- main-branch commits with no record ----------
// config.main_repos: [{ path, ref, name }]; default = latcom-fix-main (origin/main) + via.one-website (main).
function mainRepos() {
  const list = config.main_repos || [
    { path: path.join(HOME, 'latcom-fix-main'), ref: 'origin/main', name: 'latcom-fix', fetch: true },
    { path: path.join(HOME, 'via.one-website'), ref: 'main', name: 'via.one-website' },
  ];
  return list.map((r) => ({ ...r, path: r.path.replace(/^~(?=\/)/, HOME) })).filter((r) => fs.existsSync(path.join(r.path, '.git')));
}
async function unrecordedMain({ since, until, fetchFirst }) {
  const rec = await recorded(true);
  const skipped = readJSON(skippedFile, []);
  const out = [];
  for (const r of mainRepos()) {
    if (fetchFirst && r.fetch) { try { execFileSync('git', ['-C', r.path, 'fetch', '--quiet', 'origin'], { stdio: 'ignore', timeout: 60000 }); } catch (e) { /* offline: use what we have */ } }
    let log = '';
    try { log = git(r.path, ['log', r.ref, '--no-merges', `--since=${since}`, ...(until ? [`--until=${until}`] : []), '--format=%H%x09%cI%x09%s']); } catch (e) { continue; }
    for (const ln of log.trim().split('\n').filter(Boolean)) {
      const [sha, date, ...subj] = ln.split('\t');
      if (rec.commits.some((c) => sha.startsWith(c) || c.startsWith(sha))) continue;
      if (skipped.some((x) => x.key === sha)) continue;
      out.push({ repo: r.name, sha, date, subject: subj.join('\t').slice(0, 120) });
    }
  }
  return out;
}

async function cmdBackfill() {
  if (rest[0] !== 'commits') fail('usage: ledger backfill commits [--since YYYY-MM-DD] [--until YYYY-MM-DD]');
  const since = opt.since || '2026-11-01';
  const list = await unrecordedMain({ since, until: opt.until, fetchFirst: true });
  // Group by repo and ET day: one candidate skeleton per group, to be filled in by hand.
  const groups = new Map();
  for (const c of list) {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(c.date));
    const k = `${c.repo}|${day}`;
    if (!groups.has(k)) groups.set(k, { repo: c.repo, day, commits: [] });
    groups.get(k).commits.push(c);
  }
  const skeleton = [...groups.values()].sort((a, b) => a.day.localeCompare(b.day)).map((g) => ({
    occurred_at: `${g.day}T17:00:00-05:00`,
    product_line: '', features: [], kind: '', title: '', summary_plain: '', why: '', what_changed: [], status: '',
    provenance: { source: 'backfill', confidence: 'medium', notes: [] },
    commits: { [g.repo]: g.commits.map((c) => c.sha.slice(0, 12)) },
    _subjects: g.commits.map((c) => `${c.sha.slice(0, 8)} ${c.subject}`),
  }));
  console.log(JSON.stringify(skeleton, null, 2));
  console.error(`${list.length} unrecorded commits on main since ${since}, in ${skeleton.length} groups. Fill in each group (split or join as needed), delete "_subjects", then: ledger inbox add --draft <file>`);
}

async function cmdInbox() {
  if (rest[0] === 'list') { const r = await call('GET', 'inbox'); for (const x of r.inbox) console.log(`${x.id} ${x.state.padEnd(9)} ${x.cr_id || '       '} ${x.title}`); return; }
  if (rest[0] !== 'add' || !opt.draft) fail('usage: ledger inbox add --draft candidates.json · ledger inbox list');
  let list;
  try { list = JSON.parse(fs.readFileSync(opt.draft, 'utf8')); } catch (e) { fail(`draft is not valid JSON: ${e.message}`); }
  if (!Array.isArray(list)) list = [list];
  const s = currentSession();
  const out = [];
  for (const [i, d0] of list.entries()) {
    const d = { ...d0 };
    delete d._subjects;
    if (!d.provenance || d.provenance.source !== 'backfill' || !['high', 'medium', 'low'].includes(d.provenance.confidence)) fail(`candidate ${i + 1}: provenance must be { source: "backfill", confidence: high|medium|low, notes: [...] }`);
    let commits = [];
    if (d.commits) {
      const want = Object.values(d.commits).flat();
      const res = resolveShas(want);
      for (const sha of want) if (!res.has(sha)) fail(`candidate ${i + 1}: commit ${sha} not found`);
      commits = [...res.values()];
      delete d.commits;
    }
    const ev = { ...(d.evidence || {}) };
    const auto = evidenceFor(commits);
    if (auto.repos.length) ev.repos = auto.repos;
    if (auto.migrations.length) ev.migrations = auto.migrations;
    if (auto.flags.length) ev.flags = [...(ev.flags || []), ...auto.flags.filter((f) => !(ev.flags || []).some((x) => x.name === f.name))];
    if (!auto.repos.length && !(d.artifacts || []).length && ev.no_code == null) ev.no_code = true;
    d.evidence = ev;
    const problem = mapCheck(d, ev);
    if (problem) fail(`candidate ${i + 1} (${d.title}): ${problem}`);
    d.session = { session_id: s.session_id, agent: 'claude-code', started_at: s.started_at, ended_at: new Date().toISOString(), directed_by: 'owner' };
    d.provenance = { ...d.provenance, auto_fields: ['evidence.repos', 'evidence.migrations', 'evidence.flags', 'session'] };
    d.attest_no_sensitive_data = true;
    const findings = scan(d);
    if (findings.length) fail(`candidate ${i + 1} (${d.title}): sensitive data found — ${describe(findings)}`);
    out.push(d);
  }
  if (opt['dry-run']) { console.log(JSON.stringify(out, null, 2)); return; }
  const r = await call('POST', 'inbox', { candidates: out }, { session: s.session_id, timeoutMs: 60000 });
  console.log(`✅ ${r.added.length} added to the Inbox (${r.waiting} waiting)${r.skipped.length ? `; skipped ${r.skipped.map((x) => `#${x.i} (${x.why})`).join(', ')}` : ''}\n   ${BASE}/library/ledger/inbox`);
}

// ---------- nightly (launchd) ----------
async function tg(text) {
  const t = config.telegram;
  if (!t || !t.token_file || !(t.chats || []).length) return;
  let token = '';
  try { const raw = fs.readFileSync(t.token_file.replace(/^~(?=\/)/, HOME), 'utf8'); token = t.token_key ? (raw.match(new RegExp(`${t.token_key}=["']?([^"'\n]+)`)) || [])[1] : raw.trim(); } catch (e) { return; }
  if (!token) return;
  for (const chat_id of t.chats) {
    try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id, text: text.slice(0, 3900), disable_web_page_preview: true }) }); } catch (e) { /* ignore */ }
  }
}
async function cmdNightly() {
  const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
  const since = config.since || '2026-11-22T00:00:00-05:00';
  // 1. commits on main with no record
  const un = await unrecordedMain({ since, fetchFirst: true });
  log(`unrecorded main commits since ${since}: ${un.length}`);
  // 2. sessions where the stop hook gave up (new since the last run)
  const stateFile = path.join(LDIR, 'nightly-state.json');
  const st = readJSON(stateFile, { giveups_offset: 0 });
  const ulog = path.join(LDIR, 'unrecorded.log');
  const giveups = [];
  if (fs.existsSync(ulog)) {
    const all = fs.readFileSync(ulog, 'utf8').split('\n').filter(Boolean);
    for (const ln of all.slice(-200)) { const [at, , ...items] = ln.split(' '); if (Date.now() - Date.parse(at) < 7 * 864e5) giveups.push({ at, items: items.join(' ') }); }
    st.giveups_seen = all.length;
  }
  // 3. backup + independent check against heads kept on this Mac
  const bdir = path.join(LDIR, 'backups');
  fs.mkdirSync(bdir, { recursive: true });
  const backup = { ok: false, count: 0, anchors: 0, problem: null };
  try {
    const text = await call('GET', 'export', null, { raw: true, timeoutMs: 60000 });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-check-'));
    fs.writeFileSync(path.join(work, 'ledger.jsonl'), text);
    const macAnchors = path.join(LDIR, 'anchors.jsonl');
    if (fs.existsSync(macAnchors)) fs.copyFileSync(macAnchors, path.join(work, 'anchors.jsonl'));
    const { Ledger } = require('../ledger/store');
    const l = new Ledger(work);
    backup.count = l.chain.count;
    if (!l.chain.ok) backup.problem = `the server copy fails the Mac check at entry ${l.chain.brokenAt}${l.chain.anchorProblem ? `: ${l.chain.anchorProblem}` : ''}`;
    else {
      backup.ok = true;
      const head = l.entries.length ? l.entries[l.entries.length - 1].hash : null;
      const heads = fs.existsSync(macAnchors) ? fs.readFileSync(macAnchors, 'utf8').split('\n').filter(Boolean) : [];
      if (!heads.some((h) => h.includes(`"date":"${day}"`))) fs.appendFileSync(macAnchors, `${JSON.stringify({ date: day, count: l.entries.length, head, at: new Date().toISOString() })}\n`);
      fs.writeFileSync(path.join(bdir, `ledger-${day}.jsonl`), text);
      for (const name of fs.readdirSync(bdir)) { const d = Date.parse(name.slice(7, 17)); if (!isNaN(d) && Date.now() - d > 30 * 864e5) fs.unlinkSync(path.join(bdir, name)); }
    }
    backup.anchors = fs.existsSync(macAnchors) ? fs.readFileSync(macAnchors, 'utf8').split('\n').filter(Boolean).length : 0;
    fs.rmSync(work, { recursive: true, force: true });
  } catch (e) { backup.problem = `could not fetch the ledger: ${e.message}`; }
  log(`backup: ${backup.ok ? 'ok' : 'FAILED'} ${backup.count} entries, ${backup.anchors} Mac heads ${backup.problem || ''}`);
  // 4. report to the server (feeds the Needs-you panel)
  const subjects = un.map((c) => ({ ...c, subject: scan({ s: c.subject }).length ? '' : c.subject }));
  await call('POST', 'needs', { unrecorded_commits: subjects, hook_giveups: giveups, backup }, { timeoutMs: 30000 });
  writeJSON(stateFile, st);
  // 5. Telegram only when something needs the owner
  const newGiveups = (st.giveups_seen || 0) - (st.giveups_reported || 0);
  if (!opt.quiet && (un.length || !backup.ok || newGiveups > 0)) {
    const parts = [];
    if (un.length) parts.push(`${un.length} commit(s) on main with no record (${[...new Set(un.map((c) => c.repo))].join(', ')})`);
    if (newGiveups > 0) parts.push(`${newGiveups} session(s) ended without recording`);
    if (!backup.ok) parts.push(`backup check FAILED: ${backup.problem}`);
    await tg(`📒 Build Ledger nightly\n${parts.map((x) => `• ${x}`).join('\n')}\n${BASE}/library/ledger/needs`);
  }
  st.giveups_reported = st.giveups_seen || 0;
  writeJSON(stateFile, st);
  if (!backup.ok) process.exitCode = 1;
}

// ---------- hooks ----------
const readStdin = () => { try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (e) { return {}; } };

function hookStart() {
  const h = readStdin();
  if (!h.session_id) return;
  fs.mkdirSync(SESS_DIR, { recursive: true });
  const f = sessFile(h.session_id);
  const prev = readJSON(f, null);
  writeJSON(f, { session_id: h.session_id, transcript_path: h.transcript_path, cwd: h.cwd, started_at: prev ? prev.started_at : new Date().toISOString(), source: h.source || '', blocks: prev ? prev.blocks : {} });
  // prune session files older than 30 days
  for (const name of fs.readdirSync(SESS_DIR)) {
    const p = path.join(SESS_DIR, name);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 30 * 864e5) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
  console.log(`Build Ledger is on (session ${h.session_id}). If you commit code or add a Library page, record it before you finish: run \`ledger help\` for the draft format, then \`ledger record --draft <file.json>\`.`);
}

async function hookCheck() {
  const h = readStdin();
  if (!h.session_id || !h.transcript_path) return;
  const f = sessFile(h.session_id);
  const s = readJSON(f, null) || { session_id: h.session_id, transcript_path: h.transcript_path, started_at: new Date().toISOString(), blocks: {} };
  s.transcript_path = h.transcript_path;
  let u;
  try { u = await unrecorded(s); } catch (e) {
    // Server unreachable: never trap the session; note it for the nightly check.
    fs.appendFileSync(path.join(LDIR, 'check-errors.log'), `${new Date().toISOString()} ${h.session_id} ${e.message}\n`);
    return;
  }
  if (!u.commits.length && !u.artifacts.length) return;
  const sig = crypto.createHash('sha1').update([...u.commits.map((c) => c.sha), ...u.artifacts].sort().join(',')).digest('hex').slice(0, 12);
  s.blocks = s.blocks || {};
  s.blocks[sig] = (s.blocks[sig] || 0) + 1;
  writeJSON(f, s);
  if (s.blocks[sig] > 2) {
    // Asked twice already for the same work: let the session end, keep a trace.
    fs.appendFileSync(path.join(LDIR, 'unrecorded.log'), `${new Date().toISOString()} ${h.session_id} ${u.commits.map((c) => `${c.name}:${c.sha.slice(0, 8)}`).join(' ')} ${u.artifacts.join(' ')}\n`);
    return;
  }
  const list = [...u.commits.map((c) => `${c.name} ${c.sha.slice(0, 8)}`), ...u.artifacts.map((a) => `Library page ${a.replace('@', ' v')}`)];
  const reason = `Build Ledger: this session made ${u.commits.length} commit(s) and ${u.artifacts.length} Library page(s) that are not recorded yet: ${list.join(', ')}. `
    + 'Before finishing: write a draft JSON (run `ledger help` for the format and the product/feature list) and run `ledger record --draft <file.json>`. '
    + 'If this belongs to a record you already made in this session, run `ledger link CR-NNNN --session-work`. '
    + 'If it is not product work at all (e.g. notes only), run `ledger skip --reason "<why>"`. Then finish your reply as normal.';
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
}

(async () => {
  const run = { help: cmdHelp, pending: cmdPending, record: cmdRecord, link: cmdLink, status: cmdStatus, skip: cmdSkip, show: cmdShow, verify: cmdVerify, registry: cmdRegistry,
    amend: cmdAmend, needs: cmdNeeds, backfill: cmdBackfill, inbox: cmdInbox, nightly: cmdNightly };
  if (cmd === 'work') { const w = sessionWork(currentSession()); console.log(w.commits.map((c) => `${c.name} ${c.sha.slice(0, 8)}`).join('\n') || '(no commits)'); return; }
  if (cmd === 'start') { try { hookStart(); } catch (e) { /* never break a session */ } return; }
  if (cmd === 'check') { try { await hookCheck(); } catch (e) { try { fs.appendFileSync(path.join(LDIR, 'check-errors.log'), `${new Date().toISOString()} ${e.message}\n`); } catch (x) { /* ignore */ } } return; }
  if (!run[cmd]) fail(`unknown command "${cmd}" — try: ledger help`);
  await run[cmd]();
})().catch((e) => fail(e.message));
