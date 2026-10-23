// src/services/scrapeStatsService.js
// ─────────────────────────────────────────────────────────────
// Computes per-store/category scrape diagnostics (matched / unmatched /
// out-of-stock breakdown) right after a scrape, and persists ONE
// aggregate row per {run, store, category} to ScrapeRunStats.
//
// Why aggregate rows, not raw product rows:
//   A few rows per run (one per store/slug) costs nothing to keep
//   forever, so "recent vs. history" isn't a tradeoff — the stats page
//   can default to the latest run and still let you pick any older one.
//
// Matching definitions (Pritam's call — show both side by side):
//   MatchedSimple : cleaned SKU exists ANYWHERE in InternalProducts.SKU_ID
//   MatchedStrict : same SKU, but the internal row ALSO has to pass the
//                   exact criteria recommendation_engine.js uses
//                   (PP IS NOT NULL AND isActive=1 AND isInStock=1),
//                   AND the scraped competitor row itself has to be in stock.
//   This is what actually explains "600 scraped, 2 matched" — the gap
//   between MatchedSimple and MatchedStrict is the recommendation
//   engine's filters, not a scraping problem.
// ─────────────────────────────────────────────────────────────

const sql = require('mssql');
const { extractSkuAndStock, cleanSku } = require('./competitorPriceService');

// ── Same in-stock rule as recommendation_engine.js — kept identical
// on purpose so the strict count here always matches what the engine
// would actually do with this data. ────────────────────────────────
function isInStock(stockStatus) {
  if (!stockStatus) return false;
  return stockStatus.toLowerCase().trim() !== 'out of stock';
}

function normalizeSkuKey(sku) {
  return sku ? sku.trim().toUpperCase() : null;
}

// ── mssql/tedious returns SQL BIT columns as JS boolean (true/false),
// not the integer 1/0. Comparing that directly with `=== 1` is always
// false, which silently broke eligibleSkuSet for every SKU. Coerce
// here, once, so every BIT-flavored value downstream is a real boolean
// regardless of whether the driver handed us true/false or 1/0. ──────
function toBool(value) {
  return value === true || value === 1;
}

// ── Step 1: load the two internal SKU sets ONCE per run, reused
// across every store/category in that run. detailsBySku additionally
// carries PP/isActive/isInStock per SKU, needed to explain WHY a
// matched SKU isn't Recommendation-Ready (the Reason column in the CSV). ─
async function loadInternalSkuSets(pool) {
  const result = await pool.request().query(`
    SELECT SKU_ID, PP, isActive, isInStock
    FROM InternalProducts
    WHERE SKU_ID IS NOT NULL
  `);

  const allSkuSet      = new Set(); // every known internal SKU, any state
  const eligibleSkuSet = new Set(); // PP set + active + in stock (recommendation-engine eligible)
  const detailsBySku   = new Map(); // key -> { PP, isActive, isInStock } — for Reason column

  for (const row of result.recordset) {
    const key = normalizeSkuKey(row.SKU_ID);
    if (!key) continue;

    const isActive  = toBool(row.isActive);
    const isInStock = toBool(row.isInStock);

    allSkuSet.add(key);
    detailsBySku.set(key, { PP: row.PP, isActive, isInStock });
    if (row.PP != null && isActive && isInStock) {
      eligibleSkuSet.add(key);
    }
  }

  return { allSkuSet, eligibleSkuSet, detailsBySku };
}

// ── Step 2: compute one stats row for a single store/category batch
// of raw scraped products (call this BEFORE Cosmos push — works on
// result.products directly, same shape mapProduct() expects). ──────
function computeStatsForBatch(products, { allSkuSet, eligibleSkuSet }) {
  const stats = {
    TotalScraped       : products.length,
    NullOrEmptySku     : 0,
    SkuNoInternalMatch : 0,
    MatchedSimple      : 0,
    MatchedStrict      : 0,
    InStockCount       : 0,
    OutOfStockCount    : 0,
    OutOfStockNullCount: 0,
  };

  for (const product of products) {
    const { sku, stockStatus } = extractSkuAndStock(product);
    const key = normalizeSkuKey(sku);
    const competitorInStock = isInStock(stockStatus);

    // ── Stock bucket (independent of matching) ──────────────────
    if (!stockStatus) stats.OutOfStockNullCount++;
    else if (competitorInStock) stats.InStockCount++;
    else stats.OutOfStockCount++;

    // ── Matching bucket ──────────────────────────────────────────
    if (!key) {
      stats.NullOrEmptySku++;
      continue;
    }

    if (!allSkuSet.has(key)) {
      stats.SkuNoInternalMatch++;
      continue;
    }

    stats.MatchedSimple++;

    if (competitorInStock && eligibleSkuSet.has(key)) {
      stats.MatchedStrict++;
    }
  }

  return stats;
}

// ── Step 2b: per-SKU rows for the CSV export — now ALL scraped
// products are included, not just matched ones. Manager wants visibility
// into "No SKU Match" too, so instead of silently dropping unmatched
// rows, they get their own MatchStatus value and a plain-English reason:
//   "No SKU"        : competitor product had no SKU at all on the page
//   "No SKU Match"  : competitor SKU exists, but isn't in InternalProducts
//   "Basic Match" / "Recommendation Match" : unchanged, as before
// Same table, same CSV, same Match Status column — just no longer
// pre-filtered before it reaches Pritam/manager. ─────────────────────
function collectMatchedSkuRows(products, { allSkuSet, eligibleSkuSet, detailsBySku }, context) {
  const rows = [];

  for (const product of products) {
    const { sku, stockStatus, competitorPrice, productUrl, scrapedAt } = extractSkuAndStock(product);
    const key = normalizeSkuKey(sku);
    const shared = { competitorPrice, competitorStockStatus: stockStatus, productUrl, scrapedAt };

    if (!key) {
      rows.push({
        runId: context.runId, runStartedAt: context.runStartedAt,
        storeName: context.storeName, storeSlug: context.storeSlug, categoryNames: context.categoryNames,
        sku: (sku || '').trim() || '(no SKU)',
        matchStatus: 'No SKU', reason: 'Competitor product has no SKU',
        pp: null, isActive: null, isInStock: null, ...shared,
      });
      continue;
    }

    if (!allSkuSet.has(key)) {
      rows.push({
        runId: context.runId, runStartedAt: context.runStartedAt,
        storeName: context.storeName, storeSlug: context.storeSlug, categoryNames: context.categoryNames,
        sku: sku.trim(),
        matchStatus: 'No SKU Match', reason: 'SKU not found in InternalProducts',
        pp: null, isActive: null, isInStock: null, ...shared,
      });
      continue;
    }

    const competitorInStock = isInStock(stockStatus);
    const internal = detailsBySku.get(key) || {};
    const strictPass = competitorInStock && eligibleSkuSet.has(key);

    let reasons = [];
    if (!strictPass) {
      if (!competitorInStock) reasons.push('Competitor out of stock');
      if (!internal.isActive)  reasons.push('Internal product inactive');
      if (!internal.isInStock) reasons.push('Internal product marked out of stock');
      if (internal.PP == null) reasons.push('Purchase Price not set');
    }

    rows.push({
      runId: context.runId, runStartedAt: context.runStartedAt,
      storeName: context.storeName, storeSlug: context.storeSlug, categoryNames: context.categoryNames,
      sku: sku.trim(),
      matchStatus: strictPass ? 'Recommendation Match' : 'Basic Match',
      reason: reasons.join('; ') || null,
      pp: internal.PP ?? null,
      isActive: internal.isActive ?? null,
      isInStock: internal.isInStock ?? null,
      ...shared,
    });
  }

  return rows;
}

// ── Step 3: persist one row per store/category for this run ────────
async function saveRunStats(pool, rows) {
  for (const row of rows) {
    await pool.request()
      .input('RunId',               sql.NVarChar(36),  row.runId)
      .input('RunStartedAt',        sql.DateTime2,     row.runStartedAt)
      .input('StartedBy',           sql.NVarChar(200), row.startedBy || null)
      .input('StoreName',           sql.NVarChar(100), row.storeName)
      .input('StoreSlug',           sql.NVarChar(100), row.storeSlug)
      .input('CategoryNames',       sql.NVarChar(500), (row.categoryNames || []).join(', '))
      .input('Status',              sql.NVarChar(20),  row.status || 'ok')
      .input('ErrorMessage',        sql.NVarChar(sql.MAX), row.errorMessage || null)
      .input('TotalScraped',        sql.Int, row.stats?.TotalScraped        ?? 0)
      .input('NullOrEmptySku',      sql.Int, row.stats?.NullOrEmptySku      ?? 0)
      .input('SkuNoInternalMatch',  sql.Int, row.stats?.SkuNoInternalMatch  ?? 0)
      .input('MatchedSimple',       sql.Int, row.stats?.MatchedSimple       ?? 0)
      .input('MatchedStrict',       sql.Int, row.stats?.MatchedStrict       ?? 0)
      .input('InStockCount',        sql.Int, row.stats?.InStockCount        ?? 0)
      .input('OutOfStockCount',     sql.Int, row.stats?.OutOfStockCount     ?? 0)
      .input('OutOfStockNullCount', sql.Int, row.stats?.OutOfStockNullCount ?? 0)
      .query(`
        INSERT INTO ScrapeRunStats (
          RunId, RunStartedAt, StartedBy, StoreName, StoreSlug, CategoryNames,
          Status, ErrorMessage, TotalScraped, NullOrEmptySku, SkuNoInternalMatch,
          MatchedSimple, MatchedStrict, InStockCount, OutOfStockCount, OutOfStockNullCount
        ) VALUES (
          @RunId, @RunStartedAt, @StartedBy, @StoreName, @StoreSlug, @CategoryNames,
          @Status, @ErrorMessage, @TotalScraped, @NullOrEmptySku, @SkuNoInternalMatch,
          @MatchedSimple, @MatchedStrict, @InStockCount, @OutOfStockCount, @OutOfStockNullCount
        )
      `);
  }
}

// ── Read: list recent runs (one entry per RunId, totals rolled up) ──
async function getRecentRuns(pool, limit = 25) {
  const result = await pool.request()
    .input('Limit', sql.Int, limit)
    .query(`
      SELECT TOP (@Limit)
        RunId,
        MIN(RunStartedAt)        AS RunStartedAt,
        MAX(StartedBy)           AS StartedBy,
        COUNT(*)                 AS StoreCategoryCount,
        SUM(TotalScraped)        AS TotalScraped,
        SUM(MatchedStrict)       AS MatchedStrict,
        SUM(MatchedSimple)       AS MatchedSimple,
        SUM(CASE WHEN Status = 'error' THEN 1 ELSE 0 END) AS ErrorCount
      FROM ScrapeRunStats
      GROUP BY RunId
      ORDER BY MIN(RunStartedAt) DESC
    `);
  return result.recordset;
}

// ── Read: detail rows for one run (or the latest run if 'latest') ──
async function getRunDetail(pool, runId) {
  if (runId === 'latest') {
    const latest = await pool.request().query(`
      SELECT TOP 1 RunId FROM ScrapeRunStats ORDER BY RunStartedAt DESC
    `);
    if (!latest.recordset.length) return { runId: null, rows: [] };
    runId = latest.recordset[0].RunId;
  }

  const result = await pool.request()
    .input('RunId', sql.NVarChar(36), runId)
    .query(`
      SELECT *
      FROM ScrapeRunStats
      WHERE RunId = @RunId
      ORDER BY StoreName, StoreSlug
    `);

  return { runId, rows: result.recordset };
}

// ── Step 3b: persist matched-SKU rows. Now includes No SKU / No SKU
// Match rows too (see collectMatchedSkuRows above), so volume per run
// is closer to TotalScraped than the old "matched only" subset — keep
// an eye on table growth if this is run frequently across many stores. ──
async function saveSkuMatchRows(pool, rows) {
  for (const row of rows) {
    await pool.request()
      .input('RunId',                sql.NVarChar(36),  row.runId)
      .input('RunStartedAt',         sql.DateTime2,     row.runStartedAt)
      .input('StoreName',            sql.NVarChar(100), row.storeName)
      .input('StoreSlug',            sql.NVarChar(100), row.storeSlug)
      .input('CategoryNames',        sql.NVarChar(500), (row.categoryNames || []).join(', '))
      .input('SKU',                  sql.NVarChar(100), row.sku)
      .input('MatchStatus',          sql.NVarChar(30),  row.matchStatus)
      .input('Reason',               sql.NVarChar(500), row.reason || null)
      .input('PP',                   sql.Decimal(10,2), row.pp ?? null)
      .input('IsActive',             sql.Bit,           row.isActive ?? null)
      .input('IsInStock',            sql.Bit,           row.isInStock ?? null)
      .input('CompetitorPrice',      sql.Decimal(10,2), row.competitorPrice ?? null)
      .input('CompetitorStockStatus',sql.NVarChar(50),  row.competitorStockStatus || null)
      .input('ProductURL',           sql.NVarChar(500), row.productUrl || null)
      .input('ScrapedAt',            sql.NVarChar(50),  row.scrapedAt || null)
      .query(`
        INSERT INTO ScrapeRunSkuMatches (
          RunId, RunStartedAt, StoreName, StoreSlug, CategoryNames, SKU, MatchStatus, Reason,
          PP, IsActive, IsInStock, CompetitorPrice, CompetitorStockStatus, ProductURL, ScrapedAt
        ) VALUES (
          @RunId, @RunStartedAt, @StoreName, @StoreSlug, @CategoryNames, @SKU, @MatchStatus, @Reason,
          @PP, @IsActive, @IsInStock, @CompetitorPrice, @CompetitorStockStatus, @ProductURL, @ScrapedAt
        )
      `);
  }
}

// ── Read: matched-SKU rows for one run (or 'latest') ────────────────
async function getRunSkuMatches(pool, runId) {
  if (runId === 'latest') {
    const latest = await pool.request().query(`
      SELECT TOP 1 RunId FROM ScrapeRunSkuMatches ORDER BY RunStartedAt DESC
    `);
    if (!latest.recordset.length) return { runId: null, rows: [] };
    runId = latest.recordset[0].RunId;
  }

  const result = await pool.request()
    .input('RunId', sql.NVarChar(36), runId)
    .query(`
      SELECT *
      FROM ScrapeRunSkuMatches
      WHERE RunId = @RunId
      ORDER BY StoreName, StoreSlug, SKU
    `);

  return { runId, rows: result.recordset };
}

// ── CSV builder — escapes commas/quotes/newlines per RFC 4180 ───────
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function boolLabel(v) {
  if (v === null || v === undefined) return '';
  return (v === true || v === 1) ? 'Yes' : 'No';
}

function buildSkuMatchesCsv(rows) {
  const header = [
    'SKU', 'Competitor Store Name', 'Competitor Category Name', 'TPSTECH Category Name',
    'Match Status', 'Reason',
    'Internal PP', 'Internal Active', 'Internal In Stock',
    'Competitor Price', 'Competitor Stock Status', 'Scraped At', 'Product URL',
  ];
  const lines = [header.join(',')];

  for (const row of rows) {
    lines.push([
      csvEscape(row.SKU), csvEscape(row.StoreName), csvEscape(row.StoreSlug), csvEscape(row.CategoryNames),
      csvEscape(row.MatchStatus), csvEscape(row.Reason),
      csvEscape(row.PP), csvEscape(boolLabel(row.IsActive)), csvEscape(boolLabel(row.IsInStock)),
      csvEscape(row.CompetitorPrice), csvEscape(row.CompetitorStockStatus),
      csvEscape(row.ScrapedAt), csvEscape(row.ProductURL),
    ].join(','));
  }

  return lines.join('\r\n');
}

module.exports = {
  loadInternalSkuSets,
  computeStatsForBatch,
  collectMatchedSkuRows,
  saveRunStats,
  saveSkuMatchRows,
  getRecentRuns,
  getRunDetail,
  getRunSkuMatches,
  buildSkuMatchesCsv,
};