// src/services/insightsService.js
// ─────────────────────────────────────────────────────────────
// Computes the 4 "take action" alert types and reconciles them into
// InsightAlerts (see schema.sql). Reconciliation ALWAYS runs against the
// system default threshold (AppSettings.PRICE_ALERT_THRESHOLD) — that's
// what decides what's "active" and dismissable. Any category/threshold
// filters the client sends only narrow what's RETURNED, never what's
// persisted, so a person adjusting a filter on the Insights page can
// never make an alert vanish from someone else's dismiss history.
//
// Alert types:
//   LOW_PRICE  — our SP is more than {threshold}% BELOW the lowest
//                in-stock competitor price
//   HIGH_PRICE — our SP is more than {threshold}% ABOVE the lowest
//                in-stock competitor price
//   OOS        — we're out of stock, but at least 2 competitor stores
//                have it in stock
//   NO_LISTING — at least 2 competitor stores sell this SKU, and we
//                have no InternalProducts row for it at all
//
// All 4 only need InternalProducts + CompetitorPrices — no new source
// tables. CompetitorPrices.Category is assumed to already be the
// internal category name (set at scrape time from CategoryMappings /
// per-category scrape config) — worth a quick sanity check on your
// data before relying on it for the NO_LISTING category filter.
// ─────────────────────────────────────────────────────────────

const sql = require("mssql");

const DEFAULT_THRESHOLD_PCT = 2;

async function getThresholdPct(pool) {
  try {
    const result = await pool.request().query(`
      SELECT SettingValue FROM AppSettings WHERE SettingKey = 'PRICE_ALERT_THRESHOLD'
    `);
    const raw = result.recordset[0]?.SettingValue;
    const parsed = parseFloat(raw);
    return isNaN(parsed) ? DEFAULT_THRESHOLD_PCT : parsed;
  } catch {
    return DEFAULT_THRESHOLD_PCT; // never let a settings hiccup block insights
  }
}

// ── Compute LOW_PRICE / HIGH_PRICE candidates ─────────────────
async function computePriceAlerts(pool, thresholdPct) {
  const result = await pool.request().query(`
    ;WITH LowestCompetitor AS (
      SELECT SKU, MIN(CompetitorPrice) AS LowestCompetitorPrice
      FROM CompetitorPrices
      WHERE CompetitorPrice IS NOT NULL
        AND StockStatus IS NOT NULL
        AND LOWER(StockStatus) <> 'out of stock'
      GROUP BY SKU
    )
    SELECT
      ip.SKU_ID, ip.Title, ip.Category, ip.SP AS CurrentSP,
      lc.LowestCompetitorPrice,
      (ip.SP - lc.LowestCompetitorPrice) / lc.LowestCompetitorPrice * 100.0 AS DiffPercent
    FROM InternalProducts ip
    JOIN LowestCompetitor lc ON lc.SKU = ip.SKU_ID
    WHERE ip.isActive = 1 AND ip.isInStock = 1 AND ip.SP IS NOT NULL
  `);

  const lowAlerts = [];
  const highAlerts = [];

  for (const row of result.recordset) {
    const diff = parseFloat(row.DiffPercent);
    if (isNaN(diff)) continue;

    const alert = {
      SKU_ID: row.SKU_ID,
      Title: row.Title,
      Category: row.Category,
      // CurrentValue stores the diff to 2dp — this is what gets compared
      // against SnapshotValue to decide "did this actually change".
      CurrentValue: `diff:${diff.toFixed(2)}`,
      _diffPercent: diff,
      _currentSP: row.CurrentSP,
      _lowestCompetitorPrice: row.LowestCompetitorPrice,
    };

    if (diff <= -thresholdPct) lowAlerts.push(alert);
    else if (diff >= thresholdPct) highAlerts.push(alert);
  }

  return { lowAlerts, highAlerts };
}

