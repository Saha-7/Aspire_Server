// src/scheduler/index.js
// ─────────────────────────────────────────────────────────────
// PHASE 1 REWRITE — fixes:
//
//  FIX 1: findStoreConfig() replaced with explicit SCRAPER_CONFIG array.
//         No fuzzy .includes() matching. Each entry maps an exact
//         InternalProducts.Category name → store name → slug in urls.js.
//         Wrong store bug eliminated entirely.
//
//  FIX 2: NextScrapDueAt is only updated when result.saved > 0.
//         A 0-product scrape no longer locks out a category for 7 days.
//
//  FIX 3: runCleanupMapper() validates COSMOS_CONNECTION_STRING before
//         touching CosmosClient. Missing env var no longer crashes the
//         entire scheduler run.
//
//  FIX 4: Removed noisy "no store config found" log for every one of
//         the 179 Shopify-only categories that have no scraper.
//         Scheduler only logs categories it actually processes.
// ─────────────────────────────────────────────────────────────

require('dotenv').config();

const fs   = require('fs');
const sql  = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');
const { CosmosClient }         = require('@azure/cosmos');

const { STORES }               = require('../urls');
const { scrapeCategory }       = require('../scraper/index');
const { upsertManyFromCosmos } = require('../services/competitorPriceService');
const { getPaths }             = require('../scraper/fileHelpers');

// ─────────────────────────────────────────────────────────────
// SCRAPER_CONFIG
// ─────────────────────────────────────────────────────────────
// This is the single source of truth for what gets scraped.
//
// Each entry:
//   categoryName  — exact value from InternalProducts.Category (case-sensitive)
//   storeName     — exact store name from urls.js STORES array
//   slug          — exact category slug from that store's categories array
//
// IMPORTANT: Run this SQL to check your exact category names:
//   SELECT DISTINCT Category FROM InternalProducts
//   WHERE isActive = 1 ORDER BY Category
//
// Then match them here. If a category name in your DB is "Graphics Card"
// (with space, capital G and C), it must be written exactly that way here.
//
// To add a new category: add one object to this array. No other code changes.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// SCRAPER_CONFIG
// Cross-referenced against:
//   - list11.txt  (exact InternalProducts.Category values from DB)
//   - urls.js     (exact store names + slugs)
//
// Rules followed:
//   1. categoryName = exact string from DB (copy-pasted, no guessing)
//   2. For categories scraped from MULTIPLE stores, one entry per store
//      so you get competitor prices from all of them
//   3. Categories in DB with NO matching scraper are simply omitted
//   4. Duplicate slugs in vedant (ssd x2, hdd x2) — used only once
// ─────────────────────────────────────────────────────────────
const SCRAPER_CONFIG = [

  // ── Processor ───────────────────────────────────────────────
  // DB: "Processor" | Scraped from all 5 stores
  { categoryName: 'Processor', storeName: 'primeabgb',   slug: 'cpu-processor'  },
  { categoryName: 'Processor', storeName: 'mdcomputers', slug: 'cpu-processor'  },
  { categoryName: 'Processor', storeName: 'vedant',      slug: 'cpu-processor'  },
  { categoryName: 'Processor', storeName: 'vishal',      slug: 'cpu-processor'  },
  { categoryName: 'Processor', storeName: 'pcstudio',    slug: 'cpu-processor'  },

  // ── RAM ─────────────────────────────────────────────────────
  // DB: "RAM" | Scraped from all 5 stores
  { categoryName: 'RAM', storeName: 'primeabgb',   slug: 'ram-memory' },
  { categoryName: 'RAM', storeName: 'mdcomputers', slug: 'ram-memory' },
  { categoryName: 'RAM', storeName: 'vedant',      slug: 'ram-memory' },
  { categoryName: 'RAM', storeName: 'vishal',      slug: 'ram-memory' },
  { categoryName: 'RAM', storeName: 'pcstudio',    slug: 'ram-memory' },

  // ── Graphics Card ────────────────────────────────────────────
  // DB: "Graphics Card" | Scraped from all 5 stores
  { categoryName: 'Graphics Card', storeName: 'primeabgb',   slug: 'graphic-cards'  },
  { categoryName: 'Graphics Card', storeName: 'mdcomputers', slug: 'graphic-cards'  },
  { categoryName: 'Graphics Card', storeName: 'vedant',      slug: 'graphic-cards'  },
  { categoryName: 'Graphics Card', storeName: 'vishal',      slug: 'graphic-cards'  },
  { categoryName: 'Graphics Card', storeName: 'pcstudio',    slug: 'graphics-card'  }, // ← pcstudio slug is different: "graphics-card" not "graphic-cards"

  // ── Motherboard ──────────────────────────────────────────────
  // DB: "Motherboard" | Scraped from all 5 stores
  { categoryName: 'Motherboard', storeName: 'primeabgb',   slug: 'motherboards' },
  { categoryName: 'Motherboard', storeName: 'mdcomputers', slug: 'motherboards' },
  { categoryName: 'Motherboard', storeName: 'vedant',      slug: 'motherboards' },
  { categoryName: 'Motherboard', storeName: 'vishal',      slug: 'motherboards' },
  { categoryName: 'Motherboard', storeName: 'pcstudio',    slug: 'motherboard'  }, // ← pcstudio slug is "motherboard" not "motherboards"

  // ── Monitor ──────────────────────────────────────────────────
  // DB: "Monitor" | Scraped from 4 stores (vedant has no monitor category)
  { categoryName: 'Monitor', storeName: 'primeabgb',   slug: 'monitors' },
  { categoryName: 'Monitor', storeName: 'mdcomputers', slug: 'monitors' },
  { categoryName: 'Monitor', storeName: 'vishal',      slug: 'monitors' },
  { categoryName: 'Monitor', storeName: 'pcstudio',    slug: 'monitors' },

  // ── SSD ──────────────────────────────────────────────────────
  // DB: "SSD" | mdcomputers has 5 SSD sub-categories — scrape all for best coverage
  { categoryName: 'SSD', storeName: 'primeabgb',   slug: 'ssd'       },
  { categoryName: 'SSD', storeName: 'mdcomputers', slug: 'ssd-sata'  },
  { categoryName: 'SSD', storeName: 'mdcomputers', slug: 'ssd-gen3'  },
  { categoryName: 'SSD', storeName: 'mdcomputers', slug: 'ssd-gen4'  },
  { categoryName: 'SSD', storeName: 'mdcomputers', slug: 'ssd-gen5'  },
  { categoryName: 'SSD', storeName: 'vedant',      slug: 'ssd'       },
  { categoryName: 'SSD', storeName: 'vishal',      slug: 'ssd'       },
  { categoryName: 'SSD', storeName: 'pcstudio',    slug: 'storage'   }, // pcstudio has combined storage

  // ── External SSD ─────────────────────────────────────────────
  // DB: "External SSD" | only mdcomputers has a dedicated slug
  { categoryName: 'External SSD', storeName: 'mdcomputers', slug: 'external-ssd' },

  // ── HDD ──────────────────────────────────────────────────────
  // DB: "HDD" | internal HDD
  { categoryName: 'HDD', storeName: 'primeabgb',   slug: 'hdd'          },
  { categoryName: 'HDD', storeName: 'mdcomputers', slug: 'internal-hdd' },
  { categoryName: 'HDD', storeName: 'vedant',      slug: 'hdd'          },
  { categoryName: 'HDD', storeName: 'vishal',      slug: 'hdd'          },

  // ── External Hard Drive ──────────────────────────────────────
  // DB: "External Hard Drive" | mdcomputers only
  { categoryName: 'External Hard Drive', storeName: 'mdcomputers', slug: 'external-hdd' },

  // ── Cabinet ──────────────────────────────────────────────────
  // DB: "Cabinet" | Scraped from all 5 stores
  { categoryName: 'Cabinet', storeName: 'primeabgb',   slug: 'pc-case-cabinets' },
  { categoryName: 'Cabinet', storeName: 'mdcomputers', slug: 'cabinet'          },
  { categoryName: 'Cabinet', storeName: 'vedant',      slug: 'cabinet'          },
  { categoryName: 'Cabinet', storeName: 'vishal',      slug: 'cabinet'          },
  { categoryName: 'Cabinet', storeName: 'pcstudio',    slug: 'cabinets'         }, // ← pcstudio slug is "cabinets"

  // ── Power Supply ─────────────────────────────────────────────
  // DB: "Power Supply" | Scraped from 4 stores
  { categoryName: 'Power Supply', storeName: 'primeabgb',   slug: 'smps'          },
  { categoryName: 'Power Supply', storeName: 'vedant',      slug: 'power-supply'  },
  { categoryName: 'Power Supply', storeName: 'vishal',      slug: 'power-supply'  },
  { categoryName: 'Power Supply', storeName: 'pcstudio',    slug: 'power-supply'  },

  // ── CPU Cooler ───────────────────────────────────────────────
  // DB: "CPU Cooler" | Scraped from 4 stores
  // Note: "CPU Air Cooler" and "CPU Liquid Cooler" are also in DB but
  // no dedicated slugs exist for those — they'll come under CPU Cooler scrapes
  { categoryName: 'CPU Cooler', storeName: 'primeabgb',   slug: 'cpu-cooler' },
  { categoryName: 'CPU Cooler', storeName: 'vedant',      slug: 'cpu-cooler' },
  { categoryName: 'CPU Cooler', storeName: 'pcstudio',    slug: 'cpu-cooler' },

  // ── NAS ──────────────────────────────────────────────────────
  // DB: "NAS" | primeabgb only
  { categoryName: 'NAS', storeName: 'primeabgb', slug: 'nas' },

  // ── Rackmount NAS ─────────────────────────────────────────────
  // DB: "Rackmount NAS" | primeabgb only (same NAS page covers both)
  { categoryName: 'Rackmount NAS', storeName: 'primeabgb', slug: 'nas' },

  // ── Headset ──────────────────────────────────────────────────
  // DB: "Headset" | primeabgb only
  { categoryName: 'Headset', storeName: 'primeabgb', slug: 'gaming-headset' },

  // ── Thermal Paste ────────────────────────────────────────────
  // DB: "Thermal Paste" | vedant only
  { categoryName: 'Thermal Paste', storeName: 'vedant', slug: 'thermal-paste' },

  // ── Case Fan ─────────────────────────────────────────────────
  // DB: "Case Fan" | vedant only
  { categoryName: 'Case Fan', storeName: 'vedant', slug: 'case-fan' },

  // ── Laptop Cooler ────────────────────────────────────────────
  // DB: "Laptop Cooler" | vedant only
  { categoryName: 'Laptop Cooler', storeName: 'vedant', slug: 'laptop-cooler' },

  // ── Pendrive ─────────────────────────────────────────────────
  // DB: "Pendrive" | mdcomputers only
  { categoryName: 'Pendrive', storeName: 'mdcomputers', slug: 'pen-drives' },

];

