// src/scraper/index.js
//
// CHANGE (parallel scraping, 2026-08-05):
//   Products inside a category now scrape CONCURRENTLY (shared limiter,
//   SCRAPE_CONCURRENCY env var, default 5) instead of serially with a
//   1.5s sleep between each. Listing-page pagination is still serial
//   (has to follow "next page" links in order) but now also goes
//   through the same limiter so it counts against the same cap.
//   rebuildPriceFile() + visitedCache write now happen once at the end
//   of a category instead of after every product.
//
// CHANGE (Ctrl+C handling):
//   scrapeAll() accepts isCancelled() and threads it through to every
//   category. The CLI block at the bottom registers SIGINT/SIGTERM so
//   `node src/scraper/index.js` stops cleanly on Ctrl+C — only runs for
//   direct CLI runs, never in production (scheduler/API require() this
//   file as a module, so this block never executes there).
//
// CHANGE (this update): scrapeAll() now times the whole run and prints
//   total elapsed minutes when it finishes.
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const { fetchPage }                                                  = require('./fetchPage');
const { ensureDir, readJson, writeJson, getPaths, rebuildPriceFile } = require('./fileHelpers');
const { scrapeAndSave }                                              = require('./scrapeProduct');
const { createLimiter }                                              = require('./concurrency');
const { createMutex }                                                = require('./mutex');
const { STORES }                                                     = require('../urls');
const { log }                                                        = require('../../blobLogger');

const DEFAULT_CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY) || 5;

function canonicalizeProductUrl(url) {
  if (!url) return url;
  return url.replace(/\/collections\/[^/]+(?=\/products\/)/i, '');
}

async function collectUrlsForCategory(store, startUrl, urlsCachePath, limit) {
  const saved = readJson(urlsCachePath, null);

  if (saved && saved.length > 0) {
    console.log(`  ♻️  Loaded ${saved.length} cached URLs`);
    return new Set(saved);
  }

  const { parser }         = store;
  const productUrls        = new Set();
  const seenCanonicalUrls  = new Set();
  const visitedListingUrls = new Set();
  let currentUrl = startUrl;
  let pageNum    = 1;
  let dupesSkipped = 0;

  while (currentUrl) {
    if (visitedListingUrls.has(currentUrl)) {
      console.log(`  ⚠️  Pagination loop detected at ${currentUrl} — stopping`);
      log('WARN', 'index.js', 'collectUrlsForCategory', `Pagination loop detected at ${currentUrl} — stopping`);
      break;
    }
    visitedListingUrls.add(currentUrl);

    console.log(`  📄 Page ${pageNum}: ${currentUrl}`);

    try {
      const html  = await limit(() => fetchPage(currentUrl));
      const links = parser.parseProductLinks(html);
      console.log(`     ↳ ${links.length} links found`);

      links.forEach(l => {
        const canonical = canonicalizeProductUrl(l);
        if (seenCanonicalUrls.has(canonical)) {
          dupesSkipped++;
          return;
        }
        seenCanonicalUrls.add(canonical);
        productUrls.add(l);
      });

      currentUrl = parser.getNextPageUrl(html, currentUrl);
      pageNum++;
    } catch (err) {
      console.error(`  ❌ Listing page error: ${err.message}`);
      log('ERROR', 'index.js', 'collectUrlsForCategory', `Listing page error at ${currentUrl}: ${err.message}`);
      break;
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  if (dupesSkipped > 0) {
    console.log(`  🧹 Skipped ${dupesSkipped} duplicate-URL-form links (same product, different link form)`);
    log('INFO', 'index.js', 'collectUrlsForCategory', `Skipped ${dupesSkipped} duplicate-URL-form links for ${startUrl}`);
  }

  if (productUrls.size > 0) {
    writeJson(urlsCachePath, [...productUrls]);
    console.log(`  💾 Saved ${productUrls.size} URLs to cache`);
  } else {
    console.log(`  ⚠️  0 URLs found — cache NOT written (will retry fresh next run)`);
    log('WARN', 'index.js', 'collectUrlsForCategory', `0 URLs found for ${startUrl} — cache not written`);
  }

  return productUrls;
}

/**
 * @param {function} [limit] - shared limiter from createLimiter(). If not
 *   passed, this category gets its own (fine for a one-off manual run) —
 *   but the scheduler always passes ONE SHARED limiter so total
 *   concurrency across categories stays capped.
 */
async function scrapeCategory(store, category, isCancelled = () => false, limit = createLimiter(DEFAULT_CONCURRENCY)) {
  const { name: storeName }    = store;
  const { slug, url: startUrl } = category;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`🏪 Store: ${storeName}  📂 Category: ${slug}`);
  console.log(`${'─'.repeat(60)}`);
  log('INFO', 'index.js', 'scrapeCategory', `Starting store: ${storeName}, category: ${slug}`);

  const paths = getPaths(storeName, slug);
  ensureDir(paths.dir);

  const productUrls = await collectUrlsForCategory(store, startUrl, paths.urlsCache, limit);
  console.log(`  ✅ ${productUrls.size} product URLs total`);

  const visited = new Set(readJson(paths.visitedCache, []));
  const total   = productUrls.size;
  let doneCount = visited.size;
  let saved     = 0;
  let failed    = 0;
  let cancelled = false;

  if (visited.size > 0) {
    console.log(`  ♻️  Resuming: ${visited.size} already done, ${total - visited.size} remaining`);
  }

  const remaining = [...productUrls].filter(url => !visited.has(url));
  const fileMutex = createMutex(); // serializes products_full.json writes for THIS category

  const tasks = remaining.map(productUrl => limit(async () => {
    if (isCancelled()) {
      cancelled = true;
      return null;
    }

    const product = await scrapeAndSave(store, productUrl, paths.fullOutput, paths.priceOutput, fileMutex);

    doneCount++;
    if (product?.name) {
      console.log(`  🛒 [${doneCount}/${total}] ✅ ${product.name.substring(0, 55)}`);
      saved++;
    } else {
      console.log(`  🛒 [${doneCount}/${total}] ⚠️  No data — ${productUrl}`);
      failed++;
    }

    visited.add(productUrl);
    return product;
  }));

  const results  = await Promise.all(tasks);
  const products = results.filter(p => p?.name);

  writeJson(paths.visitedCache, [...visited]);
  if (products.length > 0) {
    rebuildPriceFile(paths.fullOutput, paths.priceOutput);
  }

  console.log(`\n  🏁 ${storeName}/${slug} complete${cancelled ? ' (cancelled)' : ''}`);
  console.log(`     Saved : ${saved} | Failed: ${failed} | Total: ${doneCount}`);
  console.log(`     Full  → ${paths.fullOutput}`);
  console.log(`     Price → ${paths.priceOutput}`);
  log('INFO', 'index.js', 'scrapeCategory',
    `${storeName}/${slug} complete${cancelled ? ' (cancelled)' : ''} — Saved: ${saved}, Failed: ${failed}, Total: ${doneCount}`);

  return { done: doneCount, saved, failed, products, cancelled };
}

async function scrapeAll(stores = STORES, isCancelled = () => false) {
  const startTime = Date.now();

  console.log('🚀 Multi-store price scraper (Web Unlocker API)\n');
  console.log(`   Stores     : ${stores.map(s => s.name).join(', ')}`);

  const totalCategories = stores.reduce((acc, s) => acc + s.categories.length, 0);
  console.log(`   Categories : ${totalCategories}`);
  console.log(`   Concurrency: ${DEFAULT_CONCURRENCY} (SCRAPE_CONCURRENCY env var)\n`);
  log('INFO', 'index.js', 'scrapeAll', `Run started — categories: ${totalCategories}, concurrency: ${DEFAULT_CONCURRENCY}`);

  const limit = createLimiter(DEFAULT_CONCURRENCY); // ONE shared limiter for the whole run

  const jobs = [];
  for (const store of stores) {
    for (const category of store.categories) jobs.push({ store, category });
  }

  const results = await Promise.all(jobs.map(async ({ store, category }) => {
    try {
      const result = await scrapeCategory(store, category, isCancelled, limit);
      return { store: store.name, category: category.slug, ...result, success: true };
    } catch (err) {
      console.error(`\n❌ Failed: ${store.name}/${category.slug}: ${err.message}`);
      log('ERROR', 'index.js', 'scrapeAll', `Failed: ${store.name}/${category.slug}: ${err.message}`);
      return { store: store.name, category: category.slug, success: false, error: err.message };
    }
  }));

  const elapsedMs  = Date.now() - startTime;
  const elapsedMin = (elapsedMs / 60000).toFixed(1);

  console.log('\n\n🎉 All stores and categories complete!');
  console.log(`⏱️  Total time: ${elapsedMin} minutes`);
  log('INFO', 'index.js', 'scrapeAll', `Run finished in ${elapsedMin} min — ${results.filter(r => r.success).length}/${results.length} succeeded`);

  return results;
}

if (require.main === module) {
  let cliCancelled = false;
  let forceExitTimer = null;

  function requestShutdown(signal) {
    if (cliCancelled) {
      console.log('\n⚠️  Second interrupt — force exiting now. Current file writes may be incomplete.');
      process.exit(1);
    }
    cliCancelled = true;
    console.log(`\n🛑 ${signal} received — finishing in-flight requests (up to ${DEFAULT_CONCURRENCY}), then stopping. Press Ctrl+C again to force quit.`);

    forceExitTimer = setTimeout(() => {
      console.log('⏱️  Still not done after 15s — force exiting.');
      process.exit(1);
    }, 15_000);
    forceExitTimer.unref(); // don't let this timer itself keep the process alive
  }

  process.on('SIGINT',  () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));

  scrapeAll(STORES, () => cliCancelled)
    .then(() => {
      if (forceExitTimer) clearTimeout(forceExitTimer);
      process.exit(cliCancelled ? 1 : 0);
    })
    .catch(err => {
      console.error('Fatal error:', err.message);
      log('ERROR', 'index.js', 'scrapeAll', `Fatal error: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { scrapeAll, scrapeCategory };
































// // src/scraper/index.js
// //
// // CHANGE (parallel scraping, 2026-08-05):
// //   Products inside a category now scrape CONCURRENTLY (shared limiter,
// //   SCRAPE_CONCURRENCY env var, default 8) instead of serially with a
// //   1.5s sleep between each. Listing-page pagination is still serial
// //   (has to follow "next page" links in order) but now also goes
// //   through the same limiter so it counts against the same cap.
// //   rebuildPriceFile() + visitedCache write now happen once at the end
// //   of a category instead of after every product.
// // ─────────────────────────────────────────────────────────────

// require('dotenv').config();

// const { fetchPage }                                                  = require('./fetchPage');
// const { ensureDir, readJson, writeJson, getPaths, rebuildPriceFile } = require('./fileHelpers');
// const { scrapeAndSave }                                              = require('./scrapeProduct');
// const { createLimiter }                                              = require('./concurrency');
// const { createMutex }                                                = require('./mutex');
// const { STORES }                                                     = require('../urls');
// const { log }                                                        = require('../../blobLogger');

// const DEFAULT_CONCURRENCY = Number(process.env.SCRAPE_CONCURRENCY) || 5;

// function canonicalizeProductUrl(url) {
//   if (!url) return url;
//   return url.replace(/\/collections\/[^/]+(?=\/products\/)/i, '');
// }

// async function collectUrlsForCategory(store, startUrl, urlsCachePath, limit) {
//   const saved = readJson(urlsCachePath, null);

//   if (saved && saved.length > 0) {
//     console.log(`  ♻️  Loaded ${saved.length} cached URLs`);
//     return new Set(saved);
//   }

//   const { parser }         = store;
//   const productUrls        = new Set();
//   const seenCanonicalUrls  = new Set();
//   const visitedListingUrls = new Set();
//   let currentUrl = startUrl;
//   let pageNum    = 1;
//   let dupesSkipped = 0;

//   while (currentUrl) {
//     if (visitedListingUrls.has(currentUrl)) {
//       console.log(`  ⚠️  Pagination loop detected at ${currentUrl} — stopping`);
//       log('WARN', 'index.js', 'collectUrlsForCategory', `Pagination loop detected at ${currentUrl} — stopping`);
//       break;
//     }
//     visitedListingUrls.add(currentUrl);

//     console.log(`  📄 Page ${pageNum}: ${currentUrl}`);

//     try {
//       const html  = await limit(() => fetchPage(currentUrl));
//       const links = parser.parseProductLinks(html);
//       console.log(`     ↳ ${links.length} links found`);

//       links.forEach(l => {
//         const canonical = canonicalizeProductUrl(l);
//         if (seenCanonicalUrls.has(canonical)) {
//           dupesSkipped++;
//           return;
//         }
//         seenCanonicalUrls.add(canonical);
//         productUrls.add(l);
//       });

//       currentUrl = parser.getNextPageUrl(html, currentUrl);
//       pageNum++;
//     } catch (err) {
//       console.error(`  ❌ Listing page error: ${err.message}`);
//       log('ERROR', 'index.js', 'collectUrlsForCategory', `Listing page error at ${currentUrl}: ${err.message}`);
//       break;
//     }

//     await new Promise(r => setTimeout(r, 1500));
//   }

//   if (dupesSkipped > 0) {
//     console.log(`  🧹 Skipped ${dupesSkipped} duplicate-URL-form links (same product, different link form)`);
//     log('INFO', 'index.js', 'collectUrlsForCategory', `Skipped ${dupesSkipped} duplicate-URL-form links for ${startUrl}`);
//   }

//   if (productUrls.size > 0) {
//     writeJson(urlsCachePath, [...productUrls]);
//     console.log(`  💾 Saved ${productUrls.size} URLs to cache`);
//   } else {
//     console.log(`  ⚠️  0 URLs found — cache NOT written (will retry fresh next run)`);
//     log('WARN', 'index.js', 'collectUrlsForCategory', `0 URLs found for ${startUrl} — cache not written`);
//   }

//   return productUrls;
// }

// /**
//  * @param {function} [limit] - shared limiter from createLimiter(). If not
//  *   passed, this category gets its own (fine for a one-off manual run) —
//  *   but the scheduler always passes ONE SHARED limiter so total
//  *   concurrency across categories stays capped.
//  */
// async function scrapeCategory(store, category, isCancelled = () => false, limit = createLimiter(DEFAULT_CONCURRENCY)) {
//   const { name: storeName }    = store;
//   const { slug, url: startUrl } = category;

//   console.log(`\n${'─'.repeat(60)}`);
//   console.log(`🏪 Store: ${storeName}  📂 Category: ${slug}`);
//   console.log(`${'─'.repeat(60)}`);
//   log('INFO', 'index.js', 'scrapeCategory', `Starting store: ${storeName}, category: ${slug}`);

//   const paths = getPaths(storeName, slug);
//   ensureDir(paths.dir);

//   const productUrls = await collectUrlsForCategory(store, startUrl, paths.urlsCache, limit);
//   console.log(`  ✅ ${productUrls.size} product URLs total`);

//   const visited = new Set(readJson(paths.visitedCache, []));
//   const total   = productUrls.size;
//   let doneCount = visited.size;
//   let saved     = 0;
//   let failed    = 0;
//   let cancelled = false;

//   if (visited.size > 0) {
//     console.log(`  ♻️  Resuming: ${visited.size} already done, ${total - visited.size} remaining`);
//   }

//   const remaining = [...productUrls].filter(url => !visited.has(url));
//   const fileMutex = createMutex(); // serializes products_full.json writes for THIS category

//   const tasks = remaining.map(productUrl => limit(async () => {
//     if (isCancelled()) {
//       cancelled = true;
//       return null;
//     }

//     const product = await scrapeAndSave(store, productUrl, paths.fullOutput, paths.priceOutput, fileMutex);

//     doneCount++;
//     if (product?.name) {
//       console.log(`  🛒 [${doneCount}/${total}] ✅ ${product.name.substring(0, 55)}`);
//       saved++;
//     } else {
//       console.log(`  🛒 [${doneCount}/${total}] ⚠️  No data — ${productUrl}`);
//       failed++;
//     }

//     visited.add(productUrl);
//     return product;
//   }));

//   const results  = await Promise.all(tasks);
//   const products = results.filter(p => p?.name);

//   writeJson(paths.visitedCache, [...visited]);
//   if (products.length > 0) {
//     rebuildPriceFile(paths.fullOutput, paths.priceOutput);
//   }

//   console.log(`\n  🏁 ${storeName}/${slug} complete${cancelled ? ' (cancelled)' : ''}`);
//   console.log(`     Saved : ${saved} | Failed: ${failed} | Total: ${doneCount}`);
//   console.log(`     Full  → ${paths.fullOutput}`);
//   console.log(`     Price → ${paths.priceOutput}`);
//   log('INFO', 'index.js', 'scrapeCategory',
//     `${storeName}/${slug} complete${cancelled ? ' (cancelled)' : ''} — Saved: ${saved}, Failed: ${failed}, Total: ${doneCount}`);

//   return { done: doneCount, saved, failed, products, cancelled };
// }

// async function scrapeAll(stores = STORES) {
//   console.log('🚀 Multi-store price scraper (Web Unlocker API)\n');
//   console.log(`   Stores     : ${stores.map(s => s.name).join(', ')}`);

//   const totalCategories = stores.reduce((acc, s) => acc + s.categories.length, 0);
//   console.log(`   Categories : ${totalCategories}`);
//   console.log(`   Concurrency: ${DEFAULT_CONCURRENCY} (SCRAPE_CONCURRENCY env var)\n`);
//   log('INFO', 'index.js', 'scrapeAll', `Run started — categories: ${totalCategories}, concurrency: ${DEFAULT_CONCURRENCY}`);

//   const limit = createLimiter(DEFAULT_CONCURRENCY); // ONE shared limiter for the whole run

//   const jobs = [];
//   for (const store of stores) {
//     for (const category of store.categories) jobs.push({ store, category });
//   }

//   const results = await Promise.all(jobs.map(async ({ store, category }) => {
//     try {
//       const result = await scrapeCategory(store, category, () => false, limit);
//       return { store: store.name, category: category.slug, ...result, success: true };
//     } catch (err) {
//       console.error(`\n❌ Failed: ${store.name}/${category.slug}: ${err.message}`);
//       log('ERROR', 'index.js', 'scrapeAll', `Failed: ${store.name}/${category.slug}: ${err.message}`);
//       return { store: store.name, category: category.slug, success: false, error: err.message };
//     }
//   }));

//   console.log('\n\n🎉 All stores and categories complete!');
//   log('INFO', 'index.js', 'scrapeAll', `Run finished — ${results.filter(r => r.success).length}/${results.length} succeeded`);
//   return results;
// }

// if (require.main === module) {
//   scrapeAll().catch(err => {
//     console.error('Fatal error:', err.message);
//     log('ERROR', 'index.js', 'scrapeAll', `Fatal error: ${err.message}`);
//     process.exit(1);
//   });
// }

// module.exports = { scrapeAll, scrapeCategory };