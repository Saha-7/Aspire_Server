// src/discover-amazon-categories.js  (Node 18+)
// Lists the child categories (name + node ID) of one or more Amazon.in category nodes,
// so you don't have to dig through DevTools. Prints ready-to-edit urls.js lines.
//
// Run:  node .\src\discover-amazon-categories.js 976392031
//       node .\src\discover-amazon-categories.js 976392031 1375344031
require('dotenv').config();
const fs = require('fs');
const cheerio = require('cheerio');

const TOKEN = (process.env.BRIGHT_DATA_API_KEY || '').trim();
const ZONE = (process.env.BRIGHT_DATA_ZONE || '').trim();

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

// The node ID of a category is the LAST "n:<id>" in its rh= parameter:
//   /s?rh=n%3A976392031%2Cn%3A1375425031&...  →  1375425031
function nodeFromHref(href) {
  if (!href) return null;
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch (_) { /* keep raw */ }
  const all = [...decoded.matchAll(/n:(\d+)/g)].map((m) => m[1]);
  return all.length ? all[all.length - 1] : null;
}

function chainFromHref(href) {
  if (!href) return [];
  let decoded = href;
  try { decoded = decodeURIComponent(href); } catch (_) { /* keep raw */ }
  return [...decoded.matchAll(/n:(\d+)/g)].map((m) => m[1]);
}

// parentNode (optional): the node whose children we want. It removes the parent
// itself and its ancestors (shown as the first rows of the sidebar) from the result.
function parseChildCategories(html, parentNode) {
  const $ = cheerio.load(html);
  const rows = [];
  const seen = new Set();
  $('#s-refinements a').each((_, a) => {
    const href = $(a).attr('href') || '';
    if (!/rh=/.test(href)) return;
    const chain = chainFromHref(href);
    if (!chain.length) return;
    const node = chain[chain.length - 1];
    const name = $(a).find('span').first().text().replace(/\s+/g, ' ').trim() || $(a).text().replace(/\s+/g, ' ').trim();
    if (!name || seen.has(node)) return;
    seen.add(node);
    rows.push({ name, node, chain });
  });

  if (!parentNode) return rows.map(({ name, node }) => ({ name, node }));

  // children = deeper than the parent: their chain contains the parent and ends elsewhere
  let kids = rows.filter((r) => r.node !== parentNode && r.chain.includes(parentNode));
  if (!kids.length) kids = rows.filter((r) => r.node !== parentNode && r.chain.length > 1);
  return kids.map(({ name, node }) => ({ name, node }));
}

const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function main() {
  const nodes = process.argv.slice(2);
  if (!TOKEN || !ZONE) return console.log('Missing BRIGHT_DATA_API_KEY / BRIGHT_DATA_ZONE in .env');
  if (!nodes.length) return console.log('Usage: node src/discover-amazon-categories.js <nodeId> [more nodeIds]');

  for (const node of nodes) {
    console.log(`\n=== children of node ${node} ===`);
    try {
      const candidates = [
        `https://www.amazon.in/b?node=${node}`,
        `https://www.amazon.in/s?k=a&rh=n%3A${node}`, // fallback: sidebar of the results page
      ];
      let kids = [];
      let lastHtml = '';
      for (const url of candidates) {
        console.log(url);
        lastHtml = await fetchPage(url);
        kids = parseChildCategories(lastHtml, node);
        if (kids.length) break;
        console.log('  no children found on this page, trying next form...');
      }
      if (!kids.length) {
        const file = `amazon-discover-${node}.html`;
        fs.writeFileSync(file, lastHtml);
        console.log(`No child categories found — likely a leaf category. Last page saved to ${file} for inspection.`);
        continue;
      }
      console.table(kids);
      console.log('\nurls.js lines (replace the keyword in k= with ONE simple word that matches the category, e.g. "ssd", "mouse"):');
      for (const { name, node: n } of kids) {
        const kw = encodeURIComponent(name.toLowerCase());
        console.log(`    { slug: "${slugify(name)}", url: "https://www.amazon.in/s?k=${kw}&rh=n%3A${n}" },`);
      }
    } catch (e) {
      console.log('failed:', e.message);
    }
  }
}

if (require.main === module) main().catch(console.error);
module.exports = { parseChildCategories, nodeFromHref };