// ── Compute OOS candidates ────────────────────────────────────
async function computeOOSAlerts(pool) {
  const result = await pool.request().query(`
    SELECT
      ip.SKU_ID, ip.Title, ip.Category,
      STRING_AGG(cp.StoreName, ',') WITHIN GROUP (ORDER BY cp.StoreName) AS InStockStores,
      COUNT(DISTINCT cp.StoreName) AS StoreCount
    FROM InternalProducts ip
    JOIN CompetitorPrices cp ON cp.SKU = ip.SKU_ID
    WHERE ip.isActive = 1 AND ip.isInStock = 0
      AND cp.StockStatus IS NOT NULL AND LOWER(cp.StockStatus) <> 'out of stock'
    GROUP BY ip.SKU_ID, ip.Title, ip.Category
    HAVING COUNT(DISTINCT cp.StoreName) >= 2
  `);

  return result.recordset.map((row) => ({
    SKU_ID: row.SKU_ID,
    Title: row.Title,
    Category: row.Category,
    CurrentValue: `stores:${row.InStockStores}`,
    _inStockStores: row.InStockStores,
    _storeCount: row.StoreCount,
  }));
}

// ── Compute NO_LISTING candidates ─────────────────────────────
// NOTE: Category is deliberately left null here — CompetitorPrices.Category
// is a raw, inconsistent label scraped straight off the competitor's page
// (not normalized against CategoryMappings), so it can't be trusted for
// filtering/grouping. Leaving it null means these alerts simply won't match
// a category filter (they'll only show under "All categories") until the
// scraper pipeline is updated to carry StoreSlug through to CompetitorPrices
// — a separate, bigger fix, deliberately deferred.
async function computeNoListingAlerts(pool) {
  const result = await pool.request().query(`
    SELECT
      cp.SKU AS SKU_ID,
      MAX(cp.Name) AS Title,
      STRING_AGG(cp.StoreName, ',') WITHIN GROUP (ORDER BY cp.StoreName) AS ListedStores,
      COUNT(DISTINCT cp.StoreName) AS StoreCount
    FROM CompetitorPrices cp
    LEFT JOIN InternalProducts ip ON ip.SKU_ID = cp.SKU
    WHERE ip.SKU_ID IS NULL
    GROUP BY cp.SKU
    HAVING COUNT(DISTINCT cp.StoreName) >= 2
  `);

  return result.recordset.map((row) => ({
    SKU_ID: row.SKU_ID,
    Title: row.Title,
    Category: null, // see note above
    CurrentValue: `stores:${row.ListedStores}`,
    _listedStores: row.ListedStores,
    _storeCount: row.StoreCount,
  }));
}

// ── TVP for the reconcile MERGE ────────────────────────────────
function buildTVP(alertType, rows) {
  const table = new sql.Table("InsightAlertsType");
  table.columns.add("SKU_ID", sql.NVarChar(100));
  table.columns.add("AlertType", sql.NVarChar(20));
  table.columns.add("Category", sql.NVarChar(200));
  table.columns.add("Title", sql.NVarChar(500));
  table.columns.add("CurrentValue", sql.NVarChar(200));

  for (const row of rows) {
    table.rows.add(
      row.SKU_ID,
      alertType,
      row.Category ?? null,
      row.Title ?? null,
      row.CurrentValue ?? null,
    );
  }
  return table;
}

