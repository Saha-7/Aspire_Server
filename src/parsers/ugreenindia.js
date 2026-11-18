// src/parsers/ugreenindia.js
// ─────────────────────────────────────────────────────────────
// UGREEN India (ugreenindia.com) — Shopify storefront.
// Web Unlocker / cheerio version — synchronous, receives HTML string.
//
// Exports (same 3 as every other parser):
//   parseProductLinks(html)            → string[]
//   getNextPageUrl(html, currentUrl)   → string | null
//   parseProductDetails(html, url)     → object
//
// NOTES
// - Listing page: every product is a <product-card> inside the results
//   grid (#filter-results). Links are scoped to <product-card> so header
//   mega-menu / recommendation links never leak in. Sold-out products ARE
//   listed (they carry a "Sold out" label and a disabled Add-to-cart) and
//   are intentionally kept — we want their price + "Out of Stock" status.
// - Listing links look like /collections/<handle>/products/<product>.
//   index.js already dedupes those against /products/<product> via
//   canonicalizeProductUrl(), so we return them as-is.
// - Pagination: the theme uses infinite scroll, but the server HTML still
//   carries normal Shopify pagination links (?page=N) when a collection has
//   more than one page. For a single-page collection the nav is empty →
//   null. index.js has its own loop guard (visitedListingUrls).
// - SKU priority:  1) .product-sku__value (top of the product page)
//                  2) JSON-LD Product.sku
//                  3) "Model" spec row, e.g. "UGREEN 95521" → drop the
//                     leading brand word → "95521"
// - Stock priority: 1) JSON-LD offers.availability (server-rendered)
//                   2) main Add-to-cart button (disabled / "Sold out")
//                   3) Sold-out label / Back-in-stock "NOTIFY ME" button
//   Returns exactly 'In Stock' / 'Out of Stock' (what the pipeline compares
//   against) or null when genuinely unknown.
// - Prices: scoped to .product-info__price so recommendation cards further
//   down the page can never pollute them. Sale price = .price__current,
//   original price = .price__was (absent when the product isn't discounted).
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

const BASE  = 'https://ugreenindia.com';
const STORE = 'ugreenindia';

// ── helpers ──────────────────────────────────────────────────
function cleanText(value) {
  return String(value || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, '') // invisible LTR/RTL marks etc.
    .replace(/\s+/g, ' ')
    .trim() || null;
}

// "Rs. 5,399.00" → 5399   (numbers only, no currency, for calculations)
function toNumber(value) {
  if (value === null || value === undefined) return null;
  // first number in the string; the "." in "Rs." must not be treated as a decimal point
  const m = String(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  const n = m ? parseFloat(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 5399 → "₹5,399"   (same string style as the other stores, e.g. "₹31,524")
function formatInr(n) {
  if (!n) return null;
  const hasPaise = Math.round(n * 100) % 100 !== 0;
  return '₹' + n.toLocaleString('en-IN', hasPaise
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumFractionDigits: 0 });
}

// Shopify language prefix: /hi/collections/... → /collections/...
function stripLocale(url) {
  return url ? url.replace(/^(https?:\/\/[^/]+)\/[a-z]{2}(?:-[A-Za-z]{2,4})?\/(?=(?:collections|products|pages)\/)/, '$1/') : url;
}

function absoluteUrl(href) {
  if (!href) return null;
  href = href.trim();
  let abs = null;
  if (/^https?:\/\//i.test(href)) abs = href;
  else if (href.startsWith('//'))  abs = 'https:' + href;
  else if (href.startsWith('/'))   abs = BASE + href;
  return abs ? stripLocale(abs.split('#')[0]) : null;
}

function stripQuery(url) {
  return url ? url.split('?')[0] : url;
}

function cleanSku(value) {
  const sku = cleanText(value);
  if (!sku) return null;
  if (/^(n\/?a|none|null|undefined|-|--|not available)$/i.test(sku)) return null;
  return sku;
}

// "UGREEN PB561 (25208)" → "25208"  (value in brackets wins)
// "UGREEN 95521" → "95521"   (drop the leading brand word, keep the rest)
// "95521"        → "95521"
// "UGREEN PB561 25208" → "PB561 25208"  (only a letters-only first word is dropped)
function modelToSku(model) {
  const m = cleanText(model);
  if (!m) return null;
  const inBrackets = m.match(/\(([^)]+)\)/);          // "UGREEN PB561 (25208)" → "25208"
  if (inBrackets) return cleanSku(inBrackets[1]);
  const parts = m.split(' ');
  if (parts.length > 1 && /^[A-Za-z]+$/.test(parts[0])) parts.shift();
  return cleanSku(parts.join(' '));
}

function normalizeStockText(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/out[\s_-]*of[\s_-]*stock|sold[\s_-]*out|unavailable|notify me|currently not available/.test(t)) return 'Out of Stock';
  if (/in[\s_-]*stock|add to cart|pre[\s_-]*order|back[\s_-]*order|available/.test(t)) return 'In Stock';
  return null;
}

// ── JSON-LD (server-rendered, most reliable) ─────────────────
function readJsonLdProduct($) {
  const found = { name: null, sku: null, category: null, brand: null, price: null, availabilities: [] };

  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).contents().text()); } catch (_) { return; }

    const walk = (node) => {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== 'object') return;

      const type = [].concat(node['@type'] || []).join(',');
      if (/Product/i.test(type)) {
        found.name     = found.name     || node.name     || null;
        found.sku      = found.sku      || node.sku      || null;
        found.category = found.category || node.category || null;
        found.brand    = found.brand    || (node.brand && (node.brand.name || node.brand)) || null;

        [].concat(node.offers || []).forEach((offer) => {
          if (!offer || typeof offer !== 'object') return;
          const subOffers = offer.offers ? [].concat(offer.offers) : [offer]; // AggregateOffer
          subOffers.forEach((o) => {
            if (o.availability) found.availabilities.push(String(o.availability));
            if (found.price === null && o.price !== undefined) found.price = String(o.price);
          });
        });
      }
      Object.values(node).forEach(walk);
    };
    walk(data);
  });

  return found;
}

