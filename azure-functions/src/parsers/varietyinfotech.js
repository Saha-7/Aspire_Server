// src/parsers/varietyinfotech.js
// ─────────────────────────────────────────────────────────────
// Variety Infotech — WooCommerce + WoodMart theme (Elementor page
// builder), same theme family as fgtech.js. Web Unlocker / cheerio
// version — synchronous, receives HTML string.
//
// NOTES:
// - The visible "Show more products" button is a WoodMart "FiboFilters"
//   AJAX widget, NOT core WooCommerce AJAX — but verified via a live
//   fetch that classic WooCommerce pagination is ALSO rendered on the
//   page regardless (standard /page/2/, /page/3/, … links, same as
//   fgtech.js), because the site shows "Showing 1–12 of N results"
//   (core WooCommerce's own loop, paginated server-side). So, same
//   pagination selector as fgtech.js — the FiboFilters button can be
//   ignored entirely.
// - Product pages carry Open Graph Product meta tags in <head>
//   (confirmed via live fetch):
//     <meta property="product:brand" content="AMD">
//     <meta property="product:availability" content="instock">
//     <meta property="product:retailer_item_id" content="100-...">
//   These are a much more reliable source for brand/SKU/stock than
//   scraping the WoodMart Elementor widgets, because they describe
//   ONLY the main product (head-level, not page-body) — they can't
//   accidentally pick up a related/upsell product's data the way an
//   unscoped DOM selector could. Confirmed via a live out-of-stock
//   product fetch that `product:availability` is OMITTED ENTIRELY
//   (not set to "outofstock") when the item isn't in stock, so its
//   absence is handled as "check the DOM instead", not as In Stock.
// - "Sold out" / "-NN%" ribbons (span.out-of-stock.product-label /
//   span.onsale.product-label) appear ONLY on out-of-stock products —
//   there's no equivalent "In Stock" ribbon, confirmed on a live
//   in-stock product page (the ribbon container simply isn't there at
//   all). So presence of `.out-of-stock` is a clean OOS signal, used
//   here as the DOM fallback for when the meta tag is missing.
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

const BASE = 'https://varietyinfotech.com';

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim() || null;
}

function absoluteUrl(href) {
  if (!href) return null;
  href = href.trim();
  if (href.startsWith('http')) return href.split('?')[0];
  if (href.startsWith('//'))   return ('https:' + href).split('?')[0];
  if (href.startsWith('/'))    return (BASE + href).split('?')[0];
  return null;
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT LINKS
//  Scoped to the WoodMart product grid, same pattern/defensive
//  sidebar-widget stripping as fgtech.js — cheap insurance even
//  though no sidebar pollution has been confirmed on this site yet.
// ─────────────────────────────────────────────────────────────
function parseProductLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  $('.sidebar-widget, .widget-area, .widget_top_rated_products, .widget_products, .related.products, .upsells.products').remove();

  const gridSelectors = ['div.products', 'ul.products', '.woocommerce ul.products'];

  let scope = null;
  for (const sel of gridSelectors) {
    if ($(sel).length) { scope = sel; break; }
  }

  if (!scope) return [];

  $(scope).find('a[href]').each((_, el) => {
    const href = absoluteUrl($(el).attr('href'));
    if (href && href.includes('/product/') && !href.includes('/product-category/')) {
      links.add(href);
    }
  });

  return [...links];
}

