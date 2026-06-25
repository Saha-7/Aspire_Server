// src/services/scrapeStatsService.js
const sql = require('mssql');
const { extractSkuAndStock, cleanSku } = require('./competitorPriceService');

function isInStock(stockStatus) {
  if (!stockStatus) return false;
  return stockStatus.toLowerCase().trim() !== 'out of stock';
}

function normalizeSkuKey(sku) {
  return sku ? sku.trim().toUpperCase() : null;
}

async function loadInternalSkuSets(pool) {
  const result = await pool.request().query(`
    SELECT SKU_ID, PP, isActive, isInStock
    FROM InternalProducts
    WHERE SKU_ID IS NOT NULL
  `);

  const allSkuSet      = new Set();
  const eligibleSkuSet = new Set();

  for (const row of result.recordset) {
    const key = normalizeSkuKey(row.SKU_ID);
    if (!key) continue;
    allSkuSet.add(key);
    if (row.PP != null && row.isActive === 1 && row.isInStock === 1) {
      eligibleSkuSet.add(key);
    }
  }

  return { allSkuSet, eligibleSkuSet };
}

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

    if (!stockStatus) stats.OutOfStockNullCount++;
    else if (competitorInStock) stats.InStockCount++;
    else stats.OutOfStockCount++;

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

module.exports = {
  loadInternalSkuSets,
  computeStatsForBatch,
  saveRunStats,
  getRecentRuns,
  getRunDetail,
};