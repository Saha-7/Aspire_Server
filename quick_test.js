// quick_test.js — run locally with: node quick_test.js
require('dotenv').config();
const { fetchPage } = require('./src/scraper/fetchPage');
const { parseProductDetails } = require('./src/parsers/pcstudio');

async function test() {
  const url = 'https://www.pcstudio.in/product/msi-gt-710-2gd3h-4hdmi-gaming-graphics-card/';
  const html = await fetchPage(url);
  const result = parseProductDetails(html, url);
  console.log('name:', result.name);
  console.log('salePrice:', result.salePrice);
  console.log('stockStatus:', result.stockStatus);
  // If name is null, the selectors are broken
  // Dump a snippet to inspect the HTML structure:
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  console.log('\n--- h1 tags ---');
  $('h1').each((i, el) => console.log($(el).text().trim()));
  console.log('\n--- .price elements ---');
  $('[class*="price"]').slice(0,5).each((i, el) => 
    console.log($(el).attr('class'), ':', $(el).text().trim().substring(0,60))
  );
}
test().catch(console.error);