// ─────────────────────────────────────────────────────────────
//  PAGINATION
//  Standard WooCommerce pagination (confirmed live: /page/2/, /page/3/
//  … links are server-rendered regardless of the FiboFilters AJAX
//  button) — identical selector to fgtech.js.
// ─────────────────────────────────────────────────────────────
function getNextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);

  const next = $('nav.woocommerce-pagination a.next.page-numbers').attr('href') ||
               $('a.next.page-numbers').attr('href');

  if (!next) return null;

  const nextUrl = absoluteUrl(next) || next;
  if (nextUrl === currentUrl) return null;

  return nextUrl;
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT DETAILS
// ─────────────────────────────────────────────────────────────
function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  const metaContent = (prop) =>
    cleanText($(`meta[property="${prop}"]`).attr('content')) ||
    cleanText($(`meta[name="${prop}"]`).attr('content'));

  // ── Name ────────────────────────────────────────────────────
  const name =
    cleanText($('.product_title').first().text()) ||
    cleanText($('h1').first().text()) ||
    null;

  // ── SKU ─────────────────────────────────────────────────────
  // product:retailer_item_id matches the on-page "SKU: ..." exactly
  // (confirmed on two live products) — used as primary since it's
  // head-level and can't be polluted by a related product's SKU.
  const sku =
    metaContent('product:retailer_item_id') ||
    cleanText($('.product_meta .sku').first().text()) ||
    cleanText($('.sku').first().text()) ||
    null;

  // ── Brand ───────────────────────────────────────────────────
  const brand =
    metaContent('product:brand') ||
    (() => {
      let b = null;
      $('.product_meta .posted_in').each((_, el) => {
        const label = cleanText($(el).find('.meta-label').first().text()) || '';
        if (/brand/i.test(label)) b = cleanText($(el).find('a').first().text());
      });
      return b;
    })() ||
    cleanText($('a[href*="/brand/"] img').attr('alt')) ||
    null;

  // ── Prices ──────────────────────────────────────────────────
  const salePrice =
    cleanText($('p.price ins .woocommerce-Price-amount').first().text()) ||
    cleanText($('p.price .woocommerce-Price-amount').first().text()) ||
    (metaContent('product:price:amount') ? `₹${metaContent('product:price:amount')}` : null);

  const originalPrice =
    cleanText($('p.price del .woocommerce-Price-amount').first().text()) ||
    null;

  const discountBadge = cleanText($('.onsale').first().text()) || null;

  // ── Stock ───────────────────────────────────────────────────
  const metaAvailability = metaContent('product:availability');
  let stockStatus;
  if (metaAvailability) {
    stockStatus = /instock/i.test(metaAvailability) ? 'In Stock' : 'Out of Stock';
  } else {
    // Meta tag is omitted entirely (not set to "outofstock") when the
    // item isn't in stock — confirmed via a live out-of-stock fetch —
    // so fall back to the DOM, scoped to the main buy-box (.summary)
    // so a related/upsell product's own "Sold out" label can't leak in.
    const summary = $('.summary').first().length ? $('.summary').first() : $('body');
    const hasOosLabel = summary.find('.out-of-stock').length > 0;
    const stockText = cleanText(summary.find('.stock').first().text()) || '';
    stockStatus = (hasOosLabel || /out of stock|sold out/i.test(stockText))
      ? 'Out of Stock'
      : 'In Stock';
  }

  // ── Category (breadcrumb) ────────────────────────────────────
  // Breadcrumb: Home / Processor / AMD Processor / Ryzen 9 Series / <name>
  // (the bottom-of-page "Categories:" list is NOT in hierarchy order on
  // this theme — confirmed it reorders alphabetically-ish across two
  // live products — so use the breadcrumb, not that list.)
  const breadcrumbLinks = [];
  $('.woocommerce-breadcrumb a, nav.woocommerce-breadcrumb a').each((_, el) => {
    const text = cleanText($(el).text());
    if (text && text.toLowerCase() !== 'home') breadcrumbLinks.push(text);
  });
  const category = breadcrumbLinks[breadcrumbLinks.length - 1] || null;

  // ── Specs ───────────────────────────────────────────────────
  // Standard WooCommerce "Additional information" attributes table —
  // confirmed live (th/td pairs: Weight, Brand, Socket, Tdp, etc.).
  const specs = {};
  $('.woocommerce-product-attributes tr, table.shop_attributes tr').each((_, row) => {
    const key   = cleanText($(row).find('th').first().text());
    const value = cleanText($(row).find('td').first().text());
    if (key && value) specs[key] = value;
  });

  // ── Short description / tags ──────────────────────────────────
  const shortDescription =
    cleanText($('.woocommerce-product-details__short-description').first().text()) ||
    null;

  const tags = [];
  $('.tagged_as a').each((_, el) => {
    const tag = cleanText($(el).text());
    if (tag) tags.push(tag);
  });

  return {
    url,
    store: 'varietyinfotech',

    name,

    sku,
    model      : sku,
    modelNumber: sku,
    productCode: sku,

    brand,
    category,
    stockStatus,

    salePrice,
    originalPrice,
    discountBadge,

    shortDescription,
    tags,
    specs,

    scrapedAt : new Date().toISOString(),
    scrapedVia: 'web_unlocker',
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };