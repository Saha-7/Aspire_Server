// src/parsers/theitdepot.js
// ─────────────────────────────────────────────────────────────
// TheITDepot Store — OpenCart (Journal theme)
// Web Unlocker / cheerio version — synchronous, receives HTML string
//
// NOTES:
// - The category page's visible "Load Next Products" button is an
//   Infinite-Ajax-Scroll (IAS) widget with no real href. The page also
//   renders a hidden, standard OpenCart pagination block
//   (div.pagination-results > ul.pagination) with real ?page=N links —
//   we follow that instead of trying to drive the AJAX button.
// - The product page emits several <script type="application/ld+json">
//   blocks (WebSite, Organization, BreadcrumbList, Product) — must
//   filter by "@type":"Product", not just grab the first script.
// - theitdepot's own "sku" field is almost always empty; "Model"
//   (e.g. TID5266) is the real identifier shown/used on the site, so
//   it's treated as the primary SKU-ish field (see STORE_SKU_FIELDS
//   in competitorPriceService.js — must add a theitdepot entry there).
// - The "Out Of Stock" ribbon uses the same .product-labels class for
//   the main product AND every related-product card further down the
//   page, so DOM stock scraping isn't safely scoped — JSON-LD
//   offers.availability is used as the primary signal instead.
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

const BASE = 'https://www.theitdepot.com';

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim() || null;
}

// Resolves relative → absolute and strips the query string. Safe for
// PRODUCT links (theitdepot product URLs never carry a meaningful query
// string — anything after "?" is just tracking noise).
function absoluteUrl(href) {
  if (!href) return null;
  href = href.trim();
  if (href.startsWith('http')) return href.split('?')[0];
  if (href.startsWith('//'))   return ('https:' + href).split('?')[0];
  if (href.startsWith('/'))    return (BASE + href).split('?')[0];
  return null;
}

// Resolves relative → absolute WITHOUT touching the query string. Must
// be used for pagination links — unlike product URLs, category page
// links rely entirely on "?page=N" to mean anything.
function resolveUrl(href) {
  if (!href) return null;
  href = href.trim();
  if (href.startsWith('http')) return href;
  if (href.startsWith('//'))   return 'https:' + href;
  if (href.startsWith('/'))    return BASE + href;
  return null;
}

// Pull out the Product JSON-LD block specifically (there are several
// ld+json scripts per page — see notes above).
function getProductJsonLd($) {
  let data = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (data) return;
    try {
      const parsed = JSON.parse($(el).contents().text());
      if (parsed && parsed['@type'] === 'Product') data = parsed;
    } catch (_) {
      // ignore malformed / unrelated blocks
    }
  });
  return data;
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT LINKS
//  Scoped to div.main-products (the OpenCart product grid). Each card
//  is a div.product-layout with a div.name a[href] to the product page.
// ─────────────────────────────────────────────────────────────
function parseProductLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  const grid = $('div.main-products').length ? $('div.main-products') : $.root();

  grid.find('div.product-layout div.name a[href]').each((_, el) => {
    const href = absoluteUrl($(el).attr('href'));
    if (href) links.add(href);
  });

  return [...links];
}

// ─────────────────────────────────────────────────────────────
//  PAGINATION
//  Standard OpenCart pagination, rendered hidden on the page:
//    <div class="pagination-results">
//      <ul class="pagination">...<li><a class="next" href="...?page=4">></a></li></ul>
// ─────────────────────────────────────────────────────────────
function getNextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);

  const next = $('.pagination-results ul.pagination li a.next').attr('href');
  if (!next) return null;

  const nextUrl = resolveUrl(next) || next;
  if (nextUrl === currentUrl) return null;

  return nextUrl;
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT DETAILS
// ─────────────────────────────────────────────────────────────
function parseProductDetails(html, url) {
  const $ = cheerio.load(html);
  const jsonLd = getProductJsonLd($);

  // ── Name ────────────────────────────────────────────────────
  const name =
    cleanText($('h1.page-title .page-title-text').first().text()) ||
    cleanText(jsonLd?.name) ||
    null;

  // ── Model / SKU ─────────────────────────────────────────────
  const model =
    cleanText($('li.product-model span').first().text()) ||
    cleanText(jsonLd?.model) ||
    null;

  const sku = cleanText(jsonLd?.sku) || null;

  // ── Brand ───────────────────────────────────────────────────
  const brand =
    cleanText($('li.product-manufacturer a').first().text()) ||
    cleanText(jsonLd?.brand?.name) ||
    null;

  // ── Prices ──────────────────────────────────────────────────
  // .product-price-new / .product-price-old live only in the main
  // product-price-group block — unlike .product-labels, these are NOT
  // reused by related-product cards on this theme, so no extra scoping
  // is needed. JSON-LD price is kept as a fallback.
  const salePrice =
    cleanText($('.product-price-group .product-price-new').first().text()) ||
    (jsonLd?.offers?.price ? `\u20b9${jsonLd.offers.price}` : null);

  const originalPrice =
    cleanText($('.product-price-group .product-price-old').first().text()) ||
    null;

  // ── Stock ───────────────────────────────────────────────────
  let stockStatus = null;
  if (jsonLd?.offers?.availability) {
    stockStatus = /instock/i.test(jsonLd.offers.availability) ? 'In Stock' : 'Out Of Stock';
  } else {
    // Fallback only: the FIRST .product-labels on the page belongs to
    // the main product's own image gallery (related-product cards with
    // the same class come later in the DOM).
    const labelText = cleanText($('.product-labels').first().text()) || '';
    stockStatus = /out of stock/i.test(labelText) ? 'Out Of Stock' : 'In Stock';
  }

  // ── Category (breadcrumb) ────────────────────────────────────
  // Breadcrumb: Home > Motherboard > <product name> — take the last
  // link before the (non-link) product name, same pattern as other
  // parsers, instead of trusting a hardcoded category string.
  const breadcrumbLinks = [];
  $('.breadcrumbs .breadcrumb a, ul.breadcrumb a').each((_, el) => {
    const text = cleanText($(el).text());
    if (text) breadcrumbLinks.push(text);
  });

  const category = breadcrumbLinks.length > 1
    ? breadcrumbLinks[breadcrumbLinks.length - 2]
    : null;

  // ── Specs (Specification tab) ────────────────────────────────
  const specs = {};
  $('#tab-specification table tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length === 2) {
      const key   = cleanText($(cells[0]).text());
      const value = cleanText($(cells[1]).text());
      if (key && value) specs[key] = value;
    }
  });

  return {
    url,
    store: 'theitdepot',

    name,

    sku,
    model,
    modelNumber: model,
    productCode: model,

    brand,
    category,
    stockStatus,

    salePrice,
    originalPrice,

    specs,

    scrapedAt : new Date().toISOString(),
    scrapedVia: 'web_unlocker',
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };