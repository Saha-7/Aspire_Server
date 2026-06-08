const cheerio = require('cheerio');

const BASE = 'https://www.vedantcomputers.com';

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim() || null;
}

function absoluteUrl(href) {
  if (!href) return null;
  if (href.startsWith('http')) return href.split('?')[0];
  if (href.startsWith('/')) return (BASE + href).split('?')[0];
  return null;
}

function parseProductLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  $('.product-thumb .name a, .product-thumb a.product-img, .product-layout .name a').each((_, el) => {
    const href = absoluteUrl($(el).attr('href'));
    if (href && href.includes('vedantcomputers.com')) {
      links.add(href);
    }
  });

  return [...links];
}

const seenPageFingerprints = new Set();

function getNextPageUrl(html, currentUrl) {
  const links = parseProductLinks(html);

  // Stop if no products
  if (links.length === 0) {
    return null;
  }

  // Create fingerprint for this page
  const fingerprint = links.sort().join('|');

  // If same exact products already seen -> stop
  if (seenPageFingerprints.has(fingerprint)) {
    console.log('  🛑 Duplicate page detected — stopping pagination');
    return null;
  }

  seenPageFingerprints.add(fingerprint);

  const url = new URL(currentUrl);

  const currentPage = parseInt(
    url.searchParams.get('page') || '1',
    10
  );

  // Safety limit
  if (currentPage >= 20) {
    return null;
  }

  url.searchParams.set('page', String(currentPage + 1));

  return url.toString();
}

function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  let schemaProduct = null;
  let schemaBreadcrumb = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html();
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw);

      if (parsed['@type'] === 'Product') {
        schemaProduct = parsed;
      }

      if (parsed['@type'] === 'BreadcrumbList') {
        schemaBreadcrumb = parsed;
      }
    } catch (_) {}
  });

  const name =
    cleanText($('.page-title-text').first().text()) ||
    cleanText($('.product-details .title').first().text()) ||
    cleanText(schemaProduct?.name) ||
    null;

  const salePrice =
    cleanText($('.product-price-new').first().text()) ||
    cleanText(schemaProduct?.offers?.price) ||
    null;

  const originalPrice =
    cleanText($('.product-price-old').first().text()) ||
    null;

  const stockStatus =
    cleanText($('.product-stock span').first().text()) ||
    (schemaProduct?.offers?.availability?.includes('InStock') ? 'In Stock' : null);

  const brand =
    cleanText($('.product-manufacturer a').first().text()) ||
    cleanText(schemaProduct?.brand?.name) ||
    null;

  const model =
    cleanText($('.product-model span').first().text()) ||
    cleanText(schemaProduct?.model) ||
    null;

  const sku =
    cleanText($('.product-sku span').first().text()) ||
    cleanText(schemaProduct?.sku) ||
    model ||
    null;

  const tags = [];
  $('.tags a').each((_, el) => {
    const tag = cleanText($(el).text());
    if (tag) tags.push(tag);
  });

  const breadcrumbItems = schemaBreadcrumb?.itemListElement || [];
  const categoryFromSchema =
    breadcrumbItems.find(item => item.position === 3)?.item?.name ||
    null;

  const categoryFromTags =
    tags.find(tag => tag.toLowerCase() === 'processor') ||
    tags.find(tag => tag.toLowerCase() === 'cpu') ||
    null;

  const category =
    cleanText($('.breadcrumb li a').eq(2).text()) ||
    cleanText(categoryFromSchema) ||
    cleanText(categoryFromTags) ||
    'Processor';

  const images = [];
  $('.main-image img, .additional-images img').each((_, el) => {
    const src =
      $(el).attr('data-largeimg') ||
      $(el).attr('data-src') ||
      $(el).attr('src');

    if (src && src.startsWith('http') && !src.startsWith('data:image')) {
      images.push(src);
    }
  });

  const specs = {};
  $('.product-extra-description table tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    const section = cleanText($(cells[0]).text());
    const details = cleanText($(cells[1]).text());

    if (section && details) {
      specs[section] = details;
    }
  });

  const shortDescription =
    cleanText($('.product-extra-description .block-content h2').first().text()) ||
    cleanText(schemaProduct?.description) ||
    null;

  return {
    url,
    store: 'vedant',
    name,
    sku,
    model,
    brand,
    category,
    stockStatus,
    salePrice,
    originalPrice,
    shortDescription,
    tags,
    images: [...new Set(images)],
    specs,
    scrapedAt: new Date().toISOString(),
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };
