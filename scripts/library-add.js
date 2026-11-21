#!/usr/bin/env node
// Adds an HTML page (or a new version of one) to the Via One Library.
//
//   node scripts/library-add.js <file.html> --slug check-cashing-flow --title "Check Cashing Flow" \
//        [--summary "..."] [--category "El Vecino"] [--note "what changed"] [--base https://via.one]
//   node scripts/library-add.js --list
//   node scripts/library-add.js --revoke check-cashing-flow --v 1     (new outside link, old one dies)
//
// Token: env LIBRARY_UPLOAD_TOKEN, or the file named by LIBRARY_TOKEN_FILE
// (default ~/Secrets-vault/viaone-library/upload-token). A copy of every page added is
// kept in LIBRARY_BACKUP_DIR (default ~/Desktop/Filing_Cabinet/11_Technical/Via_One_Library).
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);
const opt = {}; const rest = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { const k = args[i].slice(2); opt[k] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true; } else rest.push(args[i]);
}
const base = String(opt.base || process.env.LIBRARY_BASE || 'https://via.one').replace(/\/$/, '');
const tokenFile = process.env.LIBRARY_TOKEN_FILE || path.join(os.homedir(), 'Secrets-vault/viaone-library/upload-token');
const token = process.env.LIBRARY_UPLOAD_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '');
const backupDir = process.env.LIBRARY_BACKUP_DIR || path.join(os.homedir(), 'Desktop/Filing_Cabinet/11_Technical/Via_One_Library');
const fail = (m) => { console.error(`❌ ${m}`); process.exit(1); };
if (!token) fail(`no upload token (env LIBRARY_UPLOAD_TOKEN or ${tokenFile})`);

async function call(method, route, body) {
  const res = await fetch(`${base}/library/api/${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) fail(`${method} ${route} → ${res.status} ${json.error || ''}`);
  return json;
}

(async () => {
  if (opt.list) {
    const { items } = await call('GET', 'items');
    for (const it of items) for (const v of it.versions) console.log(`${it.slug}  v${v.v}  ${v.date}  ${it.title}${v.note ? `  (${v.note})` : ''}\n   sign-in: ${v.url}\n   outside: ${v.shareUrl}`);
    return;
  }
  if (opt.revoke) {
    const r = await call('POST', 'revoke', { slug: opt.revoke, v: Number(opt.v) });
    console.log(`✅ ${r.slug} v${r.v}: old outside link is dead\n   new outside link: ${r.shareUrl}`);
    return;
  }
  const file = rest[0];
  if (!file || !opt.slug) fail('usage: library-add.js <file.html> --slug <slug> --title "<title>" [--summary] [--category] [--note]');
  const html = fs.readFileSync(file, 'utf8');
  const r = await call('POST', 'items', { slug: opt.slug, title: opt.title, summary: opt.summary, category: opt.category, note: opt.note, date: opt.date, html });
  console.log(`✅ ${r.slug} is now at version ${r.v}\n   sign-in: ${r.url}\n   outside: ${r.shareUrl}`);
  if (fs.existsSync(path.dirname(backupDir))) {
    const dest = path.join(backupDir, r.slug, `${r.slug}_v${r.v}.html`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    console.log(`   copy:    ${dest}`);
  }
})().catch((e) => fail(e.message));
