// src/parsers/amazon.js
// ─────────────────────────────────────────────────────────────
// Amazon.in parser — same 3-export interface as the other stores:
//   parseProductLinks(html)           → string[]
//   getNextPageUrl(html, currentUrl)  → string | null
//   parseProductDetails(html, url)    → object
//
// NOTE: selectors are written from Amazon.in's known markup and have
// NOT yet been verified against a live product page from your zone.
// Run src/test-amazon-product.js first and check the output.
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

const BASE = 'https://www.amazon.in';
const MAX_PAGES = 7;            // Amazon stops serving results after ~7 pages
const SKIP_SPONSORED = true;    // sponsored cards can be off-category

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim() || null;
}

// The ASIN is the only stable identifier. Everything else in an Amazon
// URL (ref_, pf_rd_*, keywords, sprefix, slug text) is tracking noise.
function extractAsin(href) {
  if (!href) return null;
  const m = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

function canonicalUrl(asin) {
  return `${BASE}/dp/${asin}`;
}

function isBlockedPage(html) {
  return /api-services-support@amazon|Type the characters you see|Robot Check|Enter the characters you see/i.test(html);
}

/*
|--------------------------------------------------------------------------
| PRODUCT LINKS (listing page)
|--------------------------------------------------------------------------
*/
function parseProductLinks(html) {
  if (isBlockedPage(html)) return [];
  const $ = cheerio.load(html);
  const links = new Set();

  $('div[data-component-type="s-search-result"]').each((_, el) => {
    const $el = $(el);
    const asin = ($el.attr('data-asin') || '').trim();
    if (!/^[A-Z0-9]{10}$/i.test(asin)) return;

    if (SKIP_SPONSORED) {
      const sponsored = $el.find('.puis-sponsored-label-text, [aria-label="Sponsored"], .s-sponsored-label-text').length > 0;
      if (sponsored) return;
    }
    links.add(canonicalUrl(asin.toUpperCase()));
  });

  return [...links];
}

/*
|--------------------------------------------------------------------------
| PAGINATION
|--------------------------------------------------------------------------
*/
const seenPageFingerprints = new Set();

function getNextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);

  const fingerprint = parseProductLinks(html).sort().join('|');
  if (fingerprint && seenPageFingerprints.has(fingerprint)) {
    console.log('  🛑 Duplicate page detected — stopping pagination');
    return null;
  }
  if (fingerprint) seenPageFingerprints.add(fingerprint);

  let currentPage = 1;
  try {
    currentPage = parseInt(new URL(currentUrl).searchParams.get('page') || '1', 10);
  } catch (_) { /* ignore */ }
  if (currentPage >= MAX_PAGES) return null;

  const next = $('a.s-pagination-next:not(.s-pagination-disabled)').first();
  const href = next.attr('href');
  if (!href) return null;

  const abs = href.startsWith('http') ? href : BASE + href;
  return abs;
}

/*
|--------------------------------------------------------------------------
| PRODUCT DETAILS
|--------------------------------------------------------------------------
*/

// Amazon spreads specs over several different table/list layouts.
function collectSpecs($) {
  const specs = {};

  const add = (k, v) => {
    // strip the invisible unicode marks Amazon puts around labels
    const key = cleanText((k || '').replace(/[\u200E\u200F:]/g, ''));
    const val = cleanText((v || '').replace(/[\u200E\u200F]/g, ''));
    if (key && val && !(key in specs)) specs[key] = val;
  };

  // Layout 1: tech spec / detail tables
  $('table.prodDetTable tr, #productDetails_techSpec_section_1 tr, #productDetails_techSpec_section_2 tr, #productDetails_detailBullets_sections1 tr, table#productDetails_db_sections tr')
    .each((_, row) => add($(row).find('th').first().text(), $(row).find('td').first().text()));

  // Layout 2: detail bullets list ("Item model number : XYZ")
  $('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li').each((_, li) => {
    const label = $(li).find('span.a-text-bold').first().text();
    const full = $(li).text();
    const value = full.replace(label, '');
    add(label, value);
  });

  // Layout 3: overview table at the top of the page
  $('#productOverview_feature_div tr').each((_, row) => {
    add($(row).find('td').eq(0).text(), $(row).find('td').eq(1).text());
  });

  // Layout 4: "Technical Details" table used by some categories
  $('#technicalSpecifications_section_1 tr').each((_, row) => {
    add($(row).find('th').first().text(), $(row).find('td').first().text());
  });

  return specs;
}

function pickSpec(specs, ...labels) {
  for (const label of labels) {
    const hit = Object.keys(specs).find(k => k.toLowerCase() === label.toLowerCase());
    if (hit) return specs[hit];
  }
  return null;
}

