const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Legal pages: stable URLs for partner questionnaires and app listings.
// Kept ABOVE the catch-all.
const legal = { '/privacy': 'privacy.html', '/privacy-policy': 'privacy.html', '/terms': 'terms.html', '/terms-and-conditions': 'terms.html', '/legal': 'terms.html' };
for (const [route, file] of Object.entries(legal)) {
  app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
}

// Handle all routes by serving index.html
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Via.One website running on port ${PORT}`);
});
