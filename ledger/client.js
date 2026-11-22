/* Build Ledger browser script: text size, theme, Read aloud, keys, flow zoom, search.
   Runs inline (CSP nonce). No outside services: speech uses the browser's own voices. */
(function () {
  'use strict';
  var root = document.documentElement;
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  // ---------- text size + theme ----------
  function scale(d) {
    var s = parseFloat(store.get('bl.scale') || '1') + d;
    s = Math.max(1, Math.min(2.5, Math.round(s * 100) / 100));
    root.style.setProperty('--scale', s); store.set('bl.scale', String(s));
    say('Text size ' + Math.round(s * 100) + ' percent');
  }
  function theme() {
    var cur = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    var next = cur === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next); store.set('bl.theme', next);
    say(next + ' theme');
  }
  var live = document.createElement('p'); live.className = 'sr'; live.setAttribute('aria-live', 'polite'); document.body.appendChild(live);
  function say(t) { live.textContent = t; }

  // ---------- Read aloud ----------
  var voiceLang = store.get('bl.voice') || 'en';
  var vbtn = $('[data-act=voice]'); if (vbtn) vbtn.textContent = voiceLang.toUpperCase();
  var reading = false;
  function stopReading() {
    reading = false;
    if (window.speechSynthesis) speechSynthesis.cancel();
    $$('.speaking').forEach(function (el) { el.classList.remove('speaking'); });
  }
  function pickVoice() {
    var vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
    var want = voiceLang === 'es' ? /^es/i : /^en/i;
    return vs.filter(function (v) { return want.test(v.lang); }).sort(function (a, b) { return (b.localService ? 1 : 0) - (a.localService ? 1 : 0); })[0] || null;
  }
  function readAloud(els) {
    if (!window.speechSynthesis) { say('Read aloud is not available in this browser'); return; }
    if (reading) { stopReading(); return; }
    var parts = (els || $$('main [data-read]')).filter(function (el) { return el.offsetParent !== null && el.textContent.trim(); });
    if (!parts.length) parts = [$('main h1')].filter(Boolean);
    reading = true;
    var i = 0;
    var rate = parseFloat(store.get('bl.rate') || '0.95');
    (function next() {
      $$('.speaking').forEach(function (el) { el.classList.remove('speaking'); });
      if (!reading || i >= parts.length) { reading = false; return; }
      var el = parts[i++];
      el.classList.add('speaking');
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
      var u = new SpeechSynthesisUtterance(el.textContent.replace(/[●◐◇○◍↺✕⊘▶✓⚠]/g, ' ').replace(/\s+/g, ' ').trim());
      var v = pickVoice(); if (v) u.voice = v;
      u.lang = v ? v.lang : (voiceLang === 'es' ? 'es-MX' : 'en-US');
      u.rate = rate;
      u.onend = next; u.onerror = next;
      speechSynthesis.speak(u);
    })();
  }

  // ---------- help ----------
  var help = $('#help'); var helpReturn = null;
  function toggleHelp(open) {
    if (!help) return;
    var show = open == null ? help.hidden : open;
    if (show) { helpReturn = document.activeElement; help.hidden = false; $('button', help).focus(); }
    else { help.hidden = true; if (helpReturn) helpReturn.focus(); }
  }

  // ---------- flow zoom ----------
  var zoom = 1;
  function setZoom(d) {
    var f = $('#flow'); if (!f) return;
    zoom = Math.max(0.5, Math.min(2, Math.round((zoom + d) * 10) / 10));
    f.style.transform = 'scale(' + zoom + ')';
    f.style.width = (100 / zoom) + '%'; f.style.height = (100 / zoom) + '%';
    say('Flow zoom ' + Math.round(zoom * 100) + ' percent');
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var a = b.getAttribute('data-act');
    if (a === 'smaller') scale(-0.15);
    else if (a === 'bigger') scale(0.15);
    else if (a === 'theme') theme();
    else if (a === 'read') readAloud();
    else if (a === 'voice') { voiceLang = voiceLang === 'en' ? 'es' : 'en'; store.set('bl.voice', voiceLang); b.textContent = voiceLang.toUpperCase(); say(voiceLang === 'es' ? 'Voz en español' : 'English voice'); }
    else if (a === 'help') toggleHelp();
    else if (a === 'help-close') toggleHelp(false);
    else if (a === 'zoom-in') setZoom(0.1);
    else if (a === 'zoom-out') setZoom(-0.1);
    else if (a === 'read-item') { var it = b.closest('.item'); if (it) readAloud($$('[data-read], .t', it)); }
  });

  // ---------- keys ----------
  var sel = -1; var gPending = false;
  function navItems() { return $$('main [data-nav]').filter(function (el) { return el.offsetParent !== null; }); }
  function move(d) {
    var items = navItems(); if (!items.length) return;
    sel = Math.max(0, Math.min(items.length - 1, sel + d));
    items.forEach(function (el) { el.classList.remove('sel'); });
    var it = items[sel]; it.classList.add('sel');
    var link = $('a', it); if (link) link.focus(); else it.scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { stopReading(); if (help && !help.hidden) toggleHelp(false); return; }
    var t = e.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing) {
      if (t.id === 'q' && (e.key === 'ArrowDown')) { e.preventDefault(); sel = -1; move(1); }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (gPending) { gPending = false; if (e.key === 'h') { location.href = '/library/ledger'; return; } }
    switch (e.key) {
      case '/': e.preventDefault(); var q = $('#q'); if (q) q.focus(); else location.href = '/library/ledger#search'; break;
      case 'j': case 'ArrowDown': if (e.key === 'ArrowDown' && sel < 0) return; e.preventDefault(); move(1); break;
      case 'k': case 'ArrowUp': if (e.key === 'ArrowUp' && sel < 0) return; e.preventDefault(); move(-1); break;
      case 'r': readAloud(); break;
      case '?': toggleHelp(); break;
      case '+': case '=': scale(0.15); break;
      case '-': scale(-0.15); break;
      case 'g': gPending = true; setTimeout(function () { gPending = false; }, 1200); break;
      case '[': case ']': {
        var vers = $$('[data-ver]'); if (!vers.length) break;
        var cur = vers.findIndex(function (a) { return a.getAttribute('aria-current') === 'true'; });
        // buttons are newest first: ] = newer (left), [ = older (right)
        var nx = vers[e.key === ']' ? cur - 1 : cur + 1];
        if (nx) location.href = nx.href;
        break;
      }
      default:
    }
  });
  if (location.hash === '#search' && $('#q')) $('#q').focus();

  // ---------- search (home only) ----------
  var q = $('#q'); if (!q) return;
  var resultsEl = $('#results'); var dash = $('#dash'); var alsoEl = $('#also'); var countEl = $('#count');
  var fProduct = $('#f-product'); var fKind = $('#f-kind'); var fStatus = $('#f-status');
  var DATA = null; var INDEX = null; var VOCAB = null;

  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }
  function stem(t) {
    if (t.length > 5 && /ciones$/.test(t)) return t.slice(0, -2);
    if (t.length > 5 && /(ing)$/.test(t)) return t.slice(0, -3);
    if (t.length > 5 && /ed$/.test(t)) return t.slice(0, -2);
    if (t.length > 4 && /[^aeiou]es$/.test(t) && !/(ses|ces)$/.test(t)) return t.slice(0, -2);
    if (t.length > 3 && /s$/.test(t) && !/ss$/.test(t)) return t.slice(0, -1);
    return t;
  }
  function toks(s) { return norm(s).split(/[^a-z0-9_]+/).filter(function (t) { return t.length > 1 || /\d/.test(t); }).map(stem); }
  var W = { title: 5, names: 4, tags: 3, summary: 2, body: 1, code: 0.5 };

  function build() {
    INDEX = Object.create(null);
    DATA.docs.forEach(function (d, i) {
      Object.keys(W).forEach(function (f) {
        toks(d[f]).forEach(function (t) {
          var m = INDEX[t] || (INDEX[t] = Object.create(null));
          m[i] = Math.max(m[i] || 0, W[f]);
        });
      });
      d._code = norm(d.code);
    });
    VOCAB = Object.keys(INDEX);
  }
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    var prev = []; var pp = []; for (var j = 0; j <= b.length; j++) prev[j] = j;
    for (var i = 1; i <= a.length; i++) {
      var cur = [i]; var best = i;
      for (var k = 1; k <= b.length; k++) {
        cur[k] = Math.min(prev[k] + 1, cur[k - 1] + 1, prev[k - 1] + (a[i - 1] === b[k - 1] ? 0 : 1));
        if (i > 1 && k > 1 && a[i - 1] === b[k - 2] && a[i - 2] === b[k - 1]) cur[k] = Math.min(cur[k], pp[k - 2] + 1);
        if (cur[k] < best) best = cur[k];
      }
      if (best > max) return max + 1;
      pp = prev; prev = cur;
    }
    return prev[b.length];
  }
  // score map for one query term: docIdx -> weight
  function termHits(t, isLast) {
    var out = Object.create(null);
    var add = function (tok, mult) { var m = INDEX[tok]; if (!m) return; for (var i in m) out[i] = Math.max(out[i] || 0, m[i] * mult); };
    add(t, 1);
    var maxD = t.length >= 8 ? 2 : t.length >= 4 ? 1 : 0;
    VOCAB.forEach(function (v) {
      if (v === t) return;
      if (isLast && t.length >= 2 && v.indexOf(t) === 0) add(v, 0.7);
      else if (maxD && lev(t, v, maxD) <= maxD) add(v, 0.5);
    });
    return out;
  }
  function expand(qn) {
    // synonym groups: if the query contains any phrase of a group, search the others too
    var extra = []; var shown = [];
    var groups = DATA.synonyms || {};
    var inQ = function (p) { var pn = norm(p); return pn && (' ' + qn + ' ').indexOf(' ' + pn + ' ') >= 0; };
    var matched = {};
    Object.keys(groups).forEach(function (g) { var m = groups[g].filter(inQ).map(norm); if (m.length) matched[g] = m; });
    Object.keys(groups).forEach(function (g) {
      var phrases = groups[g];
      if (!matched[g]) return;
      var longest = matched[g].reduce(function (a, b) { return b.length > a.length ? b : a; });
      var swallowed = Object.keys(matched).some(function (o) { return o !== g && matched[o].some(function (p) { return p.length > longest.length && (' ' + p + ' ').indexOf(' ' + longest + ' ') >= 0; }); });
      if (swallowed) return;
      phrases.forEach(function (p) { if ((' ' + qn + ' ').indexOf(' ' + norm(p) + ' ') < 0) { extra.push(p); shown.push(p); } });
    });
    var kinds = []; var KW = DATA.kindWords || {};
    Object.keys(KW).forEach(function (k) { if (KW[k].some(function (w) { return (' ' + qn + ' ').indexOf(' ' + norm(w) + ' ') >= 0; })) kinds.push(k); });
    return { extra: extra, shown: shown.slice(0, 10), kinds: kinds };
  }
  var STATUS_MULT = { live: 1.2, live_inferred: 1.15, built_flag_off: 1.1, staged: 1.1, proposed: 1, rolled_back: 0.9, retired: 0.8, abandoned: 0.8 };
  var GROUPS = [['product', 'Product lines'], ['feature', 'Features'], ['change', 'Changes'], ['page', 'Pages and flows']];

  function search() {
    var raw = q.value.trim();
    var fp = fProduct.value, fk = fKind.value, fs = fStatus.value;
    if (!raw && !fp && !fk && !fs) { resultsEl.hidden = true; dash.hidden = false; alsoEl.textContent = ''; countEl.textContent = ''; sel = -1; return; }
    var qn = norm(raw);
    var scores = Object.create(null);
    var exp = { extra: [], shown: [], kinds: [] };
    if (raw) {
      // exact jumps: CR number, commit SHA prefix, flag/file names
      var crm = /^cr-?0*(\d{1,6})$/i.exec(raw.replace(/\s+/g, ''));
      var exactId = crm ? 'CR-' + ('000' + crm[1]).slice(-Math.max(4, crm[1].length)) : null;
      var isSha = /^[0-9a-f]{7,40}$/i.test(raw);
      var isCode = /^[A-Za-z0-9_./-]{4,}$/.test(raw) && /[_./]/.test(raw);
      DATA.docs.forEach(function (d, i) {
        if (exactId && d.id === exactId) scores[i] = 1000;
        else if ((isSha || isCode) && d._code && d._code.split(' ').some(function (c) { return c === qn || (isSha && c.indexOf(qn) === 0) || (isCode && c.indexOf(qn) >= 0); })) scores[i] = 500;
      });
      exp = expand(qn);
      var qt = toks(raw);
      var covered = Object.create(null);
      qt.forEach(function (t, n) {
        var h = termHits(t, n === qt.length - 1);
        for (var i in h) { scores[i] = (scores[i] || 0) + h[i]; covered[i] = (covered[i] || 0) + 1; }
      });
      var extraHit = Object.create(null);
      exp.extra.forEach(function (p) {
        toks(p).forEach(function (t) { var m = INDEX[t]; if (!m) return; for (var i in m) { scores[i] = (scores[i] || 0) + m[i] * 0.8; extraHit[i] = 1; } });
      });
      for (var i in scores) {
        if (scores[i] >= 500) continue;
        var cov = extraHit[i] ? 1 : (covered[i] || 0) / Math.max(1, qt.length);
        var d = DATA.docs[i];
        var age = d.date ? (Date.now() - Date.parse(d.date)) / 864e5 : 365;
        scores[i] = scores[i] * cov * cov * (1 + 0.5 * Math.exp(-age / 60)) * (STATUS_MULT[d.status] || 1) * (exp.kinds.indexOf(d.kind) >= 0 ? 1.5 : 1);
        if (d.type === 'product' || d.type === 'feature') scores[i] *= 1.5;
        if (norm(d.title).indexOf(qn) >= 0) scores[i] += 3;
      }
    } else {
      DATA.docs.forEach(function (d, i) { if (d.type === 'change') scores[i] = Date.parse(d.date) / 1e12; });
    }
    var top = 0; for (var s in scores) if (scores[s] > top) top = scores[s];
    var floor = raw ? Math.max(0.15, (top >= 500 ? 500 : top) * 0.3) : 0;
    var hits = Object.keys(scores).filter(function (i) {
      var d = DATA.docs[i];
      if (scores[i] <= floor) return false;
      if (fp && d.product !== fp) return false;
      if (fk && (d.type !== 'change' || d.kind !== fk)) return false;
      if (fs && (d.type !== 'change' || d.status !== fs)) return false;
      return true;
    }).sort(function (a, b) { return scores[b] - scores[a]; });

    alsoEl.textContent = exp.shown.length ? 'Also searching: ' + exp.shown.join(' · ') : '';
    var html = '';
    GROUPS.forEach(function (g) {
      var list = hits.filter(function (i) { return DATA.docs[i].type === g[0]; });
      if (!list.length) return;
      html += '<section><h2>' + g[1] + ' (' + list.length + ')</h2><ol class="list" style="margin-top:10px">';
      list.slice(0, 40).forEach(function (i) {
        var d = DATA.docs[i];
        html += '<li class="item" data-nav><a class="t" href="' + d.url + '">' + d.titleHtml + '</a><div class="meta">' + d.metaHtml + '</div>' +
          (d.summary ? '<p data-read>' + d.summaryHtml + '</p>' : '') + '</li>';
      });
      html += '</ol></section>';
    });
    resultsEl.innerHTML = html || '<p class="card">No results. Try a shorter word, Spanish or English, or a CR number.</p>';
    resultsEl.hidden = false; dash.hidden = true; sel = -1;
    countEl.textContent = hits.length + (hits.length === 1 ? ' result' : ' results') + (raw ? ' for ' + raw : '');
  }

  var timer = null;
  function schedule() { clearTimeout(timer); timer = setTimeout(function () { if (DATA) search(); }, 80); }
  q.addEventListener('input', schedule);
  [fProduct, fKind, fStatus].forEach(function (s) { s.addEventListener('change', schedule); });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { var first = $('#results a.t'); if (first && !resultsEl.hidden) location.href = first.href; }
  });
  fetch('/library/ledger/search.json', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
    DATA = j; build(); if (q.value || fProduct.value || fKind.value || fStatus.value) search();
  }).catch(function () { alsoEl.textContent = '⚠ Search could not load. Reload the page.'; });
  if (!location.hash) q.focus();
})();
