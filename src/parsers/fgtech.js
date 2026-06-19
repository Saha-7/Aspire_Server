// src/parsers/fgtech.js
// ─────────────────────────────────────────────────────────────
// FGTech Store — WooCommerce + WoodMart theme (Elementor page builder)
// Web Unlocker / cheerio version — synchronous, receives HTML string
//
// IMPORTANT: FGTech sells RAM *and* unrelated gear (IP cameras, network
// switches, routers, cables, NVRs) on the same site. An unscoped
// `a[href*="/product/"]` search anywhere on the page also picks up
// "related products" / sidebar / nav links to those unrelated items.
// parseProductLinks() MUST stay scoped to the product grid container
// (div.products) — do not widen this to `$('a[href]')` over the whole
// document again, or scrapes will return cameras/switches mixed in
// with RAM.
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

const BASE = 'https://fgtechstore.com';

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
//  Scoped strictly to the WoodMart product grid (div.products).
//  Verified against real category HTML: scoped = 18 RAM-only links,
//  unscoped = 38 links including IP cameras, switches, routers, cables.
// ─────────────────────────────────────────────────────────────
function parseProductLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  // Strip sidebar widgets BEFORE selecting the grid. FGTech's theme
  // renders a "Top Rated Products" widget (div.widget_top_rated_products,
  // inside .sidebar-widget / .widget-area) on every paginated category
  // page, containing the SAME ~10 unrelated products (IP cameras, network
  // switches, routers, cables) every time. Verified these widgets live in
  // a completely separate DOM subtree from div.products on this site, but
  // we strip them defensively first in case a future theme update nests
  // them differently.
  $('.sidebar-widget, .widget-area, .widget_top_rated_products, .widget_products, .related.products, .upsells.products').remove();

  const gridSelectors = [
    'div.products',
    'ul.products',
    '.woocommerce ul.products',
  ];

  let scope = null;
  for (const sel of gridSelectors) {
    if ($(sel).length) { scope = sel; break; }
  }

  if (!scope) {
    // No grid found at all — do NOT fall back to the whole page,
    // that's exactly what causes unrelated products to leak in.
    // Return empty so the caller retries fresh next run instead of
    // silently polluting the category with junk.
    return [];
  }

  const base = $(scope);

  base.find('a[href]').each((_, el) => {
    const raw  = $(el).attr('href') || '';
    const href = absoluteUrl(raw);
    if (href && href.includes('/product/') && !href.includes('/product-category/')) {
      links.add(href);
    }
  });

  return [...links];
}

// ─────────────────────────────────────────────────────────────
//  PAGINATION
//  Standard WooCommerce pagination:
//    <nav class="woocommerce-pagination">
//      <ul class="page-numbers">
//        <li><a class="next page-numbers" href="...page/2/">→</a></li>
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

  // ── Name ────────────────────────────────────────────────────
  const name =
    cleanText($('.product_title').first().text()) ||
    cleanText($('h1').first().text()) ||
    null;

  // ── Prices ──────────────────────────────────────────────────
  const salePrice =
    cleanText($('p.price ins .woocommerce-Price-amount').first().text()) ||
    cleanText($('p.price .woocommerce-Price-amount').first().text()) ||
    null;

  const originalPrice =
    cleanText($('p.price del .woocommerce-Price-amount').first().text()) ||
    null;

  const discountBadge =
    cleanText($('.onsale').first().text()) ||
    null;

  // ── SKU ─────────────────────────────────────────────────────
  // Lives inside .product_meta — only one instance per page.
  const sku =
    cleanText($('.product_meta .sku').first().text()) ||
    cleanText($('.sku').first().text()) ||
    null;

  // ── Stock ───────────────────────────────────────────────────
  // Related-product widgets on the same page also use a ".stock"
  // class, so we target the bordered main-product stock badge first.
  const stockText =
    cleanText($('.stock.wd-style-bordered').first().text()) ||
    cleanText($('.stock').first().text()) ||
    null;

  const stockStatus = stockText
    ? (/out of stock/i.test(stockText) ? 'Out of Stock' : 'In Stock')
    : null;

  // ── Brand ───────────────────────────────────────────────────
  // .product_meta has TWO ".posted_in" spans — Categories and Brand.
  // Distinguish by the meta-label text ("Brand:" vs "Categories:").
  let brand = null;
  $('.product_meta .posted_in').each((_, el) => {
    const label = cleanText($(el).find('.meta-label').first().text()) || '';
    if (/brand/i.test(label)) {
      brand = cleanText($(el).find('a').first().text()) || null;
    }
  });

  // ── Category (from breadcrumb) ─────────────────────────────
  // Breadcrumb: Home > Memory and Storage > Desktop & Laptop RAMs > <product name>
  // Take the last <a> before the (non-link) product name — most specific
  // category, and what actually matches what's on the page, instead of
  // trusting a hardcoded "RAM" string regardless of what product this is.
  const breadcrumbLinks = [];
  $('.woocommerce-breadcrumb a, nav.woocommerce-breadcrumb a').each((_, el) => {
    const text = cleanText($(el).text());
    if (text && text.toLowerCase() !== 'home') breadcrumbLinks.push(text);
  });

  const category = breadcrumbLinks[breadcrumbLinks.length - 1] || null;

  // ── Short Description ──────────────────────────────────────
  const shortDescription =
    cleanText($('.woocommerce-product-details__short-description').first().text()) ||
    null;

  // ── Tags ────────────────────────────────────────────────────
  const tags = [];
  $('.tagged_as a').each((_, el) => {
    const tag = cleanText($(el).text());
    if (tag) tags.push(tag);
  });

  return {
    url,
    store: 'fgtech',

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

    scrapedAt : new Date().toISOString(),
    scrapedVia: 'web_unlocker',
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };


























// // src/parsers/fgtech.js

// const cheerio = require('cheerio');

// function clean(value) {
//   return (value || '')
//     .replace(/\s+/g, ' ')
//     .replace(/\u00a0/g, ' ')
//     .trim();
// }

// /* =========================================================
//    LISTING PAGE
// ========================================================= */

// function parseProductLinks(html) {
//   const $ = cheerio.load(html);

//   const links = new Set();

//   $('a[href]').each((_, el) => {
//     const href = $(el).attr('href');

//     if (
//       href &&
//       href.includes('/product/') &&
//       !href.includes('/product-category/')
//     ) {
//       links.add(href.split('?')[0]);
//     }
//   });

//   console.log(
//     '\n[FGTECH] Product URLs Found:',
//     links.size
//   );

//   console.log(
//     [...links].slice(0, 20)
//   );

//   return [...links];
// }

// /* =========================================================
//    PAGINATION
// ========================================================= */

// function getNextPageUrl(html) {
//   const $ = cheerio.load(html);

//   return (
//     $('a.next.page-numbers').attr('href') ||
//     $('link[rel="next"]').attr('href') ||
//     null
//   );
// }

// /* =========================================================
//    PRODUCT PAGE
// ========================================================= */

// function parseProductDetails(html, url) {
//   const $ = cheerio.load(html);

//   const pageText = $.html();

//   const name =
//     clean($('.product_title').first().text()) ||
//     clean($('h1').first().text()) ||
//     null;

//   const salePrice =
//     clean(
//       $('p.price ins .woocommerce-Price-amount')
//         .first()
//         .text()
//     ) ||
//     clean(
//       $('p.price .woocommerce-Price-amount')
//         .first()
//         .text()
//     ) ||
//     null;

//   const originalPrice =
//     clean(
//       $('p.price del .woocommerce-Price-amount')
//         .first()
//         .text()
//     ) ||
//     null;

//   let brand = null;

//   const brandMatch =
//     pageText.match(
//       /"name":"pa_brand","value":"([^"]+)"/i
//     );

//   if (brandMatch) {
//     brand = clean(brandMatch[1]);
//   }

//   let sku = null;

//   const modelMatch =
//     pageText.match(
//       /"name":"pa_model","value":"([^"]+)"/i
//     );

//   if (modelMatch) {
//     sku = clean(modelMatch[1]);
//   }

//   if (!sku) {
//     const skuMatch =
//       pageText.match(
//         /"sku":"([^"]+)"/i
//       );

//     if (skuMatch) {
//       sku = clean(skuMatch[1]);
//     }
//   }

//   let stockStatus = 'In Stock';

//   if (
//     /out[\s-]*of[\s-]*stock/i.test(pageText)
//   ) {
//     stockStatus = 'Out of Stock';
//   }

//   const shortDescription =
//     clean(
//       $('meta[name="description"]').attr(
//         'content'
//       )
//     ) ||
//     clean(
//       $('meta[property="og:description"]').attr(
//         'content'
//       )
//     ) ||
//     '';

//   const tags = [];

//   $('.tagged_as a').each((_, el) => {
//     const tag = clean($(el).text());

//     if (tag) {
//       tags.push(tag);
//     }
//   });

//   return {
//     url,

//     store: 'fgtech',

//     name,

//     sku,
//     model: sku,
//     modelNumber: sku,
//     productCode: sku,

//     brand,

//     category: 'RAM',

//     stockStatus,

//     salePrice,
//     originalPrice,

//     shortDescription,

//     tags,

//     images: [],

//     specs: {},

//     scrapedAt: new Date().toISOString(),

//     scrapedVia: 'web_unlocker',
//   };
// }

// module.exports = {
//   parseProductLinks,
//   getNextPageUrl,
//   parseProductDetails,
// };