// Build a fast lookup map: categoryName → config entry
const SCRAPER_CONFIG_MAP = new Map(
  SCRAPER_CONFIG.map(c => [c.categoryName, c])
);

// ─────────────────────────────────────────────────────────────

const DEFAULT_FREQ_DAYS = 7;

function isDue(nextScrapDueAt) {
  if (!nextScrapDueAt) return true;
  return new Date() >= new Date(nextScrapDueAt);
}

// ── SQL connection ────────────────────────────────────────────
async function getSqlPool() {
  const credential = process.env.AZURE_ENV === 'production'
    ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
    : new AzureCliCredential();

  const tokenResponse = await credential.getToken(
    'https://database.windows.net/.default'
  );

  return await sql.connect({
    server  : process.env.db_serverendpoint,
    database: 'db_tpstechautomata',
    authentication: {
      type   : 'azure-active-directory-access-token',
      options: { token: tokenResponse.token },
    },
    options: {
      encrypt              : true,
      trustServerCertificate: false,
      requestTimeout       : 60_000,
    },
  });
}

// ── Load schedule only for categories we actually scrape ──────
// Only queries for categories present in SCRAPER_CONFIG.
// Ignores all 179 Shopify-only categories entirely.
async function loadScrapingSchedule(pool) {
  if (SCRAPER_CONFIG.length === 0) return [];

  const request    = pool.request();
  const paramNames = SCRAPER_CONFIG.map((c, i) => {
    request.input(`cat${i}`, sql.NVarChar(200), c.categoryName);
    return `@cat${i}`;
  });

  const result = await request.query(`
    SELECT
      ip.Category,
      MAX(ip.NextScrapDueAt)                           AS NextScrapDueAt,
      MAX(ip.LastScrapedAt)                            AS LastScrapedAt,
      MAX(cs.ScrapFreqDays)                            AS ScrapFreqDays,
      CAST(MAX(CAST(cs.IsScrapEnabled AS INT)) AS BIT) AS IsScrapEnabled
    FROM InternalProducts ip
    LEFT JOIN CategorySettings cs ON cs.CategoryName = ip.Category
    WHERE ip.Category IN (${paramNames.join(',')})
    GROUP BY ip.Category
    ORDER BY ip.Category
  `);

  return result.recordset;
}