// ── Reconcile one alert type's freshly-computed set against
// InsightAlerts. Only touches rows of THIS AlertType — so running
// LOW_PRICE reconciliation never marks an OOS row as resolved. ────
async function reconcileAlertType(pool, alertType, computedRows) {
  const tvp = buildTVP(alertType, computedRows);

  await pool
    .request()
    .input("tvp", tvp)
    .input("AlertType", sql.NVarChar(20), alertType).query(`
      MERGE InsightAlerts AS target
USING @tvp AS source
  ON target.SKU_ID = source.SKU_ID AND target.AlertType = source.AlertType

WHEN MATCHED THEN
  UPDATE SET
    Status = CASE
               WHEN target.Status = 'dismissed'
                    AND target.SnapshotValue = source.CurrentValue
                 THEN target.Status          -- unchanged & dismissed: stay dismissed
               ELSE 'active'                 -- otherwise: active/resolved refresh, or reopen
             END,
    CurrentValue    = source.CurrentValue,
    Category        = source.Category,
    Title           = source.Title,
    LastTriggeredAt = CASE
                        WHEN target.Status = 'dismissed'
                             AND target.SnapshotValue = source.CurrentValue
                          THEN target.LastTriggeredAt
                        ELSE SYSDATETIME()
                      END,
    ResolvedAt = CASE
                   WHEN target.Status = 'dismissed'
                        AND target.SnapshotValue = source.CurrentValue
                     THEN target.ResolvedAt
                   ELSE NULL
                 END

WHEN NOT MATCHED BY TARGET THEN
  INSERT (SKU_ID, AlertType, Category, Title, Status, CurrentValue, FirstSeenAt, LastTriggeredAt)
  VALUES (source.SKU_ID, source.AlertType, source.Category, source.Title,
          'active', source.CurrentValue, SYSDATETIME(), SYSDATETIME())

WHEN NOT MATCHED BY SOURCE AND target.AlertType = @AlertType AND target.Status = 'active' THEN
  UPDATE SET Status = 'resolved', ResolvedAt = SYSDATETIME();
    `);
}

// ── Main entry point — recompute + reconcile all 4 types,
// then return the current active set (optionally filtered). ────
async function getInsights(
  pool,
  { category = null, minThresholdPct = null } = {},
) {
  const defaultThreshold = await getThresholdPct(pool);

  const [{ lowAlerts, highAlerts }, oosAlerts, noListingAlerts] =
    await Promise.all([
      computePriceAlerts(pool, defaultThreshold),
      computeOOSAlerts(pool),
      computeNoListingAlerts(pool),
    ]);

  // Reconcile each type independently so "WHEN NOT MATCHED BY SOURCE"
  // only ever resolves rows of that same type.
  await reconcileAlertType(pool, "LOW_PRICE", lowAlerts);
  await reconcileAlertType(pool, "HIGH_PRICE", highAlerts);
  await reconcileAlertType(pool, "OOS", oosAlerts);
  await reconcileAlertType(pool, "NO_LISTING", noListingAlerts);

  // Now read back the current active set. category/minThresholdPct only
  // filter what's displayed — minThresholdPct can only narrow ABOVE the
  // stored default (you can't see below-2% alerts this way, since those
  // were never computed as "active" in the first place).
  const request = pool.request();
  let whereClauses = [`Status = 'active'`];

  if (category) {
    request.input("Category", sql.NVarChar(200), category);
    whereClauses.push("Category = @Category");
  }

  const result = await request.query(`
    SELECT Id, SKU_ID, AlertType, Category, Title, CurrentValue,
           FirstSeenAt, LastTriggeredAt
    FROM InsightAlerts
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY LastTriggeredAt DESC
  `);

  let rows = result.recordset;

  if (minThresholdPct != null && !isNaN(minThresholdPct)) {
    rows = rows.filter((r) => {
      if (r.AlertType !== "LOW_PRICE" && r.AlertType !== "HIGH_PRICE")
        return true; // OOS/NO_LISTING unaffected
      const match = /diff:(-?\d+(\.\d+)?)/.exec(r.CurrentValue || "");
      if (!match) return true;
      return Math.abs(parseFloat(match[1])) >= minThresholdPct;
    });
  }

  return { data: rows, total: rows.length, defaultThreshold };
}

// ── Dismiss one alert ──────────────────────────────────────────
async function dismissInsight(pool, id, dismissedBy) {
  const result = await pool
    .request()
    .input("Id", sql.Int, id)
    .input("DismissedBy", sql.NVarChar(150), dismissedBy).query(`
      UPDATE InsightAlerts
      SET Status = 'dismissed', DismissedAt = SYSDATETIME(), DismissedBy = @DismissedBy,
          SnapshotValue = CurrentValue
      OUTPUT INSERTED.Id, INSERTED.SKU_ID, INSERTED.AlertType, INSERTED.Status
      WHERE Id = @Id;
    `);
  return result.recordset[0] || null;
}

module.exports = { getInsights, dismissInsight };
