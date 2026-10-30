// src/test-amazon-product.js  (Node 18+)
// Fetches real Amazon.in pages through Web Unlocker, runs parsers/amazon.js
// on them, and saves the raw HTML so selectors can be tuned if needed.
//
// Run:  node .\src\test-amazon-product.js
require('dotenv').config();
const fs = require('fs');
const parser = require('./parsers/amazon');

const TOKEN = (process.env.BRIGHT_DATA_API_KEY || '').trim();
const ZONE = (process.env.BRIGHT_DATA_ZONE || '').trim();

// 1) Listing URL candidates for the category (to find the form that returns
//    standard result cards AND stays inside the Keyboards category)
const LISTING_URLS = {
  k_plus_node_p1: 'https://www.amazon.in/s?k=keyboard&rh=n%3A1375419031&page=1',
  k_plus_node_p2: 'https://www.amazon.in/s?k=keyboard&rh=n%3A1375419031&page=2',
};

async function fetchPage(url) {
  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ zone: ZONE, url, format: 'raw' }),
  });
  const html = await res.text();
  if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${html.slice(0, 200)}`);
  return html;
}

async function main() {
  if (!TOKEN || !ZONE) return console.log('Missing BRIGHT_DATA_API_KEY / BRIGHT_DATA_ZONE');

  const firstLinks = {};
  for (const [name, url] of Object.entries(LISTING_URLS)) {
    console.log(`\n=== LISTING ${name} ===\n${url}`);
    try {
      const html = await fetchPage(url);
      fs.writeFileSync(`amazon-listing-${name}.html`, html);
      const links = parser.parseProductLinks(html);
      firstLinks[name] = links;
      console.log('product links:', links.length, '| next page:', parser.getNextPageUrl(html, url));
      console.log('first 5:', links.slice(0, 5));
    } catch (e) {
      console.log('failed:', e.message);
    }
  }

  const p1 = new Set(firstLinks.k_plus_node_p1 || []);
  const overlap = (firstLinks.k_plus_node_p2 || []).filter((l) => p1.has(l)).length;
  console.log(`\nPage1/Page2 overlap: ${overlap} (should be ~0 if pagination works)`);

  // 2) Product pages: first 3 links from the listing
  const sample = (firstLinks.k_plus_node_p1 || []).slice(0, 3);
  for (const url of sample) {
    console.log(`\n=== PRODUCT ${url} ===`);
    try {
      const html = await fetchPage(url);
      const asin = url.split('/dp/')[1];
      fs.writeFileSync(`amazon-product-${asin}.html`, html);
      const p = parser.parseProductDetails(html, url);
      if (!p) {
        console.log('parser returned null (blocked or not a product page)');
        continue;
      }
      const { specs, images, shortDescription, ...rest } = p;
      console.log(rest);
      console.log('description:', (shortDescription || '').slice(0, 150));
      console.log('images:', images.length, '| spec keys:', Object.keys(specs).slice(0, 12));
    } catch (e) {
      console.log('failed:', e.message);
    }
  }
}

main().catch(console.error);