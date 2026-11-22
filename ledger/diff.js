// Step-level diff between two versions of a flow page (LCS over the step texts).
// Returns [{ op: 'same'|'add'|'del', text }] in reading order.

function diffSteps(a, b) {
  const n = a.length; const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: 'same', text: a[i] }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: 'del', text: a[i++] }); } else { out.push({ op: 'add', text: b[j++] }); }
  }
  while (i < n) out.push({ op: 'del', text: a[i++] });
  while (j < m) out.push({ op: 'add', text: b[j++] });
  return out;
}

function summary(d, va, vb) {
  const add = d.filter((x) => x.op === 'add').length;
  const del = d.filter((x) => x.op === 'del').length;
  if (!add && !del) return `v${vb} has the same steps as v${va}.`;
  const s = (k) => (k === 1 ? 'step' : 'steps');
  return `v${vb} ${[add ? `adds ${add} ${s(add)}` : '', del ? `removes ${del} ${s(del)}` : ''].filter(Boolean).join(' and ')} compared with v${va}.`;
}

module.exports = { diffSteps, summary };
