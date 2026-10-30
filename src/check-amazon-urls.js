// src/check-amazon-urls.js  (Node 18+)
// Health check for Amazon category URLs. For each URL it fetches page 1 through
// Web Unlocker and reports how many product cards the parser finds.
// "links: 0" means that URL form returns a landing page / no result cards.
//
// Run:  node .\src\check-amazon-urls.js
require('dotenv').config();
const parser = require('./parsers/amazon');

const TOKEN = (process.env.BRIGHT_DATA_API_KEY || '').trim();
const ZONE = (process.env.BRIGHT_DATA_ZONE || '').trim();

// ── Edit this list: put the URLs you want to test ──────────────
const URLS = [
  // Monitors — three candidate URL forms
  'https://www.amazon.in/s?k=monitor&rh=n%3A1375425031',
  'https://www.amazon.in/s?k=monitor&i=computers&rh=n%3A1375425031',
  'https://www.amazon.in/s?rh=n%3A976392031%2Cn%3A1375425031',
  // Keyboards — the form that already worked, for comparison
  'https://www.amazon.in/s?k=keyboard&rh=n%3A1375419031',
];

async function fetchPage(url) {
  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ zone: ZONE, url, format: 'raw' }),
  });
  const html = await res.text();
  return { status: res.status, html };
}

async function main() {
  if (!TOKEN || !ZONE) return console.log('Missing BRIGHT_DATA_API_KEY / BRIGHT_DATA_ZONE in .env');
  const rows = [];
  for (const url of URLS) {
    try {
      const { status, html } = await fetchPage(url);
      const links = parser.parseProductLinks(html);
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
      rows.push({
        status,
        bytes: html.length,
        links: links.length,
        nextPage: parser.getNextPageUrl(html, url) ? 'yes' : 'no',
        title: title.trim().slice(0, 50),
        url: url.slice(0, 70),
      });
    } catch (e) {
      rows.push({ status: 'ERR', bytes: 0, links: 0, nextPage: '-', title: e.message.slice(0, 50), url: url.slice(0, 70) });
    }
  }
  console.table(rows);
}

if (require.main === module) main().catch(console.error);