const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // one hop: Railway's edge
app.disable('x-powered-by');

// One canonical host: www.via.one -> via.one.
app.use((req, res, next) => {
  if (req.hostname && req.hostname.startsWith('www.')) {
    return res.redirect(301, `https://${req.hostname.slice(4)}${req.originalUrl}`);
  }
  next();
});

// Basic security headers.
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

// /index.html and /404.html are not separate pages.
app.get('/index.html', (req, res) => res.redirect(301, '/'));
app.get('/404.html', (req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

// Contact form: emails each message to support@via.one (SMTP_* env, same mailbox the platform sends from).
const nodemailer = require('nodemailer');
const CONTACT_TO = process.env.CONTACT_TO || 'support@via.one';
const mailer = process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'mail.privateemail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;
const recent = new Map(); // ip -> timestamps, max 5 messages per hour
setInterval(() => {
  const cutoff = Date.now() - 3600e3;
  for (const [ip, ts] of recent) if (!ts.some((t) => t > cutoff)) recent.delete(ip);
}, 600e3).unref();
const clean = (v, n) => String(v || '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

app.post('/api/contact', express.json({ limit: '20kb' }), async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // honeypot: bots fill the hidden field
  const name = clean(b.name, 120), email = clean(b.email, 200), phone = clean(b.phone, 40);
  const company = clean(b.company, 160), topic = clean(b.topic, 80);
  const message = String(b.message || '').trim().slice(0, 4000);
  if (!name || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'name, email and message are required' });
  }
  const now = Date.now();
  const hits = (recent.get(req.ip) || []).filter((t) => now - t < 3600e3);
  if (hits.length >= 5) return res.status(429).json({ ok: false, error: 'too many messages, try again later' });
  if (!mailer) return res.status(503).json({ ok: false, error: 'mail not configured' });
  try {
    await mailer.sendMail({
      from: `"via.one website" <${process.env.SMTP_USER}>`,
      to: CONTACT_TO,
      replyTo: `"${name.replace(/"/g, '')}" <${email}>`,
      subject: `Website contact: ${topic || 'General'} - ${name}${company ? ` (${company})` : ''}`,
      text: [`Name: ${name}`, `Email: ${email}`, `Phone: ${phone || '-'}`, `Company: ${company || '-'}`,
        `Interested in: ${topic || '-'}`, '', message, '', `Sent from via.one ${new Date().toISOString()} (IP ${req.ip})`].join('\n'),
    });
    hits.push(now); recent.set(req.ip, hits);
    res.json({ ok: true });
  } catch (e) {
    console.error('contact form send failed:', e.message);
    res.status(502).json({ ok: false, error: 'send failed' });
  }
});

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Legal pages: stable URLs for partner questionnaires and app listings.
// Kept ABOVE the catch-all.
const legal = { '/privacy': 'privacy.html', '/privacy-policy': 'privacy.html', '/terms': 'terms.html', '/terms-and-conditions': 'terms.html', '/legal': 'terms.html' };
for (const [route, file] of Object.entries(legal)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
}



// Unknown URLs get a real 404 (they used to return the homepage with a 200).
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Never show stack traces (e.g. malformed JSON posted to /api/contact).
app.use((err, req, res, next) => {
  console.error('request error:', err.message);
  const status = err.status || err.statusCode || 500;
  if (req.path.startsWith('/api/')) return res.status(status).json({ ok: false, error: status < 500 ? 'invalid request' : 'server error' });
  res.status(status).sendFile(path.join(__dirname, 'public', '404.html'));
});

app.listen(PORT, () => {
  console.log(`Via.One website running on port ${PORT}`);
});
