// src/parsers/elitehubs.js
// ─────────────────────────────────────────────────────────────
// EliteHubs (elitehubs.com) — Shopify store, Ultimate Search & Filter
// (usf-*) collection grid with a "Load more" button.
//
// Same 3-export contract as every other parser:
//   parseProductLinks(html)           → string[]
//   getNextPageUrl(html, currentUrl)  → string | null
//   parseProductDetails(html, url)    → object
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

const BASE = 'https://elitehubs.com';

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim() || null;
}

function absoluteUrl(href) {
  if (!href) return null;
  href = href.trim();
  if (href.startsWith('http')) return href;
  if (href.startsWith('//'))   return 'https:' + href;
  if (href.startsWith('/'))    return BASE + href;
  return null;
}

/*
|--------------------------------------------------------------------------
| CATEGORY
|--------------------------------------------------------------------------
| Same approach as vishal.js: derive from the collection slug in the URL,
| e.g. ".../collections/graphic-cards/products/..." -> "Graphic Cards".
| Falls back to the breadcrumb, then null (the scheduler stamps
| storeSlug at scrape time anyway, so Category is only informational).
*/
function categoryFromUrl(url) {
  if (!url) return null;
  const match = url.match(/\/collections\/([^/?#]+)\/products\//i);
  if (!match) return null;
  return match[1]
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/*
|--------------------------------------------------------------------------
| LISTING  (Shopify products.json  +  HTML fallback)
|--------------------------------------------------------------------------
| WHY JSON: elitehubs.com/collections/graphic-cards renders its product
| grid with JavaScript (usf-* "Load more"), so the HTML that Web Unlocker
| returns has an EMPTY #product-grid  ->  "0 links found".
|
| Every Shopify collection also serves its products as JSON:
|     https://elitehubs.com/collections/graphic-cards/products.json?limit=250
| (page=2,3,... for more). That is plain server data, no JS needed.
| Set that as the category url in urls.js. The product *pages* are still
| scraped as HTML by parseProductDetails() below (model number lives in the
| spec table, which products.json does not contain).
|
| If the url is the normal HTML collection page instead, we fall back to
| reading <a href="/products/..."> anchors.
*/
function tryParseListingJson(body) {
  if (typeof body !== 'string') return null;
  const t = body.trim();
  if (!t.startsWith('{')) return null;
  try {
    const data = JSON.parse(t);
    return Array.isArray(data.products) ? data : null;
  } catch (_) {
    return null;
  }
}

function parseProductLinks(html) {
  // ── JSON listing ──
  const json = tryParseListingJson(html);
  if (json) {
    return json.products
      .filter(p => p && p.handle)
      .map(p => `${BASE}/products/${p.handle}`);
  }

  // ── HTML listing ──
  const $ = cheerio.load(html);
  $('header, footer, nav, .site-header, .site-footer, .mobile-bottom-nav').remove();

  const collect = (scope) => {
    const out = new Set();
    scope.find('a[href*="/products/"]').each((_, el) => {
      const href = absoluteUrl($(el).attr('href'));
      if (href && href.includes('/products/')) out.add(href.split('?')[0].split('#')[0]);
    });
    return [...out];
  };

  // #product-grid exists but is empty before JS runs, so don't trust it blindly
  let links = collect($('#product-grid, .usf-results'));
  if (links.length === 0) links = collect($('body'));

  if (links.length === 0) {
    const preview = String(html || '').replace(/\s+/g, ' ').slice(0, 160);
    console.log(`  ⚠️  elitehubs: 0 links. Response length=${(html || '').length}. Start: "${preview}"`);
    console.log('      Use the products.json URL in urls.js (see elitehubs.js header).');
  }
  return links;
}

/*
|--------------------------------------------------------------------------
| PAGINATION
|--------------------------------------------------------------------------
| JSON mode : ?page=N+1 while the current page was "full" (>= limit items).
|             A short page is the last page, so we never request an empty
|             one (a tiny {"products":[]} reply would be rejected by
|             fetchPage's <500 byte guard and just burn 3 retries).
| HTML mode : ?page=N+1 until a page has no links / repeats.
|
| Duplicate-page fingerprints are tracked per listing base URL and reset on
| page 1, so a second scrape in the same server process isn't cut short.
*/
const seenFingerprints = new Map(); // baseUrl -> Set<fingerprint>

function getNextPageUrl(html, currentUrl) {
  const current = new URL(currentUrl);
  const currentPage = parseInt(current.searchParams.get('page') || '1', 10);

  const base = new URL(currentUrl);
  base.searchParams.delete('page');
  const baseKey = base.toString();

  if (currentPage <= 1 || !seenFingerprints.has(baseKey)) {
    seenFingerprints.set(baseKey, new Set());
  }
  const seen = seenFingerprints.get(baseKey);

  const links = parseProductLinks(html);

  if (links.length === 0) {
    seenFingerprints.delete(baseKey);
    return null;
  }

  // JSON listing: last page = fewer items than the requested limit
  if (tryParseListingJson(html)) {
    const limit = parseInt(current.searchParams.get('limit') || '30', 10); // Shopify default 30
    if (links.length < limit) {
      seenFingerprints.delete(baseKey);
      return null;
    }
  }

  const fingerprint = [...links].sort().join('|');
  if (seen.has(fingerprint)) {
    console.log('  🛑 Duplicate page detected — stopping pagination');
    seenFingerprints.delete(baseKey);
    return null;
  }
  seen.add(fingerprint);

  const next = new URL(currentUrl);
  next.searchParams.set('page', String(currentPage + 1));
  return next.toString();
}

/*
|--------------------------------------------------------------------------
| HELPERS FOR PRODUCT DETAILS
|--------------------------------------------------------------------------
*/

// JSON-LD Product block (Shopify themes usually emit one) — fallback source
function readJsonLdProduct($) {
  let found = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (found) return;
    try {
      const data = JSON.parse($(el).contents().text());
      const arr = Array.isArray(data) ? data : [data];
      for (const d of arr) {
        const items = d['@graph'] ? d['@graph'] : [d];
        for (const it of items) {
          if (it && /product/i.test(String(it['@type']))) { found = it; return; }
        }
      }
    } catch (_) { /* ignore bad JSON-LD */ }
  });
  return found;
}

function formatInr(n) {
  const num = Number(n);
  if (!isFinite(num) || num <= 0) return null;
  return `Rs. ${num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/*
|--------------------------------------------------------------------------
| STOCK
|--------------------------------------------------------------------------
| EliteHubs shows several signals. Priority (first decisive one wins):
|
|  1. schema.org availability (<link itemprop="availability"> or JSON-LD)
|     — server-rendered, most reliable.
|  2. <div class="out_stock"> / "OUT OF STOCK" add-to-cart button.
|  3. Availability row: BOTH <span id="js-pr-available"> and
|     <span id="js-pr-unavailable"> always exist in the DOM; the hidden
|     one carries class "d-none". So we must check d-none — reading
|     "the span after the label" (as vishal.js does) would always return
|     "In Stock".
|  4. "Hurry Up! Only N Left in Stock!" widget => In Stock.
|
| If nothing decisive is found we return 'Out of Stock' (conservative:
| a false "In Stock" competitor skews price recommendations and alerts).
*/
function detectStock($, ld) {
  // 1a. microdata
  const href = $('link[itemprop="availability"]').attr('href') || '';
  if (/OutOfStock|SoldOut|Discontinued/i.test(href)) return 'Out of Stock';
  if (/InStock|PreOrder|LimitedAvailability/i.test(href)) return 'In Stock';

  // 1b. JSON-LD
  if (ld && ld.offers) {
    const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
    const av = String(offer && offer.availability || '');
    if (/OutOfStock|SoldOut|Discontinued/i.test(av)) return 'Out of Stock';
    if (/InStock|PreOrder|LimitedAvailability/i.test(av)) return 'In Stock';
  }

  // 2. explicit OOS markup
  if ($('.out_stock').length) return 'Out of Stock';
  const btnText = cleanText($('form[action*="/cart/add"] button, .product_infor button, .group-button button').text()) || '';
  if (/out of stock|sold out/i.test(btnText) && !/add to cart/i.test(btnText)) return 'Out of Stock';

  // 3. Availability row with d-none toggling
  const avail   = $('#js-pr-available');
  const unavail = $('#js-pr-unavailable');
  if (avail.length && unavail.length) {
    const availHidden   = avail.hasClass('d-none');
    const unavailHidden = unavail.hasClass('d-none');
    if (availHidden && !unavailHidden) return 'Out of Stock';
    if (!availHidden && unavailHidden) return 'In Stock';
  }

  // 4. "Only N left" widget
  if (/left in stock/i.test($('.inventory_qty').text())) return 'In Stock';

  return 'Out of Stock';
}

/*
|--------------------------------------------------------------------------
| PRODUCT DETAILS
|--------------------------------------------------------------------------
*/
function parseProductDetails(html, url) {
  const $ = cheerio.load(html);
  const ld = readJsonLdProduct($);

  // NAME
  const name =
    cleanText($('h1.product-name').first().text()) ||
    cleanText($('h1').first().text()) ||
    (ld && cleanText(ld.name)) ||
    null;

  // PRICES  — "Rs. 41,095.00" (sale) and struck-through "Rs. 59,999.00"
  let salePrice =
    cleanText($('#js-product-price').first().text()) ||
    cleanText($('.product-price .price--sale .current').first().text()) ||
    cleanText($('.price--sale .current').first().text()) ||
    cleanText($('.product-price .price--sale').first().text()) ||
    null;

  if (!salePrice && ld && ld.offers) {
    const offer = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
    salePrice = formatInr(offer && (offer.price || offer.lowPrice));
  }
  if (!salePrice) {
    salePrice = formatInr($('meta[property="product:price:amount"]').attr('content'));
  }

  const toNum = (v) => parseFloat(String(v || '').replace(/[^0-9.]/g, '')) || 0;
  let originalPrice = cleanText($('.product-price .price--sale .compare').first().text()) || null;
  if (originalPrice && toNum(originalPrice) <= toNum(salePrice)) originalPrice = null;

  const discountBadge =
    cleanText($('.product-price .discount, .price-discount, .label-discount').first().text()) ||
    null;

  // STOCK
  const stockStatus = detectStock($, ld);

  // "Hurry Up! Only 5 Left in Stock!" -> 5
  let stockQuantity = null;
  const qtyMatch = ($('.inventory_qty').text() || '').match(/only\s+(\d+)\s+left/i);
  if (qtyMatch) stockQuantity = parseInt(qtyMatch[1], 10);
  if (stockStatus === 'Out of Stock') stockQuantity = 0;

  // SPECS — every table row on the page: <tr><td>MODEL</td><td>GV-...</td></tr>
  // (the spec table sits in #tab_des > .description, but we don't depend on
  // that wrapper so a theme/markup change can't silently lose the model).
  const specs = {};
  $('table tr').each((_, row) => {
    const tds = $(row).children('td, th');
    if (tds.length < 2) return;
    const key = cleanText(tds.eq(0).text());
    const val = cleanText(tds.eq(1).text());
    if (key && val && !(key in specs)) specs[key] = val;
  });

  // MODEL NUMBER — manufacturer part number, e.g. GV-N3050WF2OCV2-8GD.
  // Normalise keys ("Model :", "MODEL NO.", "Model Number") and look them up
  // in priority order.
  const normKey = (k) => k.toLowerCase().replace(/[\u00a0:：#.]/g, ' ').replace(/\s+/g, ' ').trim();
  const specByNorm = {};
  for (const [k, v] of Object.entries(specs)) {
    const nk = normKey(k);
    if (!(nk in specByNorm)) specByNorm[nk] = v;
  }
  // ONLY the spec row literally named MODEL (or MODEL NO / MODEL NUMBER).
  // Deliberately NOT "MODEL NAME" — that is a descriptive product name
  // (e.g. "GeForce RTX 4070 SUPER 12G GAMING X SLIM"), not a model number.
  const MODEL_KEYS = ['model', 'model no', 'model number'];
  let modelNumber = null;
  for (const key of MODEL_KEYS) {
    if (specByNorm[key]) { modelNumber = specByNorm[key]; break; }
  }

  if (!modelNumber) {
    console.log(`  ⚠️  elitehubs: no MODEL found for ${url} (spec keys: ${Object.keys(specs).slice(0, 8).join(' | ') || 'none'})`);
  }

  // SKU is intentionally left empty for EliteHubs: the site only exposes a
  // URL-slug style value there (e.g. "gigabyte-rtx-3050-v2-8gb"), which would
  // pollute SKU matching. Matching uses modelNumber (spec table MODEL) instead.
  const sku = null;

  // BRAND
  let brand = null;
  if (ld && ld.brand) brand = cleanText(typeof ld.brand === 'string' ? ld.brand : ld.brand.name);
  if (!brand && name) {
    const KNOWN = ['GIGABYTE', 'MSI', 'ASUS', 'ASROCK', 'ZOTAC', 'PALIT', 'INNO3D', 'GALAX',
                   'SAPPHIRE', 'POWERCOLOR', 'XFX', 'PNY', 'COLORFUL', 'EVGA', 'NVIDIA', 'AMD',
                   'INTEL', 'CORSAIR', 'CRUCIAL', 'KINGSTON', 'SAMSUNG', 'WD', 'SEAGATE',
                   'ADATA', 'LG', 'DELL', 'HP', 'LENOVO', 'ACER', 'BENQ', 'COOLER MASTER',
                   'DEEPCOOL', 'NZXT', 'ANTEC', 'LIAN LI', 'THERMALTAKE'];
    const up = name.toUpperCase();
    const hit = KNOWN.find(b => up.startsWith(b + ' ') || up.includes(' ' + b + ' '));
    if (hit) brand = hit.charAt(0) + hit.slice(1).toLowerCase();
  }

  // CATEGORY
  let category = categoryFromUrl(url);
  if (!category) {
    const crumbs = [];
    $('.breadcrumb a, nav.breadcrumb a, .breadcrumbs a').each((_, el) => {
      const t = cleanText($(el).text());
      if (t && t.toLowerCase() !== 'home') crumbs.push(t);
    });
    category = crumbs[crumbs.length - 1] || null;
  }

  const shortDescription =
    cleanText($('meta[name="description"]').attr('content')) || null;

  const images = new Set();
  $('img').each((_, el) => {
    let src = $(el).attr('src') || $(el).attr('data-src');
    if (!src) return;
    if (src.startsWith('//')) src = 'https:' + src;
    if (src.includes('/cdn/shop/') && src.includes('/products/')) images.add(src.split('?')[0]);
  });

  return {
    url,
    store: 'elitehubs',

    name,

    // matcher reads modelNumber first, then sku (see STORE_SKU_FIELDS)
    modelNumber,
    model: modelNumber,
    sku,

    brand,
    category,
    stockStatus,
    stockQuantity,

    salePrice,
    originalPrice,
    discountBadge,

    shortDescription,
    tags: [],
    images: [...images].slice(0, 10),
    specs,

    scrapedAt : new Date().toISOString(),
    scrapedVia: 'web_unlocker',
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };