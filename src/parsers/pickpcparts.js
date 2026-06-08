// ─────────────────────────────────────────────────────────────
//  parsers/pickpcparts.js  (Web Unlocker / cheerio version)
//  Same selectors as Playwright version — now synchronous.
// ─────────────────────────────────────────────────────────────

const cheerio = require('cheerio');

// ── Extract all product links from a category/listing page ───
function parseProductLinks(html) {
  const $ = cheerio.load(html);
  const links = new Set();

  $('a[href]').each((_, el) => {
    let href = $(el).attr('href') || '';

    if (href.startsWith('/')) href = 'https://pickpcparts.in' + href;

    if (
      href.startsWith('https://pickpcparts.in/') &&
      !href.includes('/processors') &&
      !href.includes('/rams') &&
      !href.includes('/motherboards') &&
      !href.includes('#')
    ) {
      links.add(href.split('?')[0]);
    }
  });

  return [...links];
}


// ── Return the next pagination URL, or null on last page ─────
function getNextPageUrl(html) {
  const $ = cheerio.load(html);

  // Active page is in a <span> inside .pcp-archive-pagination
  const activeSpan = $('.pcp-archive-pagination span').first();
  if (!activeSpan.length) return null;

  const currentPage = parseInt(activeSpan.text().trim());
  if (isNaN(currentPage)) return null;

  // Find the <a> with data-page = currentPage + 1
  let nextUrl = null;
  $('.pcp-archive-pagination a[data-page]').each((_, el) => {
    const page = parseInt($(el).attr('data-page'));
    if (page === currentPage + 1) {
      nextUrl = $(el).attr('href');
    }
  });

  return nextUrl || null;
}

// ── Extract all product data from a single product page ──────
function parseProductDetails(html, url) {
  const $ = cheerio.load(html);

  const getText = (selector) => $(selector).first().text().trim() || null;

  // ── Name ──────────────────────────────────────────────────
  const name =
    getText('h1.elementor-heading-title') ||
    getText('h1');

  // ── Category from URL ─────────────────────────────────────
  const urlParts = url.split('/');
  const category = urlParts[urlParts.length - 2] || null;

  // ── Retailer prices table ─────────────────────────────────
  // Columns: Retailer | Price | Availability | Buy | Last Checked
  const retailerPrices = [];
  $('table.pcpps-price-table tbody tr').each((_, row) => {
    const cells     = $(row).find('td');
    const retailer  = $(cells[0]).text().trim();
    const price     = $(cells[1]).text().trim();
    const available = $(cells[2]).text().trim();
    const buyLink   = $(cells[3]).find('a').attr('href') || null;
    const lastChecked = $(cells[4])?.text().trim() || null;

    // Skip rows with no real price (Amazon shows "—" when unlisted)
    if (retailer && price && price !== '—') {
      retailerPrices.push({ retailer, price, available, buyLink, lastChecked });
    }
  });

  // ── Lowest price across retailers ─────────────────────────
  const lowestPrice = retailerPrices.length
    ? retailerPrices.reduce((a, b) => {
        const aVal = parseFloat(a.price.replace(/[^0-9.]/g, ''));
        const bVal = parseFloat(b.price.replace(/[^0-9.]/g, ''));
        return aVal < bVal ? a : b;
      })
    : null;

  // ── Specifications ────────────────────────────────────────
  // Elementor layout: parent .e-con-full.e-child has 2 child .e-con-full
  // left = label, right = value
  const specs = {};
  $('.e-con-full.e-flex.e-con.e-child').each((_, container) => {
    const children = $(container).find(':scope > .e-con-full');
    if (children.length === 2) {
      const key   = $(children[0]).find('strong, p').first().text().replace(':', '').trim();
      const value = $(children[1]).find('.elementor-widget-container').first().text().trim();
      if (key && value && value !== '–' && key !== value) {
        specs[key] = value;
      }
    }
  });

  // ── Part IDs ──────────────────────────────────────────────
  // Stored in <ul class="acf-list"> inside .elementor-widget-container
  const rawPartIds = [];
  $('.elementor-widget-container ul.acf-list li').each((_, li) => {
    const t = $(li).text().trim();
    if (t) rawPartIds.push(t);
  });

  const partId  = rawPartIds[0] || null;
  const partId2 = rawPartIds[1] || undefined;

  // Remove mangled Part ID from specs — stored separately above
  delete specs['Part ID'];

  // ── Price history from inline Chart.js script ─────────────
  let priceHistory = null;
  $('script').each((_, el) => {
    const src = $(el).html() || '';
    if (src.includes('pcpps_ph_')) {
      const match = src.match(/var data = ({.*?});/s);
      if (match) {
        try {
          const chartData = JSON.parse(match[1]);
          priceHistory = {
            labels  : chartData.labels,
            datasets: chartData.datasets?.map(d => ({
              retailer: d.label,
              data    : d.data,
            })),
          };
        } catch (_) {}
      }
    }
  });

  // ── Amazon link ───────────────────────────────────────────
  const amazonLink =
    $('a[href*="amzn.to"], a[href*="amazon.in"]').first().attr('href') || null;

  return {
    url,
    store: 'pickpcparts',
    name,
    category,
    partId,
    partId2,
    lowestPrice: lowestPrice
      ? { retailer: lowestPrice.retailer, price: lowestPrice.price }
      : null,
    retailerPrices,
    specs,
    priceHistory,
    amazonLink,
    scrapedAt: new Date().toISOString(),
  };
}

module.exports = { parseProductLinks, getNextPageUrl, parseProductDetails };