// ─────────────────────────────────────────────────────────────
//  parsers/primeabgb.js  (Web Unlocker / cheerio version)
//  WooCommerce-based store — same selectors as Playwright version
//  All functions are now synchronous — receive html string, return data.
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

// ── Extract all product links from a category/listing page ───
function parseProductLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();
  const BASE = 'https://www.primeabgb.com';

  $('a[href]').each((_, el) => {
    let href = $(el).attr('href') || '';

    // Resolve relative URLs to absolute
    if (href.startsWith('/')) href = BASE + href;

    if (href.includes('/online-price-reviews-india/')) {
      links.add(href.split('?')[0]);
    }
  });

  return [...links];
}

// ── Return the next pagination URL, or null on last page ─────
function getNextPageUrl(html) {
  const $ = cheerio.load(html);
  const next = $('a.next.page-numbers').attr('href');
  return next || null;
}

// ── Extract all product data from a single product page ──────
function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  const getText = (selector) => $(selector).first().text().trim() || null;

  // ── Name ──────────────────────────────────────────────────
  const name =
    getText('.product_title') ||
    getText('h1.entry-title') ||
    getText('h1');

  // ── Prices ────────────────────────────────────────────────
  // WooCommerce: sale price is inside <ins>, original inside <del>
  const salePrice =
    $('.price ins .woocommerce-Price-amount bdi').first().text().trim() ||
    $('.price ins').first().text().trim() ||
    $('.woocommerce-Price-amount bdi').first().text().trim() ||
    null;

  const originalPrice =
    $('.price del .woocommerce-Price-amount bdi').first().text().trim() ||
    $('.price del').first().text().trim() ||
    null;

  const discountBadge =
    getText('.onsale') ||
    getText('.badge-sale') ||
    null;

  // ── SKU & Stock ───────────────────────────────────────────
  const sku = getText('.sku') || null;

  const stockStatus =
    getText('.stock-availability') ||
    getText('.stock') ||
    null;

  // ── Category (from breadcrumb) ────────────────────────────
  const breadcrumbs = [];
  $('.woocommerce-breadcrumb a, nav.breadcrumb a').each((_, el) => {
    const t = $(el).text().trim();
    if (t) breadcrumbs.push(t);
  });

  const category = breadcrumbs.length > 1
    ? breadcrumbs[breadcrumbs.length - 1]
    : getText('.posted_in a') || null;

  // ── Tags ──────────────────────────────────────────────────
  const tags = [];
  $('.tagged_as a').each((_, el) => {
    const t = $(el).text().trim();
    if (t) tags.push(t);
  });

  // ── Images ───────────────────────────────────────────────
  const images = [];
  $('.woocommerce-product-gallery img, .product-images img').each((_, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) images.push(src);
  });

  // ── Specs ─────────────────────────────────────────────────
  const specs = {};
  $('.woocommerce-product-attributes tr, .shop_attributes tr').each((_, row) => {
    const key   = $(row).find('th').text().trim();
    const value = $(row).find('td').text().trim();
    if (key && value) specs[key] = value;
  });

  // ── Short Description ─────────────────────────────────────
  const shortDescription =
    getText('.woocommerce-product-details__short-description') ||
    getText('.short-description') ||
    null;

  return {
    url,
    store: 'primeabgb',
    name,
    sku,
    category,
    stockStatus,
    salePrice     : salePrice     || null,
    originalPrice : originalPrice || null,
    discountBadge : discountBadge || null,
    shortDescription,
    tags,
    images,
    specs,
    scrapedAt: new Date().toISOString(),
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };