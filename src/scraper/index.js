// src/scraper/index.js
//
// CHANGE:
//   scrapeCategory() now returns { done, saved, failed, products[] }
//   The products array contains all successfully scraped product objects
//   in memory so the scheduler can push them directly to Cosmos without
//   reading back from disk. Disk writes (output/ folder) still happen
//   as a backup/log but are NOT relied upon for the automated flow.
//
//   Manual runs (node src/scraper/index.js) are completely unchanged.
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
  if (saved) {
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

  writeJson(urlsCachePath, [...productUrls]);
  console.log(`  💾 Saved ${productUrls.size} URLs to cache`);
  return productUrls;
}

// ─────────────────────────────────────────────────────────────
//  CATEGORY RUNNER
// ─────────────────────────────────────────────────────────────

/**
 * Scrapes all products for a single store + category.
 *
 * @returns {Promise<{ done, saved, failed, products[] }>}
 *
 * CHANGE: now also returns `products` — the array of all successfully
 * scraped product objects held in memory. The scheduler uses this to
 * push directly to Cosmos without reading back from disk, which is
 * required for Azure deployment where the local filesystem is ephemeral.
 */
async function scrapeCategory(store, category) {
  const { name: storeName }    = store;
  const { slug, url: startUrl } = category;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🏪 Store: ${storeName}  📂 Category: ${slug}`);
  console.log(`${'─'.repeat(60)}`);

  const paths = getPaths(storeName, slug);
  ensureDir(paths.dir);

  const productUrls = await collectUrlsForCategory(store, startUrl, paths.urlsCache);
  console.log(`  ✅ ${productUrls.size} product URLs total`);

  const visited  = new Set(readJson(paths.visitedCache, []));
  const total    = productUrls.size;
  let done       = visited.size;
  let saved      = 0;
  let failed     = 0;
  const products = []; // ← NEW: collect scraped products in memory

  if (visited.size > 0) {
    console.log(`  ♻️  Resuming: ${visited.size} already done, ${total - visited.size} remaining`);
  }

  for (const productUrl of productUrls) {
    if (visited.has(productUrl)) continue;
    done++;

    process.stdout.write(`  🛒 [${done}/${total}] `);

    const product = await scrapeAndSave(store, productUrl, paths.fullOutput, paths.priceOutput);

    if (product?.name) {
      console.log(`✅ ${product.name.substring(0, 55)}`);
      saved++;
      products.push(product); // ← NEW: keep in memory
    } else {
      console.log(`⚠️  No data — ${productUrl}`);
      failed++;
    }

    visited.add(productUrl);
    writeJson(paths.visitedCache, [...visited]);

    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n  🏁 ${storeName}/${slug} complete`);
  console.log(`     Saved : ${saved} | Failed: ${failed} | Total: ${done}`);
  console.log(`     Full  → ${paths.fullOutput}`);
  console.log(`     Price → ${paths.priceOutput}`);

  // CHANGE: products[] added to return value
  return { done, saved, failed, products };
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