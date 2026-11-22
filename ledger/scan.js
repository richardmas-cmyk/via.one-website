// Sensitive-data scanner for Build Ledger records. Runs in the `ledger` CLI before
// sending and again on the server before anything is appended. It reports the field
// and the KIND of problem, never the value itself.

const SECRET_PATTERNS = [
  ['stripe-key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/],
  ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['telegram-bot-token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ['anthropic-or-openai-key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/],
  ['url-with-password', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  ['password-assignment', /\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?(?=[^\s"',;]*\d)(?=[^\s"',;]*[A-Za-z])[^\s"',;]{8,}/i],
];

const luhn = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};
const clabeValid = (d) => {
  const w = [3, 7, 1];
  let s = 0;
  for (let i = 0; i < 17; i++) s += (Number(d[i]) * w[i % 3]) % 10;
  return (10 - (s % 10)) % 10 === Number(d[17]);
};
const entropy = (s) => {
  const f = {};
  for (const c of s) f[c] = (f[c] || 0) + 1;
  return Object.values(f).reduce((h, n) => h - (n / s.length) * Math.log2(n / s.length), 0);
};

// Strings that are pure hex/uuid (commit SHAs, hashes, deploy ids) skip the number checks.
const HEXISH = /^(?:sha256:)?(?=[0-9-]*[a-f])[0-9a-f-]{7,80}$/i;

function scanString(s) {
  const found = new Set();
  if (typeof s !== 'string' || !s) return found;
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(s)) found.add(kind);
  if (HEXISH.test(s.trim())) return found;
  // File paths (no spaces, has a slash or an extension) skip the number checks:
  // migration names like 1790000000156_x.sql are timestamps, not account numbers.
  if (!/[\s@+]/.test(s) && (/\//.test(s) || /\.[a-z0-9]{1,5}$/i.test(s))) return found;

  // Card numbers: 13-19 digits (spaces/dashes allowed) that pass the Luhn check.
  for (const m of s.matchAll(/(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length === 18 && clabeValid(d)) found.add('clabe');
    else if (d.length >= 13 && d.length <= 19 && luhn(d)) found.add('card-number');
  }
  // Long bare digit runs (account numbers) — 10+ digits that are not a date/time stamp.
  for (const m of s.matchAll(/(?<![\d.:-])\d{10,}(?![\d])/g)) {
    if (!/^(?:19|20)\d{2}[01]\d[0-3]\d/.test(m[0])) found.add('account-number');
  }
  if (/(?<![\w])\+\d[\d ()-]{9,17}\d/.test(s) || /(?<![\d])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\d])/.test(s)) found.add('phone');
  for (const m of s.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)) {
    if (!/^(?:via\.one|example\.com|anthropic\.com)$/i.test(m[1])) found.add('email');
  }
  if (/\b[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d\b/.test(s)) found.add('curp');
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(s)) found.add('ssn');
  // High-entropy blobs (random keys). Paths and words split on / . and spaces.
  for (const tok of s.split(/[\s/.,;:()"'`[\]{}<>]+/)) {
    if (tok.length >= 32 && /[A-Z]/.test(tok) && /[a-z]/.test(tok) && /\d/.test(tok) && entropy(tok) > 4.2) found.add('high-entropy-string');
  }
  return found;
}

// Returns [{ field: 'what_changed[2]', kinds: ['phone'] }, ...]. Empty = clean.
function scan(value, pathName = '') {
  const out = [];
  const walk = (v, p) => {
    if (typeof v === 'string') {
      const k = scanString(v);
      if (k.size) out.push({ field: p || '(value)', kinds: [...k] });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(value, pathName);
  return out;
}

const describe = (findings) => findings.map((f) => `${f.field}: ${f.kinds.join(', ')}`).join('; ');

module.exports = { scan, scanString, describe };
