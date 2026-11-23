// debugStock.js  — put this in the Backend folder (next to package.json)
// Usage:  node debugStock.js "https://vishalperipherals.com/products/amd-ryzen-threadripper-9960x-processor"
//
// Fetches the page EXACTLY like the scraper does (Bright Data Web Unlocker),
// runs the vishal parser, and shows what the raw HTML says about availability.
// Read-only: nothing is written to the database.

require('dotenv').config();
const fs      = require('fs');
const cheerio = require('cheerio');
const { fetchPage } = require('./src/scraper/fetchPage');
const vishal  = require('./src/parsers/vishal');

(async () => {
  const url = process.argv[2];
  if (!url) {
    console.log('Usage: node debugStock.js "<product url>"');
    process.exit(1);
  }

  const html = await fetchPage(url);
  fs.writeFileSync('debug_page.html', html);
  console.log('HTML length:', html.length, '(saved to debug_page.html)\n');

  const parsed = vishal.parseProductDetails(html, url);
  console.log('── What the parser returned ──');
  console.log({
    name        : parsed?.name,
    stockStatus : parsed?.stockStatus,
    sku         : parsed?.sku,
    modelNumber : parsed?.modelNumber,
    salePrice   : parsed?.salePrice,
  });

  const $ = cheerio.load(html);

  console.log('\n── <label> elements that mention "availab" ──');
  let found = false;
  $('label').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (/availab/i.test(t)) {
      found = true;
      console.log('label        :', JSON.stringify(t));
      console.log('next <span>  :', JSON.stringify($(el).next('span').text().replace(/\s+/g, ' ').trim()));
      console.log('parent html  :', ($(el).parent().html() || '').replace(/\s+/g, ' ').slice(0, 300));
      console.log('');
    }
  });
  if (!found) console.log('(none — the raw HTML has no <label> with "availability")');

  console.log('\n── Key phrases in the page text (raw HTML, no JavaScript run) ──');
  const body = $('body').text().replace(/\s+/g, ' ');
  const phrases = [/unavailable/gi, /out of stock/gi, /sold out/gi, /notify me/gi, /add to cart/gi, /in stock/gi];
  for (const re of phrases) {
    const hits = [...body.matchAll(re)];
    console.log(`${re.source}  →  ${hits.length} hit(s)`);
    hits.slice(0, 3).forEach((m) =>
      console.log('     …' + body.slice(Math.max(0, m.index - 60), m.index + 80) + '…')
    );
  }
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});