// ── Update timestamps — only called when saved > 0 ────────────
async function updateScrapedTimestamps(pool, categoryName, frequencyDays) {
  const now     = new Date();
  const nextDue = new Date(now);
  nextDue.setDate(nextDue.getDate() + frequencyDays);

  await pool.request()
    .input('Category',       sql.NVarChar(200), categoryName)
    .input('LastScrapedAt',  sql.NVarChar(50),  now.toISOString())
    .input('NextScrapDueAt', sql.NVarChar(50),  nextDue.toISOString())
    .query(`
      UPDATE InternalProducts
      SET LastScrapedAt  = @LastScrapedAt,
          NextScrapDueAt = @NextScrapDueAt
      WHERE Category = @Category
    `);
}

// ── Resolve store + category objects from urls.js ─────────────
// Clean lookup — exact match only, no fuzzy logic.
function resolveStoreConfig(storeName, slug) {
  const store = STORES.find(s => s.name === storeName);
  if (!store) return null;
  const category = store.categories.find(c => c.slug === slug);
  if (!category) return null;
  return { store, category };
}

// ── Clear stale cache files ───────────────────────────────────
function clearCategoryCache(storeName, categorySlug) {
  const paths = getPaths(storeName, categorySlug);
  const filesToDelete = [
    paths.visitedCache,
    paths.urlsCache,
    paths.fullOutput,
    paths.priceOutput,
  ];
  for (const filePath of filesToDelete) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

// ── Push scraped products to Cosmos ──────────────────────────
async function pushScrapedDataToCosmos(products, label, log) {
  if (!products || products.length === 0) {
    log(`⚠️  No products to push for ${label}`);
    return { pushed: 0, failed: 0 };
  }

  // FIX 3: Guard before touching CosmosClient
  if (!process.env.COSMOS_CONNECTION_STRING) {
    log(`❌ COSMOS_CONNECTION_STRING missing — skipping Cosmos push`);
    log(`   Go to Azure Portal → App Service → Configuration → Application settings`);
    return { pushed: 0, failed: products.length };
  }

  let client;
  try {
    client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  } catch (err) {
    log(`❌ CosmosClient init failed: ${err.message}`);
    log(`   Check COSMOS_CONNECTION_STRING value in Azure App Settings`);
    return { pushed: 0, failed: products.length };
  }

  const container = client.database('ScraperDB').container('scrap_results');

  let pushed = 0;
  let failed = 0;

  log(`☁️  Pushing ${products.length} products to Cosmos (${label})...`);

  for (const product of products) {
    try {
      product.id = Buffer.from(product.url).toString('base64').substring(0, 255);
      await container.items.upsert(product);
      pushed++;
    } catch (err) {
      log(`❌ Cosmos upsert failed: ${product.url} — ${err.message}`);
      failed++;
    }
  }

  log(`✅ Cosmos: pushed ${pushed} | failed ${failed}`);
  return { pushed, failed };
}

// ── Cosmos → SQL cleanup mapper ───────────────────────────────
async function runCleanupMapper(log) {
  if (!process.env.COSMOS_CONNECTION_STRING) {
    log(`❌ COSMOS_CONNECTION_STRING missing — skipping cleanup mapper`);
    return;
  }

  let client;
  try {
    client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  } catch (err) {
    log(`❌ CosmosClient init failed: ${err.message}`);
    log(`   Cleanup mapper skipped — CompetitorPrices not updated this run`);
    return;
  }

  const container = client.database('ScraperDB').container('scrap_results');
  const { resources } = await container.items.query('SELECT * FROM c').fetchAll();

  log(`📦 Cosmos → SQL: ${resources.length} documents`);
  const stats = await upsertManyFromCosmos(resources);
  log(`✅ Inserted: ${stats.inserted} | Updated: ${stats.updated} | Failed: ${stats.failed}`);
}

// ─────────────────────────────────────────────────────────────
// MAIN SCHEDULER
// ─────────────────────────────────────────────────────────────
async function runScheduler(options = {}) {
  const log         = options.log         || ((msg) => console.log(msg));
  const isCancelled = options.isCancelled || (() => false);

  const startTime = Date.now();
  log('⏰ Scheduler starting...');
  log(`📋 Scraper config has ${SCRAPER_CONFIG.length} categories configured`);

  let pool;

  try {
    pool = await getSqlPool();
    log('🔌 Connected to SQL');

    // Load schedule only for categories in SCRAPER_CONFIG
    const scheduleRows = await loadScrapingSchedule(pool);

    // Build map: categoryName → schedule row
    const scheduleMap = new Map(scheduleRows.map(r => [r.Category, r]));

    // Determine due / skipped / paused
    const due     = [];
    const skipped = [];
    const paused  = [];

    for (const config of SCRAPER_CONFIG) {
      const schedule   = scheduleMap.get(config.categoryName);
      const isEnabled  = schedule ? (schedule.IsScrapEnabled !== false && schedule.IsScrapEnabled !== 0) : true;
      const freqDays   = schedule?.ScrapFreqDays ?? DEFAULT_FREQ_DAYS;
      const nextDue    = schedule?.NextScrapDueAt ?? null;

      if (!isEnabled) {
        paused.push({ ...config, freqDays });
        continue;
      }

      if (isDue(nextDue)) {
        due.push({ ...config, freqDays, nextDue });
      } else {
        skipped.push({ ...config, freqDays, nextDue });
      }
    }

    log(`✅ Due for scraping  : ${due.length} categories`);
    log(`⏭️  Not due yet       : ${skipped.length} categories`);

    if (paused.length > 0) {
      log(`⏸️  Paused (Settings) : ${paused.length} categories`);
      paused.forEach(r => log(`   → ${r.categoryName}`));
    }

    skipped.forEach(r =>
      log(`⏭️  Skipping ${r.categoryName} — next due: ${r.nextDue}`)
    );

    if (due.length === 0) {
      log('ℹ️  Nothing to scrape — all categories are up to date.');
      return;
    }

    log(`\n🚀 Starting scrapes for ${due.length} categories...`);

    let totalScraped   = 0;
    let totalFailed    = 0;
    let totalPushed    = 0;
    let categoriesDone = 0;

    for (const entry of due) {
      // Check cancel between categories — never mid-category
      if (isCancelled()) {
        log(`🛑 Cancellation requested — stopping after ${categoriesDone} categories.`);
        log(`   Remaining categories will be retried on next run.`);
        break;
      }

      // Resolve store + category objects from urls.js
      const resolved = resolveStoreConfig(entry.storeName, entry.slug);

      if (!resolved) {
        log(`⚠️  Config error: storeName="${entry.storeName}" slug="${entry.slug}" not found in urls.js`);
        log(`   Check SCRAPER_CONFIG entry for "${entry.categoryName}"`);
        continue;
      }

      const { store, category } = resolved;

      log(`━━━ ${entry.categoryName} → ${store.name}/${category.slug} (every ${entry.freqDays}d) ━━━`);

      log(`   🗑️  Clearing stale cache...`);
      clearCategoryCache(store.name, category.slug);

      try {
        log(`   🌐 Scraping ${store.name}/${category.slug}...`);
        const result = await scrapeCategory(store, category);

        log(`   📦 Scraped: ${result.saved} products | Failed: ${result.failed}`);

        if (result.saved === 0) {
          // FIX 2: Do NOT update NextScrapDueAt on zero results.
          // Category stays due so it retries next run.
          log(`   ⚠️  0 products scraped — NextScrapDueAt NOT updated (will retry next run)`);
          totalFailed++;
          continue;
        }

        totalScraped += result.saved;

        // Push to Cosmos immediately after each category (crash-safe)
        if (result.products?.length > 0) {
          const { pushed } = await pushScrapedDataToCosmos(
            result.products,
            `${store.name}/${category.slug}`,
            log
          );
          totalPushed += pushed;
        }

        // FIX 2: Only stamp timestamps when we actually got products
        await updateScrapedTimestamps(pool, entry.categoryName, entry.freqDays);
        log(`   ⏰ Next scrape in ${entry.freqDays} days`);
        categoriesDone++;

      } catch (err) {
        log(`   ❌ Scrape failed for ${entry.categoryName}: ${err.message}`);
        totalFailed++;
        // No timestamp update on exception — category retries next run
      }
    }

    // Run cleanup mapper once at the end
    if (categoriesDone > 0) {
      log('\n📤 Running cleanup mapper (Cosmos → SQL CompetitorPrices)...');
      await runCleanupMapper(log);
    } else {
      log('\n⚠️  No categories completed — skipping cleanup mapper');
    }

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`\n🎉 Scheduler finished in ${totalSec}s`);
    log(`   Categories done  : ${categoriesDone}`);
    log(`   Products scraped : ${totalScraped}`);
    log(`   Cosmos pushed    : ${totalPushed}`);
    log(`   Failed/skipped   : ${totalFailed}`);

  } catch (err) {
    log(`❌ Scheduler fatal error: ${err.message}`);
    throw err;
  } finally {
    if (pool) await pool.close();
  }
}

if (require.main === module) {
  runScheduler().catch(err => {
    console.error('Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { runScheduler };