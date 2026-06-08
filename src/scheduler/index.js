// src/scheduler/index.js
//
// CHANGE (safety improvement):
//   pushScrapedDataToCosmos() is now called PER CATEGORY immediately
//   after scrapeCategory() completes — instead of batching everything
//   at the end. This means a mid-run crash only loses the current
//   category's data, not all categories scraped so far.
//
//   runCleanupMapper() is still called ONCE at the end (after all
//   categories) because it reads ALL of Cosmos and does a single bulk
//   MERGE into SQL. Running it per-category would cause redundant work.
//
// FULL AUTOMATED FLOW:
//   Scheduler fires
//     → Load category schedule from SQL
//     → For each due category:
//         a. clearCategoryCache()        wipe stale disk files
//         b. scrapeCategory()            scrape → return products[] in memory
//         c. pushScrapedDataToCosmos()   push THIS category immediately ← CHANGED
//         d. updateScrapedTimestamps()   update NextScrapDueAt in SQL
//     → runCleanupMapper()              Cosmos → map → upsert CompetitorPrices SQL (once, at end)
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

// ── System-wide default frequencies (days) ───────────────────
const DEFAULT_FREQUENCIES = {
  'Processor' : 7,
  'RAM'       : 7,
  'SSD'       : 7,
  'HDD'       : 7,
  'Storage'   : 7,
  'DEFAULT'   : 7,
};

function getDefaultFrequency(categoryName) {
  const key = Object.keys(DEFAULT_FREQUENCIES).find(
    k => k.toLowerCase() === (categoryName || '').toLowerCase()
  );
  return DEFAULT_FREQUENCIES[key] || DEFAULT_FREQUENCIES['DEFAULT'];
}

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

// ── Load category schedule ────────────────────────────────────
async function loadCategorySchedule(pool) {
  const result = await pool.request().query(`
    SELECT
      ip.Category,
      MAX(ip.NextScrapDueAt)     AS NextScrapDueAt,
      MAX(ip.LastScrapedAt)      AS LastScrapedAt,
      MAX(cs.ScrapFreqDays)      AS ScrapFreqDays,
      MAX(cs.IsScrapEnabled)     AS IsScrapEnabled
    FROM InternalProducts ip
    LEFT JOIN CategorySettings cs ON cs.CategoryName = ip.Category
    WHERE ip.Category IS NOT NULL
    GROUP BY ip.Category
    ORDER BY ip.Category
  `);

  return result.recordset;
}

// ── Update timestamps after successful scrape ─────────────────
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

  console.log(`   ⏰ NextScrapDueAt set to ${nextDue.toISOString()} (+${frequencyDays} days)`);
}

// ── Find matching store + category config from urls.js ────────
function findStoreConfig(categoryName) {
  for (const store of STORES) {
    for (const cat of store.categories) {
      const normalised = categoryName.toLowerCase().replace(/\s+/g, '-');
      if (
        cat.slug.toLowerCase() === normalised ||
        cat.slug.toLowerCase().includes(normalised) ||
        normalised.includes(cat.slug.toLowerCase())
      ) {
        return { store, category: cat };
      }
    }
  }
  return null;
}

// ── Clear stale cache files before each scheduled scrape ──────
function clearCategoryCache(storeName, categorySlug) {
  const paths = getPaths(storeName, categorySlug);

  const filesToDelete = [
    paths.visitedCache,
    paths.urlsCache,
    paths.fullOutput,
    paths.priceOutput,
  ];

  for (const filePath of filesToDelete) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`   🗑️  Cleared: ${filePath}`);
    }
  }
}

// ── Push products for ONE category to Cosmos immediately ──────
// CHANGE: was previously called once at the end with ALL products.
// Now called per-category right after scrapeCategory() returns.
// This means a crash mid-run only loses the current category,
// not everything scraped before it.
//
// Cosmos upsert is idempotent (same URL = same id), so re-running
// is always safe — no duplicates, no data corruption.
async function pushScrapedDataToCosmos(products, categoryLabel) {
  if (!products || products.length === 0) {
    console.log(`   ⚠️  No products to push to Cosmos for ${categoryLabel}`);
    return { pushed: 0, failed: 0 };
  }

  const client    = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database('ScraperDB').container('scrap_results');

  let pushed = 0;
  let failed = 0;

  console.log(`   ☁️  Pushing ${products.length} products to Cosmos (${categoryLabel})...`);

  for (const product of products) {
    try {
      product.id = Buffer.from(product.url).toString('base64').substring(0, 255);
      await container.items.upsert(product);
      pushed++;
    } catch (err) {
      console.error(`   ❌ Cosmos upsert failed: ${product.url} — ${err.message}`);
      failed++;
    }
  }

  console.log(`   ✅ Cosmos push done — pushed: ${pushed} | failed: ${failed}`);
  return { pushed, failed };
}

// ── Read from Cosmos → map → push to SQL (unchanged) ─────────
// Still runs once at the END after all categories are done.
// This is intentional: running it per-category would cause multiple
// full-table scans of Cosmos and redundant SQL MERGE operations.
async function runCleanupMapper() {
  const client    = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
  const container = client.database('ScraperDB').container('scrap_results');

  const { resources } = await container.items
    .query('SELECT * FROM c')
    .fetchAll();

  console.log(`\n📦 Cosmos → SQL: ${resources.length} documents`);
  const stats = await upsertManyFromCosmos(resources);
  console.log(`   Inserted: ${stats.inserted} | Updated: ${stats.updated} | Failed: ${stats.failed}`);
}

// ── Main scheduler ────────────────────────────────────────────
async function runScheduler() {
  const startTime = Date.now();
  console.log('⏰ Scheduler starting...\n');

  let pool;

  try {
    pool = await getSqlPool();
    console.log('🔌 Connected to SQL\n');

    const categories = await loadCategorySchedule(pool);
    console.log(`📋 Found ${categories.length} distinct categories\n`);

    const due     = [];
    const skipped = [];
    const paused  = [];

    for (const row of categories) {
      if (row.IsScrapEnabled === false || row.IsScrapEnabled === 0) {
        paused.push(row);
        continue;
      }

      const freqDays = row.ScrapFreqDays ?? getDefaultFrequency(row.Category);

      if (isDue(row.NextScrapDueAt)) {
        due.push({ ...row, freqDays });
      } else {
        skipped.push({ ...row, freqDays });
      }
    }

    console.log(`✅ Due for scraping   : ${due.length} categories`);
    console.log(`⏭️  Not due yet        : ${skipped.length} categories`);
    if (paused.length > 0) {
      console.log(`⏸️  Paused (UI)        : ${paused.length} categories`);
      paused.forEach(r => console.log(`   → ${r.Category}`));
    }

    if (skipped.length > 0) {
      console.log('\n   Skipped (next due):');
      skipped.forEach(r =>
        console.log(`   → ${r.Category.padEnd(25)} next: ${r.NextScrapDueAt || 'unknown'}`)
      );
    }

    if (due.length === 0) {
      console.log('\n🎉 Nothing to scrape today. All categories are up to date.');
      return;
    }

    console.log('\n🚀 Starting scrapes...');

    let totalScraped    = 0;
    let totalFailed     = 0;
    let totalPushed     = 0;  // track total Cosmos pushes across all categories
    let categoriesDone  = 0;

    for (const row of due) {
      console.log(`\n━━━ ${row.Category} (every ${row.freqDays} days) ━━━`);

      const config = findStoreConfig(row.Category);

      if (!config) {
        console.log(`   ⚠️  No store config found for "${row.Category}" in urls.js — skipping`);
        continue;
      }

      console.log(`   Store: ${config.store.name} | Slug: ${config.category.slug}`);

      // Clear stale cache so scraper starts completely fresh
      console.log(`   🗑️  Clearing stale cache...`);
      clearCategoryCache(config.store.name, config.category.slug);

      try {
        // 1. Scrape — returns products[] in memory
        const result = await scrapeCategory(config.store, config.category);
        totalScraped += result.saved;
        totalFailed  += result.failed;

        // 2. Push THIS category to Cosmos immediately
        //    CHANGE: was at the end, now per-category for crash safety
        if (result.products && result.products.length > 0) {
          const { pushed } = await pushScrapedDataToCosmos(
            result.products,
            `${config.store.name}/${config.category.slug}`
          );
          totalPushed += pushed;
        } else {
          console.log(`   ⚠️  No products returned for ${row.Category} — skipping Cosmos push`);
        }

        // 3. Update SQL timestamps so this category is marked done
        await updateScrapedTimestamps(pool, row.Category, row.freqDays);
        categoriesDone++;

      } catch (err) {
        console.error(`   ❌ Scrape failed for ${row.Category}: ${err.message}`);
        totalFailed++;
        // Continue to next category — don't abort the whole run
      }
    }

    // Map Cosmos documents → upsert into CompetitorPrices SQL table
    // Runs once at the end so all freshly pushed data is included
    if (categoriesDone > 0) {
      console.log('\n📤 Running cleanup mapper (Cosmos → SQL)...');
      await runCleanupMapper();
    } else {
      console.log('\n⚠️  No categories completed — skipping cleanup mapper');
    }

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 Scheduler done in ${totalSec}s`);
    console.log(`   Categories done  : ${categoriesDone}`);
    console.log(`   Products scraped : ${totalScraped}`);
    console.log(`   Cosmos pushed    : ${totalPushed}`);
    console.log(`   Failed           : ${totalFailed}`);

  } catch (err) {
    console.error('\n❌ Scheduler fatal error:', err.message);
    process.exit(1);
  } finally {
    if (pool) await pool.close();
  }
}

if (require.main === module) {
  runScheduler();
}

module.exports = { runScheduler };