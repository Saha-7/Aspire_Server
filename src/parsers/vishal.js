const cheerio = require('cheerio');

const BASE = 'https://vishalperipherals.com';

function cleanText(value) {
  return (value || '')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

/*
|--------------------------------------------------------------------------
| IMPORTANT
|--------------------------------------------------------------------------
| DO NOT remove query params here.
| Shopify pagination uses ?page=2
|--------------------------------------------------------------------------
*/

function absoluteUrl(href) {
  if (!href) return null;

  if (href.startsWith('http')) {
    return href;
  }

  if (href.startsWith('/')) {
    return BASE + href;
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| CATEGORY
|--------------------------------------------------------------------------
| FIX: category was previously hardcoded to 'Processor' for every
| product regardless of what was actually scraped — left over from
| when this parser was first written for the Processor category, never
| updated when reused for Monitors and others. Derive it instead from
| the collection slug already present in the URL, e.g.
| ".../collections/monitors/products/..." -> "Monitors".
*/

function categoryFromUrl(url) {
  if (!url) return null;

  const match = url.match(/\/collections\/([^/]+)\/products\//i);

  if (!match) return null;

  return match[1]
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/*
|--------------------------------------------------------------------------
| PRODUCT LINKS
|--------------------------------------------------------------------------
*/

function parseProductLinks(html) {
  const $ = cheerio.load(html);

  const links = new Set();

  $('a[href*="/products/"]').each((_, el) => {
    const href = absoluteUrl(
      $(el).attr('href')
    );

    if (
      href &&
      href.includes('/products/')
    ) {
      // remove query only for product URLs
      links.add(href.split('?')[0]);
    }
  });

  return [...links];
}

/*
|--------------------------------------------------------------------------
| PAGINATION
|--------------------------------------------------------------------------
*/

function getNextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);

  const current = new URL(currentUrl);

  const currentPage = parseInt(
    current.searchParams.get('page') || '1',
    10
  );

  let nextHref = null;

  $('a[href*="?page="]').each((_, el) => {
    const href = $(el).attr('href');

    if (!href) return;

    const match = href.match(/page=(\d+)/);

    if (!match) return;

    const pageNum = parseInt(match[1], 10);

    if (pageNum === currentPage + 1) {
      nextHref = href;
    }
  });

  if (!nextHref) {
    return null;
  }

  return absoluteUrl(nextHref);
}

/*
|--------------------------------------------------------------------------
| PRODUCT DETAILS
|--------------------------------------------------------------------------
*/

function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  const bodyText = $('body').text();

  /*
  |--------------------------------------------------------------------------
  | NAME
  |--------------------------------------------------------------------------
  */

  const name =
    cleanText($('h1').first().text()) ||
    null;

 /*
|--------------------------------------------------------------------------
| PRICES
|--------------------------------------------------------------------------
*/

const salePrice =
  cleanText(
    $('#js-product-price').first().text()
  ) ||
  cleanText(
    $('.price--sale .current').first().text()
  ) ||
  null;

const originalPrice =
  cleanText(
    $('.price--sale .compare').first().text()
  ) ||
  null;

  /*
  |--------------------------------------------------------------------------
  | STOCK
  |--------------------------------------------------------------------------
  | FIX: this site marks unavailable products as "Unavailable" (with a
  | "NOTIFY ME" button) — it never uses the literal strings "Out of stock"
  | or "Sold out" anywhere on the page, so the old check below always
  | fell through to 'In Stock' regardless of real availability.
  | Read the structured "Availability:" label/span field (same pattern
  | used for Model Number below) first, and fall back to a broader
  | bodyText check that also covers "unavailable".
  */

  let availabilityText = null;

  $('label').each((_, el) => {
    const labelText = cleanText($(el).text());

    if (
      labelText &&
      labelText.toLowerCase().includes('availability')
    ) {
      availabilityText = cleanText($(el).next('span').text());
    }
  });

  const stockStatus = /unavailable|out of stock|sold out/i.test(
    availabilityText || bodyText
  )
    ? 'Out of Stock'
    : 'In Stock';

  /*
  |--------------------------------------------------------------------------
  | BRAND
  |--------------------------------------------------------------------------
  */

  let brand = null;

  if (name) {
    if (name.toUpperCase().includes('INTEL')) {
      brand = 'Intel';
    }

    if (name.toUpperCase().includes('AMD')) {
      brand = 'AMD';
    }
  }

  
  /*
  |--------------------------------------------------------------------------
  | MODEL NUMBER
  |--------------------------------------------------------------------------
  */


let modelNumber = null;

// Vishal structure:
// <label class="label">Model Number:</label>
// <span>CT8G48C40S5</span>

$('label').each((_, el) => {
  const labelText = cleanText($(el).text());

  if (
    labelText &&
    labelText.toLowerCase().includes('model number')
  ) {
    const value = cleanText(
      $(el).next('span').text()
    );

    if (value) {
      modelNumber = value;
    }
  }
});

  /*
  |--------------------------------------------------------------------------
  | SKU
  |--------------------------------------------------------------------------
  | FIX: real SKUs on this site are alphanumeric (e.g. "LS32FG502EWXXL"),
  | but the old regex only accepted digits (/SKU:\s*([0-9]+)/), so it
  | never matched the real SKU field and instead grabbed whatever other
  | numeric "SKU:"-looking text happened to exist elsewhere in the page
  | (a stray widget/script), or returned null. Read the structured
  | "SKU:" label/span field directly instead, same pattern as
  | Model Number and Availability above.
  */

  let sku = null;

  $('label').each((_, el) => {
    const labelText = cleanText($(el).text());

    if (
      labelText &&
      labelText.toLowerCase().includes('sku')
    ) {
      const value = cleanText($(el).next('span').text());

      if (value) {
        sku = value;
      }
    }
  });

  /*
  |--------------------------------------------------------------------------
  | DESCRIPTION
  |--------------------------------------------------------------------------
  */

  let shortDescription = null;

  $('.rte, .product-description, p').each((_, el) => {
    const txt = cleanText($(el).text());

    if (
      txt &&
      txt.length > 120 &&
      !shortDescription
    ) {
      shortDescription = txt;
    }
  });

  /*
  |--------------------------------------------------------------------------
  | IMAGES
  |--------------------------------------------------------------------------
  */

  const images = new Set();

  $('img').each((_, el) => {
    let src =
      $(el).attr('src') ||
      $(el).attr('data-src');

    if (!src) return;

    if (src.startsWith('//')) {
      src = 'https:' + src;
    }

    if (
      src.includes('/products/') ||
      src.includes('/cdn/shop/files/')
    ) {
      images.add(src.split('?')[0]);
    }
  });

  /*
  |--------------------------------------------------------------------------
  | SPECS
  |--------------------------------------------------------------------------
  */

  const specs = {};

  $('table tr').each((_, row) => {
    const key = cleanText(
      $(row).find('td, th').eq(0).text()
    );

    const value = cleanText(
      $(row).find('td, th').eq(1).text()
    );

    if (key && value) {
      specs[key] = value;
    }
  });

  return {
    url,
    store: 'vishal',
    name,
    modelNumber,
    sku,
    brand,
    category: categoryFromUrl(url),
    stockStatus,
    salePrice,
    originalPrice,
    shortDescription,
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