function parseProductDetails(html, url) {
  if (isBlockedPage(html)) return null;

  const $ = cheerio.load(html);
  const asin =
    extractAsin(url) ||
    cleanText($('input#ASIN').attr('value')) ||
    null;

  const name = cleanText($('#productTitle').first().text());
  if (!name) return null; // not a product page (404 / dog page / captcha)

  /*
  | PRICE — scoped to the main price block so we never pick up prices
  | from "frequently bought together" / sponsored carousels.
  */
  const PRICE_SCOPES = ['#corePriceDisplay_desktop_feature_div', '#corePrice_feature_div', '#apex_desktop'];

  const scopedText = (selectors) => {
    for (const scope of PRICE_SCOPES) {
      const root = $(scope).first();
      if (!root.length) continue;
      for (const sel of selectors) {
        const t = cleanText(root.find(sel).first().text());
        if (t) return t;
      }
    }
    return null;
  };

  const rupee = (text) => {
    const m = (text || '').match(/₹\s*[\d,]+(?:\.\d+)?/);
    return m ? m[0].replace(/\s+/g, '') : null;
  };
  const toNum = (v) => {
    const n = parseFloat(String(v || '').replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const salePrice = scopedText([
    '.priceToPay .a-offscreen',
    '.a-price:not(.a-text-price) .a-offscreen',
  ]);

  // MRP / original price. Amazon renders it as:
  //   <span class="basisPrice"> ... <span class="a-price a-text-price apex-basisprice-value">
  //      <span class="a-offscreen">₹2,999</span> ...
  // plus a screen-reader label "M.R.P.: ₹2,999.00".
  let originalPrice =
    scopedText([
      '.basisPrice .a-offscreen',
      '.apex-basisprice-value .a-offscreen',
      '.a-price.a-text-price[data-a-strike="true"] .a-offscreen',
    ]) ||
    cleanText($('.apex-basisprice-value .a-offscreen').first().text()) ||
    rupee($('.apex-basisprice-offscreen-label').first().text()) ||
    rupee($('.basisPrice').first().text());

  // sanity: an MRP lower than the selling price is a mis-scrape
  if (originalPrice && salePrice && toNum(originalPrice) < toNum(salePrice)) originalPrice = null;

  /*
  | STOCK — #availability also contains inline <script> JSON, which
  | polluted availabilityText before. Drop script/style first.
  */
  const availEl = $('#availability').first().clone();
  availEl.find('script, style').remove();
  const availabilityText = (
    cleanText(availEl.find('.primary-availability-message').first().text()) ||
    cleanText(availEl.text()) ||
    ''
  ).replace(/\{[\s\S]*\}/g, '').trim();

  const hasBuyButton = $('#add-to-cart-button, #buy-now-button').length > 0;
  const unavailable =
    /currently unavailable|out of stock|unavailable/i.test(availabilityText) ||
    $('#outOfStock').length > 0;

  let stockStatus;
  if (unavailable && !hasBuyButton) stockStatus = 'Out of Stock';
  else if (hasBuyButton || /in stock|only \d+ left|left in stock/i.test(availabilityText)) stockStatus = 'In Stock';
  else stockStatus = salePrice ? 'In Stock' : 'Out of Stock';

  const leftMatch = availabilityText.match(/only\s+(\d+)\s+left/i);
  const stockCount = leftMatch ? parseInt(leftMatch[1], 10) : null;

  /*
  | SPECS / MODEL NUMBER / BRAND
  */
  const specs = collectSpecs($);

  const modelNumber = pickSpec(specs, 'Model Number', 'Item model number', 'Model');
  const partNumber = pickSpec(specs, 'Manufacturer Part Number', 'Item part number', 'Part Number', 'Manufacturer Number');
  const listedSku = pickSpec(specs, 'SKU', 'Seller SKU');

  // Model number, part number and SKU mean the same thing for matching.
  // The ASIN is Amazon's own ID and is deliberately NOT used here.
  const sku = modelNumber || partNumber || listedSku || null;

  let brand = pickSpec(specs, 'Brand', 'Manufacturer');
  if (!brand) {
    const byline = cleanText($('#bylineInfo').first().text());
    if (byline) {
      brand = byline
        .replace(/^Visit the\s+/i, '')
        .replace(/\s+Store$/i, '')
        .replace(/^Brand:\s*/i, '');
    }
  }

  /*
  | CATEGORY — last breadcrumb item
  */
  const crumbs = $('#wayfinding-breadcrumbs_feature_div li a')
    .map((_, a) => cleanText($(a).text()))
    .get()
    .filter(Boolean);
  const category = crumbs.length ? crumbs[crumbs.length - 1] : null;

  /*
  | DESCRIPTION
  */
  const bullets = $('#feature-bullets li span.a-list-item')
    .map((_, el) => cleanText($(el).text()))
    .get()
    .filter(Boolean);

  const shortDescription =
    (bullets.length ? bullets.join(' | ') : null) ||
    cleanText($('#productDescription').first().text());

  /*
  | IMAGES
  */
  const images = new Set();
  const hires = $('#landingImage').attr('data-old-hires');
  if (hires) images.add(hires);
  const dyn = $('#landingImage').attr('data-a-dynamic-image');
  if (dyn) {
    try { Object.keys(JSON.parse(dyn)).forEach(u => images.add(u)); } catch (_) { /* ignore */ }
  }
  if (!images.size) {
    const src = $('#landingImage').attr('src');
    if (src) images.add(src);
  }

  /*
  | EXTRAS useful for price intelligence
  */
  const rating = cleanText($('#acrPopover').attr('title') || $('span[data-hook="rating-out-of-text"]').first().text());
  const reviewCount = cleanText($('#acrCustomerReviewText').first().text());
  const soldBy = cleanText($('#sellerProfileTriggerId').first().text()) ||
                 cleanText($('#merchant-info').first().text());

  return {
    url: asin ? canonicalUrl(asin) : url,
    store: 'amazon',
    name,
    asin,
    sku,                    // model number → part number → listed SKU (never the ASIN)
    modelNumber,
    partNumber,
    brand,
    category,
    stockStatus,
    availabilityText: availabilityText || null,
    stockCount,
    salePrice,
    originalPrice,
    shortDescription,
    rating,
    reviewCount,
    soldBy,
    tags: [],
    images: [...images],
    specs,
    scrapedAt: new Date().toISOString(),
    scrapedVia: 'web_unlocker',
  };
}

module.exports = {
  parseProductLinks,
  getNextPageUrl,
  parseProductDetails,
};