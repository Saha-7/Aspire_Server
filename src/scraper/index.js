// src/scraper/index.js
//
// CHANGE:
//   scrapeCategory() now returns { done, saved, failed, products[], cancelled }
//   The products array contains all successfully scraped product objects
//   in memory so the scheduler can push them directly to Cosmos without
//   reading back from disk. Disk writes (output/ folder) still happen
//   as a backup/log but are NOT relied upon for the automated flow.
//
//   Manual runs (node src/scraper/index.js) are completely unchanged.
//
// FIX 1 (2026-06-13): Cache bugs — see details below.
//
// FIX 2 (2026-06-13): Cancel now stops IMMEDIATELY between products,
//   not just between categories. isCancelled() is now accepted as an
//   optional parameter and checked inside the product scraping loop.
//   When cancel is requested mid-category, the function returns early
//   with whatever products were already scraped, and sets cancelled=true
//   in the return value so the caller knows to stop.
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const { fetchPage }                                        = require('./fetchPage');
const { ensureDir, readJson, writeJson, getPaths }         = require('./fileHelpers');
const { scrapeAndSave }                                    = require('./scrapeProduct');
const { STORES }                                           = require('../urls');

// ─────────────────────────────────────────────────────────────
//  URL COLLECTION
// ─────────────────────────────────────────────────────────────

async function collectUrlsForCategory(store, startUrl, urlsCachePath) {
  const saved = readJson(urlsCachePath, null);

  // FIX: `if (saved)` was truthy for an empty array [].
  // A previous run that got 0 links would write [], and every run after
  // that would load it and return 0 URLs. Only use cache if it has URLs.
  if (saved && saved.length > 0) {
    console.log(`  ♻️  Loaded ${saved.length} cached URLs`);
    return new Set(saved);
  }

  const { parser }         = store;
  const productUrls        = new Set();
  const visitedListingUrls = new Set();
  let currentUrl = startUrl;
  let pageNum    = 1;

  while (currentUrl) {
    if (visitedListingUrls.has(currentUrl)) {
      console.log(`  ⚠️  Pagination loop detected at ${currentUrl} — stopping`);
      break;
    }
    visitedListingUrls.add(currentUrl);

    console.log(`  📄 Page ${pageNum}: ${currentUrl}`);

    try {
      const html  = await fetchPage(currentUrl);
      const links = parser.parseProductLinks(html);
      console.log(`     ↳ ${links.length} links found`);
      links.forEach(l => productUrls.add(l));

      currentUrl = parser.getNextPageUrl(html, currentUrl);
      pageNum++;
    } catch (err) {
      console.error(`  ❌ Listing page error: ${err.message}`);
      break;
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  // FIX: Never write an empty cache file.
  // If Bright Data returned a challenge/empty page, writing [] would
  // poison the cache permanently. Only write when we actually found URLs.
  if (productUrls.size > 0) {
    writeJson(urlsCachePath, [...productUrls]);
    console.log(`  💾 Saved ${productUrls.size} URLs to cache`);
  } else {
    console.log(`  ⚠️  0 URLs found — cache NOT written (will retry fresh next run)`);
  }

  return productUrls;
}

// ─────────────────────────────────────────────────────────────
//  CATEGORY RUNNER
// ─────────────────────────────────────────────────────────────

/**
 * Scrapes all products for a single store + category.
 *
 * @param {object} store
 * @param {object} category
 * @param {function} [isCancelled] - Optional. Called before each product.
 *   If it returns true, scraping stops immediately and the function
 *   returns early with cancelled=true. Defaults to () => false.
 *
 * @returns {Promise<{ done, saved, failed, products[], cancelled }>}
 *   cancelled=true means scraping was cut short by the cancel flag.
 */
async function scrapeCategory(store, category, isCancelled = () => false) {
  const { name: storeName }    = store;
  const { slug, url: startUrl } = category;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🏪 Store: ${storeName}  📂 Category: ${slug}`);
  console.log(`${'─'.repeat(60)}`);

  const paths = getPaths(storeName, slug);
  ensureDir(paths.dir);

  const productUrls = await collectUrlsForCategory(store, startUrl, paths.urlsCache);
  console.log(`  ✅ ${productUrls.size} product URLs total`);

  const visited   = new Set(readJson(paths.visitedCache, []));
  const total     = productUrls.size;
  let done        = visited.size;
  let saved       = 0;
  let failed      = 0;
  let cancelled   = false;
  const products  = [];

  if (visited.size > 0) {
    console.log(`  ♻️  Resuming: ${visited.size} already done, ${total - visited.size} remaining`);
  }

  for (const productUrl of productUrls) {
    if (visited.has(productUrl)) continue;

    // FIX 2: Check cancel flag before every single product, not just
    // between categories. This gives near-immediate stop on cancel.
    if (isCancelled()) {
      console.log(`  🛑 Cancel requested — stopping after ${saved} products scraped in this category`);
      cancelled = true;
      break;
    }

    done++;

    process.stdout.write(`  🛒 [${done}/${total}] `);

    const product = await scrapeAndSave(store, productUrl, paths.fullOutput, paths.priceOutput);

    if (product?.name) {
      console.log(`✅ ${product.name.substring(0, 55)}`);
      saved++;
      products.push(product);
    } else {
      console.log(`⚠️  No data — ${productUrl}`);
      failed++;
    }

    visited.add(productUrl);
    writeJson(paths.visitedCache, [...visited]);

    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n  🏁 ${storeName}/${slug} complete${cancelled ? ' (cancelled)' : ''}`);
  console.log(`     Saved : ${saved} | Failed: ${failed} | Total: ${done}`);
  console.log(`     Full  → ${paths.fullOutput}`);
  console.log(`     Price → ${paths.priceOutput}`);

  return { done, saved, failed, products, cancelled };
}

// ─────────────────────────────────────────────────────────────
//  MAIN — runs all stores/categories when called directly
// ─────────────────────────────────────────────────────────────

async function scrapeAll(stores = STORES) {
  console.log('🚀 Multi-store price scraper (Web Unlocker API)\n');
  console.log(`   Stores     : ${stores.map(s => s.name).join(', ')}`);

  const totalCategories = stores.reduce((acc, s) => acc + s.categories.length, 0);
  console.log(`   Categories : ${totalCategories}\n`);

  const results = [];

  for (const store of stores) {
    for (const category of store.categories) {
      try {
        const result = await scrapeCategory(store, category);
        results.push({ store: store.name, category: category.slug, ...result, success: true });
      } catch (err) {
        console.error(`\n❌ Failed: ${store.name}/${category.slug}: ${err.message}`);
        results.push({ store: store.name, category: category.slug, success: false, error: err.message });
      }
    }
  }

  console.log('\n\n🎉 All stores and categories complete!');
  console.log('Output saved in: output/<store>/<category>/');

  return results;
}

if (require.main === module) {
  scrapeAll().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { scrapeAll, scrapeCategory };