function stockFromJsonLd(availabilities) {
  const mapped = availabilities.map((a) =>
    normalizeStockText(a.replace(/^https?:\/\/schema\.org\//i, '').replace(/([a-z])([A-Z])/g, '$1 $2'))
  );
  // multi-variant: in stock if ANY variant is purchasable
  if (mapped.includes('In Stock'))     return 'In Stock';
  if (mapped.includes('Out of Stock')) return 'Out of Stock';
  return null;
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT LINKS
// ─────────────────────────────────────────────────────────────
function parseProductLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  $('product-card a[href*="/products/"]').each((_, el) => {
    const abs = absoluteUrl($(el).attr('href'));
    if (abs) links.add(stripQuery(abs));
  });

  return [...links];
}

// ─────────────────────────────────────────────────────────────
//  NEXT PAGE
// ─────────────────────────────────────────────────────────────
function pageNumberOf(url) {
  const m = String(url || '').match(/[?&]page=(\d+)/);
  return m ? parseInt(m[1], 10) : 1;
}

function getNextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);

  // 1) explicit "next" markers
  const explicit =
    $('link[rel="next"]').attr('href') ||
    $('nav[aria-label="Pagination"] a[rel="next"]').attr('href') ||
    $('a[rel="next"]').attr('href') ||
    $('nav[aria-label="Pagination"] a[aria-label*="ext" i]').attr('href') ||
    $('.pagination a.pagination__next, .pagination__next a').attr('href');
  if (explicit) {
    const abs = absoluteUrl(explicit);
    if (abs && abs !== currentUrl) return abs;
  }

  // 2) numbered links → pick page = current + 1
  const want = pageNumberOf(currentUrl) + 1;
  let numbered = null;
  $('nav[aria-label="Pagination"] a[href], .pagination a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (pageNumberOf(href) === want && /[?&]page=/.test(href)) {
      numbered = absoluteUrl(href);
      return false;
    }
  });

  return numbered || null;
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT DETAILS
// ─────────────────────────────────────────────────────────────
function parseProductDetails(html, url) {
  const $ = cheerio.load(html);
  const getText = (selector) => cleanText($(selector).first().text());
  const ld = readJsonLdProduct($);

  // ── Name ──────────────────────────────────────────────────
  const name =
    getText('h1.product-title') ||
    getText('.product-info h1') ||
    cleanText(ld.name) ||
    cleanText($('meta[property="og:title"]').attr('content'));

  // ── Prices (scoped to the main price block) ───────────────
  const priceRoot = $('.product-info__price .price').first();
  let salePrice     = toNumber(priceRoot.find('.price__current .js-value').first().text());
  let originalPrice = toNumber(priceRoot.find('.price__was .js-value').first().text());

  if (!salePrice && ld.price) salePrice = toNumber(ld.price);   // JSON-LD fallback
  if (originalPrice && originalPrice <= (salePrice || 0)) originalPrice = null;

  // computed (the on-page badge text is localised, e.g. "19 % छूट")
  const discountBadge = salePrice && originalPrice
    ? `${Math.round(((originalPrice - salePrice) / originalPrice) * 100)}% off`
    : null;

  // ── SKU (priority: page SKU → JSON-LD → Model row) ────────
  let sku = null;
  let skuSource = null;

  const pageSku = cleanSku($('.product-sku__value').first().text());
  if (pageSku) { sku = pageSku; skuSource = 'sku'; }

  if (!sku) {
    const ldSku = cleanSku(ld.sku);
    if (ldSku) { sku = ldSku; skuSource = 'jsonld'; }
  }

  // "Model" spec row, e.g. "UGREEN 95521". Regex on raw HTML as well, because the
  // description tab is built from a <template> that DOM selectors may not reach.
  let rawModel = null;
  $('.ugd-tbl tr, .shop_attributes tr').each((_, row) => {
    if (/^model/i.test(cleanText($(row).find('th').text()) || '')) {
      rawModel = cleanText($(row).find('td').text());
      return false;
    }
  });
  if (!rawModel) {
    const m = html.match(/<th>\s*Model(?:\s*Number)?\s*<\/th>\s*<td>([^<]+)<\/td>/i);
    if (m) rawModel = cleanText(m[1]);
  }

  if (!sku) {
    const fromModel = modelToSku(rawModel);
    if (fromModel) { sku = fromModel; skuSource = 'model'; }
  }

  // ── Stock ─────────────────────────────────────────────────
  let stockStatus = stockFromJsonLd(ld.availabilities);

  if (!stockStatus) {
    const btn = $('form.js-product-form-main button[name="add"], product-form button[name="add"]').first();
    if (btn.length) {
      if (btn.is('[disabled]')) stockStatus = 'Out of Stock';
      else stockStatus = normalizeStockText(btn.text());
    }
  }

  if (!stockStatus) {
    if ($('.product-info .product-label--sold-out').length || $('#BIS_trigger').length) {
      stockStatus = 'Out of Stock';
    }
  }

  // ── Brand / Category ──────────────────────────────────────
  const brand = getText('.product-vendor a') || getText('.product-vendor') || cleanText(ld.brand) || null;

  const crumbs = [];
  $('.breadcrumbs-list li').each((_, li) => {
    const a = $(li).find('a').first();
    if (!a.length || a.attr('aria-current') === 'page') return;
    const t = cleanText(a.text());
    if (t && !/^home$/i.test(t)) crumbs.push(t);
  });
  const isAscii = (t) => !!t && /^[\x20-\x7E]+$/.test(t);          // never store localised (Hindi) text
  const crumbCat = crumbs.length ? crumbs[crumbs.length - 1] : null;
  const category = isAscii(crumbCat) ? crumbCat : (isAscii(cleanText(ld.category)) ? cleanText(ld.category) : null);

  // ── Short description (tagline) ───────────────────────────
  const shortDescription = getText('.product-info__tagline') || null;

  // ── Images ────────────────────────────────────────────────
  const images = [];
  $('.media-viewer__item img.product-image').each((_, el) => {
    const src = absoluteUrl($(el).attr('src') || $(el).attr('data-src'));
    if (src) {
      const clean = src.replace(/([?&])width=\d+&?/, '$1').replace(/[?&]$/, '');
      if (!images.includes(clean)) images.push(clean);
    }
  });

  // ── Specs ─────────────────────────────────────────────────
  const specs = {};
  $('.product-spec__item').each((_, li) => {
    const k = cleanText($(li).find('.product-spec__label').text());
    const v = cleanText($(li).find('.product-spec__value').text());
    if (k && v) specs[k] = v;
  });
  $('.ugd-tbl tbody tr').each((_, row) => {
    const k = cleanText($(row).find('th').text());
    const v = cleanText($(row).find('td').text());
    if (k && v && !(k in specs)) specs[k] = v;
  });

  return {
    url: stripLocale(url),
    store: STORE,

    name,

    sku,
    skuSource,
    model      : sku,
    modelNumber: sku,
    productCode: sku,
    rawModel,

    brand,
    category,
    stockStatus,

    salePrice     : formatInr(salePrice),      // "₹5,399"  (string, like the other stores)
    originalPrice : formatInr(originalPrice),  // "₹6,669"  (null when not discounted)
    discountBadge,                              // "19% off" (null when not discounted)

    shortDescription,
    images,
    specs,

    scrapedAt : new Date().toISOString(),
    scrapedVia: 'web_unlocker',
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };