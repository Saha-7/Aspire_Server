// src/parsers/computechstore.js
// ─────────────────────────────────────────────────────────────
// Computech Store — custom Django storefront (HTMX + Tailwind), NOT
// OpenCart/WooCommerce/Shopify like the other stores in this project.
// Web Unlocker / cheerio version — synchronous, receives HTML string.
//
// NOTES:
// - The visible "View More Gear" button is an HTMX partial-load button
//   (hx-get="/product-category/<slug>/?page=2&sort=newest" hx-target=
//   "#product-grid-container" hx-swap="beforeend"). It has no real
//   value we can "click", but the href it builds is just a normal
//   query-string page param — a plain GET to that same URL (no
//   HX-Request header, which is what fetchPage sends) returns the
//   FULL category page with page 2's products rendered server-side,
//   same as page 1. So we just increment ?page=N like a normal
//   query-param pagination scheme and ignore the HTMX button entirely.
// - There's no visible "this is the last page" marker (no OpenCart-
//   style disabled/missing next link) — the button is always present
//   even past the last real page. So, same pattern as vedant.js:
//   stop when a page returns 0 product links OR the same set of
//   links as a previous page (duplicate-page guard), with a hard
//   safety cap on page count.
// - Price elements are plain `₹<digits>` text with no currency
//   formatting — Tailwind's `line-through` utility class is what
//   marks the OLD/struck-through price (confirmed via devtools on
//   the product page), so that's used to tell old vs new price apart
//   instead of relying on brittle arbitrary-value class strings like
//   `text-[11px]` (Tailwind JIT-generated, not guaranteed stable).
// - SKU and stock status are plain text ("SKU: 100-...", "Availability"
//   label followed by a sibling "Low Stock"/"In Stock" value) rather
//   than semantic classes/microdata, so they're found by their label
//   text and DOM relationship rather than a CSS selector.
// - Specs (Specs tab: "Brands AMD", "Socket AM5", "Processor-Model …")
//   render as flat label/value pairs. The exact container wasn't
//   available to verify against live markup, so this is a best-effort
//   extractor (id/class containing "spec", then dt/dd OR two-child-
//   per-row pairing) — if it comes back empty on a real run, share
//   the Specs tab HTML and selectors can be tightened.
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

const BASE = 'https://computechstore.in';

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
//  Every real product page lives at /product/<slug>/ — category nav
//  links use /product-category/<slug>/ instead, so filtering on
//  "/product/" alone cleanly excludes nav/footer links without
//  needing the grid container's exact class name.
// ─────────────────────────────────────────────────────────────
function parseProductLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  const scope = $('#product-grid-container').length ? $('#product-grid-container') : $.root();

  scope.find('a[href*="/product/"]').each((_, el) => {
    const href = absoluteUrl($(el).attr('href'));
    if (href) links.add(href);
  });

  return [...links];
}

// ─────────────────────────────────────────────────────────────
//  PAGINATION
//  No real "next page" link exists (see notes above) — just keep
//  incrementing ?page=N (mirroring the HTMX button's own URL) until
//  a page comes back empty or repeats a page we've already seen.
// ─────────────────────────────────────────────────────────────
const seenPageFingerprints = new Set();

function getNextPageUrl(html, currentUrl) {
  const links = parseProductLinks(html);

  if (links.length === 0) return null;

  const fingerprint = links.slice().sort().join('|');
  if (seenPageFingerprints.has(fingerprint)) {
    console.log('  🛑 Duplicate page detected — stopping pagination');
    return null;
  }
  seenPageFingerprints.add(fingerprint);

  const url = new URL(currentUrl);
  const currentPage = parseInt(url.searchParams.get('page') || '1', 10);

  // Safety cap — mirrors vedant.js's guard against a runaway loop if
  // the dedupe/empty-page checks above ever fail to trip.
  if (currentPage >= 50) return null;

  url.searchParams.set('page', String(currentPage + 1));
  url.searchParams.set('sort', 'newest'); // matches the site's own "View More Gear" URL

  return url.toString();
}

// ─────────────────────────────────────────────────────────────
//  PRODUCT DETAILS
// ─────────────────────────────────────────────────────────────
function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  // ── Name ────────────────────────────────────────────────────
  const name = cleanText($('h1').first().text()) || null;

  // ── SKU ─────────────────────────────────────────────────────
  // Rendered as a plain "SKU: <value>" text node, not a labelled
  // class — find the (deepest) element whose own direct text starts
  // with "SKU:" and take what follows.
  let sku = null;
  $('*').each((_, el) => {
    if (sku) return;
    const ownText = cleanText($(el).clone().children().remove().end().text());
    if (ownText && /^SKU:/i.test(ownText)) {
      sku = cleanText(ownText.replace(/^SKU:\s*/i, '')) || null;
    }
  });

  // ── Brand ───────────────────────────────────────────────────
  // Brand logo links to /brand/<slug>/ with the brand name as alt text.
  const brandLink = $('a[href*="/brand/"]').first();
  const brand =
    cleanText(brandLink.find('img').attr('alt')) ||
    cleanText(brandLink.text()) ||
    null;

  // ── Prices ──────────────────────────────────────────────────
  // `line-through` is a stable Tailwind utility class (unlike the
  // arbitrary-value classes like text-[11px], which are fine today
  // but more likely to shift on a template tweak) — used here to
  // distinguish old vs new price instead of font-size/color classes.
  const priceSpans = $('span, div').filter((_, el) => {
    const t = cleanText($(el).clone().children().remove().end().text());
    return !!(t && /^₹[\d,]+(\.\d+)?$/.test(t));
  });

  let salePrice = null;
  let originalPrice = null;
  priceSpans.each((_, el) => {
    const t = cleanText($(el).clone().children().remove().end().text());
    const isStruck = $(el).hasClass('line-through') || $(el).closest('.line-through').length > 0;
    if (isStruck) {
      if (!originalPrice) originalPrice = t;
    } else {
      if (!salePrice) salePrice = t;
    }
  });

  // ── Stock / Availability ────────────────────────────────────
  // "Availability" is a label span; the real status ("In Stock",
  // "Low Stock", etc.) is a sibling element next to it, not inside it.
  let stockStatus = null;
  $('span').each((_, el) => {
    if (stockStatus) return;
    if (/^availability$/i.test(cleanText($(el).text()) || '')) {
      const container = $(el).parent();
      const valueText = container
        .find('span')
        .filter((__, s) => s !== el)
        .first()
        .text();
      stockStatus = cleanText(valueText);
    }
  });

  // ── Category (breadcrumb) ────────────────────────────────────
  // Breadcrumb: Home / <most specific category> / <product name>.
  // Same "last link before the product name" pattern as the other
  // parsers in this project.
  const breadcrumbLinks = [];
  $('nav a, ol a, .breadcrumb a, .breadcrumbs a').each((_, el) => {
    const text = cleanText($(el).text());
    const href = $(el).attr('href') || '';
    if (text && href.includes('/product-category/')) breadcrumbLinks.push(text);
  });
  const category = breadcrumbLinks[breadcrumbLinks.length - 1] || null;

  // ── Specs ───────────────────────────────────────────────────
  // Best-effort: haven't been able to verify the exact Specs-tab
  // markup against live DOM, so this tries a couple of common
  // patterns and returns {} rather than guessing wrong if neither
  // matches. Flag back if this comes up empty on a real scrape.
  const specs = {};
  const specsContainer = $('[id*="spec" i], [class*="spec" i]').first();
  if (specsContainer.length) {
    specsContainer.find('dt').each((_, dt) => {
      const key   = cleanText($(dt).text());
      const value = cleanText($(dt).next('dd').text());
      if (key && value) specs[key] = value;
    });
    if (Object.keys(specs).length === 0) {
      specsContainer.children().each((_, row) => {
        const cells = $(row).children();
        if (cells.length === 2) {
          const key   = cleanText($(cells[0]).text());
          const value = cleanText($(cells[1]).text());
          if (key && value) specs[key] = value;
        }
      });
    }
  }

  return {
    url,
    store: 'computechstore',

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

    specs,

    scrapedAt : new Date().toISOString(),
    scrapedVia: 'web_unlocker',
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };