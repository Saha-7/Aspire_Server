// src/services/Insightsservice.js
// ─────────────────────────────────────────────────────────────
// Computes the 4 "take action" alert types and reconciles them into
// InsightAlerts. Reconciliation ALWAYS runs against the system default
// threshold (AppSettings.PRICE_ALERT_THRESHOLD) — that decides what is
// "active" and dismissable. Filters sent by the client (category, brand,
// time range, search …) only narrow what is RETURNED, never what is persisted.
//
// Alert types:
//   LOW_PRICE  — our SP is more than {threshold}% BELOW the lowest in-stock competitor price
//   HIGH_PRICE — our SP is more than {threshold}% ABOVE the lowest in-stock competitor price
//   OOS        — we're out of stock, but at least 2 competitor stores have it in stock
//   NO_LISTING — at least 2 competitor stores sell this SKU, and we have no
//                InternalProducts row for it at all
//
// NEW in this version
//   • days filter      — only alerts whose LastTriggeredAt is within the last N days
//   • getInsightCounts — one cheap GROUP BY instead of 4 full reads
//   • getInsightsExport / buildInsightsExportCsv — CSV for OOS + NO_LISTING
//   • NO_LISTING Category — resolved from CategoryMappings using
//     CompetitorPrices.StoreSlug (filled from the next scrape onwards)
//   • LastTriggeredAt now only moves when an alert is NEW, REOPENED or its value
//     actually CHANGED. Before, every recompute bumped it to "now", which made
//     both "Newest first" and any time filter meaningless.
// ─────────────────────────────────────────────────────────────

const sql = require("mssql");

const DEFAULT_THRESHOLD_PCT = 2;
const CATEGORY_DELIMITER = " | "; // one competitor slug can map to several internal categories

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

// "days" comes straight from the query string — accept only a sane integer.
function normalizeDays(days) {
  const n = parseInt(days, 10);
  if (!Number.isFinite(n) || n < 1 || n > 365) return null;
  return n;
}

const splitCategories = (value) =>
  (value || "").split(CATEGORY_DELIMITER).map((c) => c.trim()).filter(Boolean);

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
      // CurrentValue stores the diff to 2dp — compared against SnapshotValue
      // to decide "did this actually change".
      CurrentValue: `diff:${diff.toFixed(2)}`,
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
  }));
}

// ── Compute NO_LISTING candidates ─────────────────────────────
// CompetitorPrices.Category is raw text scraped off the competitor's page, so
// it is NOT used. The category comes from CategoryMappings instead, joined on
// StoreName + StoreSlug. StoreSlug is stamped by the scheduler at scrape time,
// so rows scraped before this change have none and stay "—" until their next
// scrape. If a slug maps to several internal categories, all of them are kept
// (joined with " | ") and the category filter matches any of them.
async function computeNoListingAlerts(pool) {
  const result = await pool.request().query(`
    ;WITH Unlisted AS (
      SELECT cp.SKU, cp.Name, cp.StoreName, cp.StoreSlug
      FROM CompetitorPrices cp
      WHERE NOT EXISTS (SELECT 1 FROM InternalProducts ip WHERE ip.SKU_ID = cp.SKU)
    ),
    SkuCategories AS (
      SELECT x.SKU,
             STRING_AGG(x.InternalCategory, '${CATEGORY_DELIMITER}')
               WITHIN GROUP (ORDER BY x.InternalCategory) AS Categories
      FROM (
        SELECT DISTINCT u.SKU, cm.InternalCategory
        FROM Unlisted u
        JOIN CategoryMappings cm
          ON LOWER(cm.StoreName) = LOWER(u.StoreName)
         AND LOWER(cm.StoreSlug) = LOWER(u.StoreSlug)
        WHERE u.StoreSlug IS NOT NULL
      ) x
      GROUP BY x.SKU
    )
    SELECT
      u.SKU AS SKU_ID,
      MAX(u.Name) AS Title,
      STRING_AGG(u.StoreName, ',') WITHIN GROUP (ORDER BY u.StoreName) AS ListedStores,
      COUNT(DISTINCT u.StoreName) AS StoreCount,
      MAX(sc.Categories) AS Categories
    FROM Unlisted u
    LEFT JOIN SkuCategories sc ON sc.SKU = u.SKU
    GROUP BY u.SKU
    HAVING COUNT(DISTINCT u.StoreName) >= 2
  `);

  return result.recordset.map((row) => ({
    SKU_ID: row.SKU_ID,
    Title: row.Title,
    Category: row.Categories ? String(row.Categories).slice(0, 200) : null,
    CurrentValue: `stores:${row.ListedStores}`,
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

// ── Reconcile one alert type's freshly-computed set against InsightAlerts.
// Only touches rows of THIS AlertType. ────────────────────────────────
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
                     ELSE 'active'                 -- active refresh, resolved->active, or reopen
                   END,
          CurrentValue    = source.CurrentValue,
          Category        = source.Category,
          Title           = source.Title,
          -- Only move the timestamp when something REALLY happened: the alert came
          -- back (resolved->active), was reopened (dismissed + value changed), or
          -- the value changed. A plain re-confirmation keeps the old time.
          LastTriggeredAt = CASE
                              WHEN target.Status = 'dismissed'
                                   AND target.SnapshotValue = source.CurrentValue
                                THEN target.LastTriggeredAt
                              WHEN target.Status = 'active'
                                   AND target.CurrentValue = source.CurrentValue
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

async function recomputeAndReconcileAll(pool) {
  const defaultThreshold = await getThresholdPct(pool);

  const [{ lowAlerts, highAlerts }, oosAlerts, noListingAlerts] = await Promise.all([
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

  return defaultThreshold;
}

// ── Main read entry point ──────────────────────────────────────
// skipRecompute: true = just read InsightAlerts as it stands (filter / sort /
// pagination changes). false = recompute from the latest scrape first.
async function getInsights(
  pool,
  {
    category = null,
    brand = null,          // InternalProducts.Brand (NO_LISTING alerts have no product row, so no brand)
    alertType = null,      // 'LOW_PRICE' | 'HIGH_PRICE' | 'PRICE' (both) | 'OOS' | 'NO_LISTING' | null (all)
    search = null,         // matches SKU_ID or Title, partial
    days = null,           // only alerts triggered within the last N days (null = all time)
    sortBy = "newest",     // 'newest' | 'diff'
    page = null,           // 1-based; omit page/pageSize to get everything (bell, CSV export)
    pageSize = null,
    minThresholdPct = null,
    skipRecompute = false,
  } = {},
) {
  const defaultThreshold = skipRecompute
    ? await getThresholdPct(pool)
    : await recomputeAndReconcileAll(pool);

  const request = pool.request();
  const whereClauses = [`a.Status = 'active'`];

  // category and brand are intentionally NOT filtered in SQL: each dropdown's
  // option list must be built from rows matching every OTHER filter, so they
  // are applied in JS below.
  if (alertType) {
    if (alertType === "PRICE") {
      whereClauses.push(`a.AlertType IN ('LOW_PRICE','HIGH_PRICE')`);
    } else {
      request.input("AlertType", sql.NVarChar(20), alertType);
      whereClauses.push("a.AlertType = @AlertType");
    }
  }
  if (search) {
    request.input("Search", sql.NVarChar(200), `%${search}%`);
    whereClauses.push("(a.SKU_ID LIKE @Search OR a.Title LIKE @Search)");
  }
  const safeDays = normalizeDays(days);
  if (safeDays) {
    request.input("Days", sql.Int, safeDays);
    whereClauses.push("a.LastTriggeredAt >= DATEADD(DAY, -@Days, SYSDATETIME())");
  }

  const result = await request.query(`
    SELECT a.Id, a.SKU_ID, a.AlertType, a.Category, a.Title, a.CurrentValue,
           a.FirstSeenAt, a.LastTriggeredAt, ip.Brand
    FROM InsightAlerts a
    LEFT JOIN InternalProducts ip ON ip.SKU_ID = a.SKU_ID
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY a.LastTriggeredAt DESC, a.Id DESC
  `);

  let rows = result.recordset;

  // Parse the diff once here so neither the bell nor the dashboard has to regex it.
  for (const r of rows) {
    r.DiffPercent = null;
    if (r.AlertType === "LOW_PRICE" || r.AlertType === "HIGH_PRICE") {
      const match = /diff:(-?\d+(\.\d+)?)/.exec(r.CurrentValue || "");
      if (match) r.DiffPercent = parseFloat(match[1]);
    }
  }

  if (minThresholdPct != null && !isNaN(minThresholdPct)) {
    rows = rows.filter(
      (r) => r.DiffPercent == null || Math.abs(r.DiffPercent) >= minThresholdPct,
    );
  }

  // Dropdown options. Category and Brand narrow each other; each list is
  // computed BEFORE its own filter is applied so you can still switch.
  const hasCategory = (r, c) => splitCategories(r.Category).includes(c);
  const uniqSorted = (list) =>
    [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b));

  const categories = uniqSorted(
    (brand ? rows.filter((r) => r.Brand === brand) : rows).flatMap((r) =>
      splitCategories(r.Category),
    ),
  );
  const brands = uniqSorted(
    (category ? rows.filter((r) => hasCategory(r, category)) : rows).map((r) => r.Brand),
  );

  if (category) rows = rows.filter((r) => hasCategory(r, category));
  if (brand) rows = rows.filter((r) => r.Brand === brand);

  if (sortBy === "diff") {
    rows = [...rows].sort(
      (a, b) => Math.abs(b.DiffPercent ?? 0) - Math.abs(a.DiffPercent ?? 0),
    );
  }

  const total = rows.length;

  let paged = rows;
  let totalPages = 1;
  if (pageSize) {
    totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = (Math.max(1, page || 1) - 1) * pageSize;
    paged = rows.slice(start, start + pageSize);
  }

  return {
    data: paged,
    total,
    page: page || 1,
    pageSize: pageSize || total,
    totalPages,
    categories,
    brands,
    defaultThreshold,
  };
}

// ── Tab / card counts in ONE query (replaces 4 full reads) ─────
async function getInsightCounts(pool, { days = null } = {}) {
  const request = pool.request();
  let timeClause = "";
  const safeDays = normalizeDays(days);
  if (safeDays) {
    request.input("Days", sql.Int, safeDays);
    timeClause = "AND LastTriggeredAt >= DATEADD(DAY, -@Days, SYSDATETIME())";
  }

  const [result, defaultThreshold] = await Promise.all([
    request.query(`
      SELECT AlertType, COUNT(*) AS Cnt
      FROM InsightAlerts
      WHERE Status = 'active' ${timeClause}
      GROUP BY AlertType
    `),
    getThresholdPct(pool),
  ]);

  const by = Object.fromEntries(result.recordset.map((r) => [r.AlertType, r.Cnt]));
  const price = (by.LOW_PRICE || 0) + (by.HIGH_PRICE || 0);
  const oos = by.OOS || 0;
  const listing = by.NO_LISTING || 0;

  return { all: price + oos + listing, price, oos, listing, defaultThreshold };
}

// ── CSV export (OOS + NO_LISTING) ──────────────────────────────
// Applies the same filters as the table (category, brand, search, time range),
// but returns EVERY matching row, not just the current page.
//
// One row per SKU. Because the same SKU can be sold by 2-3 competitors at
// different prices, there is one price column per competitor store, plus the
// lowest price and the number of competitors, so the sheet can be sorted/filtered.
//   OOS        → only competitors that have it IN STOCK (the stores the alert counts)
//   NO_LISTING → every competitor that lists it
// PP only exists for OOS (we have the product); for NO_LISTING it stays blank.
async function getInsightsExport(pool, { alertType, category = null, brand = null, search = null, days = null } = {}) {
  if (alertType !== "OOS" && alertType !== "NO_LISTING") {
    throw new Error("CSV export is only available for OOS and NO_LISTING alerts");
  }

  const { data: alerts } = await getInsights(pool, {
    alertType, category, brand, search, days, skipRecompute: true,
  });
  if (alerts.length === 0) return { alerts: [], stores: [] };

  const stockFilter =
    alertType === "OOS"
      ? "AND cp.StockStatus IS NOT NULL AND LOWER(cp.StockStatus) <> 'out of stock'"
      : "";

  const [priceRes, ppRes] = await Promise.all([
    pool.request().query(`
      SELECT cp.SKU, cp.StoreName, cp.CompetitorPrice
      FROM InsightAlerts a
      JOIN CompetitorPrices cp ON cp.SKU = a.SKU_ID
      WHERE a.Status = 'active' AND a.AlertType = '${alertType}' ${stockFilter}
    `),
    alertType === "OOS"
      ? pool.request().query(`
          SELECT ip.SKU_ID, ip.PP
          FROM InsightAlerts a
          JOIN InternalProducts ip ON ip.SKU_ID = a.SKU_ID
          WHERE a.Status = 'active' AND a.AlertType = 'OOS'
        `)
      : Promise.resolve({ recordset: [] }),
  ]);

  const wanted = new Set(alerts.map((a) => a.SKU_ID));
  const pricesBySku = new Map();
  const storeSet = new Set();
  for (const r of priceRes.recordset) {
    if (!wanted.has(r.SKU)) continue;
    const store = String(r.StoreName || "").toLowerCase();
    if (!pricesBySku.has(r.SKU)) pricesBySku.set(r.SKU, new Map());
    pricesBySku.get(r.SKU).set(store, r.CompetitorPrice);
    storeSet.add(store);
  }
  const ppBySku = new Map(ppRes.recordset.map((r) => [r.SKU_ID, r.PP]));

  const stores = [...storeSet].sort();
  const rows = alerts.map((a) => {
    const prices = pricesBySku.get(a.SKU_ID) || new Map();
    const numeric = [...prices.values()].filter((p) => p != null).map(Number);
    return {
      SKU: a.SKU_ID,
      Title: a.Title,
      Brand: a.Brand,
      Category: splitCategories(a.Category).join(", "),
      PP: ppBySku.get(a.SKU_ID) ?? null,
      CompetitorCount: prices.size,
      LowestCompetitorPrice: numeric.length ? Math.min(...numeric) : null,
      prices,
      AlertSince: a.LastTriggeredAt,
    };
  });

  return { alerts: rows, stores };
}

// A scraped title/SKU starting with = + - @ would run as a formula when the CSV
// is opened in Excel. Prefix those text cells with an apostrophe.
function csvCell(value, { isNumber = false } = {}) {
  if (value === null || value === undefined || value === "") return "";
  let str = value instanceof Date ? value.toISOString().replace("T", " ").slice(0, 19) : String(value);
  if (!isNumber && /^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function buildInsightsExportCsv({ alerts, stores }, alertType) {
  const header = [
    "SKU", "Title",
    ...(alertType === "OOS" ? ["Brand"] : []),
    "Category",
    ...(alertType === "OOS" ? ["PP"] : []),
    "Competitors Count", "Lowest Competitor Price",
    ...stores.map((s) => `${s} Price`),
    "Alert Since",
  ];

  const lines = [header.map((h) => csvCell(h, { isNumber: true })).join(",")];
  for (const r of alerts) {
    lines.push([
      csvCell(r.SKU), csvCell(r.Title),
      ...(alertType === "OOS" ? [csvCell(r.Brand)] : []),
      csvCell(r.Category),
      ...(alertType === "OOS" ? [csvCell(r.PP, { isNumber: true })] : []),
      csvCell(r.CompetitorCount, { isNumber: true }),
      csvCell(r.LowestCompetitorPrice, { isNumber: true }),
      ...stores.map((s) => csvCell(r.prices.get(s), { isNumber: true })),
      csvCell(r.AlertSince),
    ].join(","));
  }
  // BOM so Excel reads UTF-8 (₹, accents in titles) correctly
  return "\uFEFF" + lines.join("\r\n");
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

// ── Dismiss many alerts at once ("Dismiss selected") ──────────
async function bulkDismissInsights(pool, ids, dismissedBy) {
  if (!Array.isArray(ids) || ids.length === 0) return [];

  const request = pool.request();
  const paramNames = ids.map((id, i) => {
    const name = `Id${i}`;
    request.input(name, sql.Int, id);
    return `@${name}`;
  });
  request.input("DismissedBy", sql.NVarChar(150), dismissedBy);

  const result = await request.query(`
    UPDATE InsightAlerts
    SET Status = 'dismissed', DismissedAt = SYSDATETIME(), DismissedBy = @DismissedBy,
        SnapshotValue = CurrentValue
    OUTPUT INSERTED.Id
    WHERE Id IN (${paramNames.join(",")});
  `);
  return result.recordset.map((r) => r.Id);
}

module.exports = {
  getInsights,
  getInsightCounts,
  getInsightsExport,
  buildInsightsExportCsv,
  dismissInsight,
  bulkDismissInsights,
};




































// // src/services/insightsService.js
// // ─────────────────────────────────────────────────────────────
// // Computes the 4 "take action" alert types and reconciles them into
// // InsightAlerts (see schema.sql). Reconciliation ALWAYS runs against the
// // system default threshold (AppSettings.PRICE_ALERT_THRESHOLD) — that's
// // what decides what's "active" and dismissable. Any category/threshold
// // filters the client sends only narrow what's RETURNED, never what's
// // persisted, so a person adjusting a filter on the Insights page can
// // never make an alert vanish from someone else's dismiss history.
// //
// // Alert types:
// //   LOW_PRICE  — our SP is more than {threshold}% BELOW the lowest
// //                in-stock competitor price
// //   HIGH_PRICE — our SP is more than {threshold}% ABOVE the lowest
// //                in-stock competitor price
// //   OOS        — we're out of stock, but at least 2 competitor stores
// //                have it in stock
// //   NO_LISTING — at least 2 competitor stores sell this SKU, and we
// //                have no InternalProducts row for it at all
// //
// // All 4 only need InternalProducts + CompetitorPrices — no new source
// // tables. CompetitorPrices.Category is assumed to already be the
// // internal category name (set at scrape time from CategoryMappings /
// // per-category scrape config) — worth a quick sanity check on your
// // data before relying on it for the NO_LISTING category filter.
// // ─────────────────────────────────────────────────────────────
 
// const sql = require("mssql");
 
// const DEFAULT_THRESHOLD_PCT = 2;
 
// async function getThresholdPct(pool) {
//   try {
//     const result = await pool.request().query(`
//       SELECT SettingValue FROM AppSettings WHERE SettingKey = 'PRICE_ALERT_THRESHOLD'
//     `);
//     const raw = result.recordset[0]?.SettingValue;
//     const parsed = parseFloat(raw);
//     return isNaN(parsed) ? DEFAULT_THRESHOLD_PCT : parsed;
//   } catch {
//     return DEFAULT_THRESHOLD_PCT; // never let a settings hiccup block insights
//   }
// }
 
// // ── Compute LOW_PRICE / HIGH_PRICE candidates ─────────────────
// async function computePriceAlerts(pool, thresholdPct) {
//   const result = await pool.request().query(`
//     ;WITH LowestCompetitor AS (
//       SELECT SKU, MIN(CompetitorPrice) AS LowestCompetitorPrice
//       FROM CompetitorPrices
//       WHERE CompetitorPrice IS NOT NULL
//         AND StockStatus IS NOT NULL
//         AND LOWER(StockStatus) <> 'out of stock'
//       GROUP BY SKU
//     )
//     SELECT
//       ip.SKU_ID, ip.Title, ip.Category, ip.SP AS CurrentSP,
//       lc.LowestCompetitorPrice,
//       (ip.SP - lc.LowestCompetitorPrice) / lc.LowestCompetitorPrice * 100.0 AS DiffPercent
//     FROM InternalProducts ip
//     JOIN LowestCompetitor lc ON lc.SKU = ip.SKU_ID
//     WHERE ip.isActive = 1 AND ip.isInStock = 1 AND ip.SP IS NOT NULL
//   `);
 
//   const lowAlerts = [];
//   const highAlerts = [];
 
//   for (const row of result.recordset) {
//     const diff = parseFloat(row.DiffPercent);
//     if (isNaN(diff)) continue;
 
//     const alert = {
//       SKU_ID: row.SKU_ID,
//       Title: row.Title,
//       Category: row.Category,
//       // CurrentValue stores the diff to 2dp — this is what gets compared
//       // against SnapshotValue to decide "did this actually change".
//       CurrentValue: `diff:${diff.toFixed(2)}`,
//       _diffPercent: diff,
//       _currentSP: row.CurrentSP,
//       _lowestCompetitorPrice: row.LowestCompetitorPrice,
//     };
 
//     if (diff <= -thresholdPct) lowAlerts.push(alert);
//     else if (diff >= thresholdPct) highAlerts.push(alert);
//   }
 
//   return { lowAlerts, highAlerts };
// }
 
// // ── Compute OOS candidates ────────────────────────────────────
// async function computeOOSAlerts(pool) {
//   const result = await pool.request().query(`
//     SELECT
//       ip.SKU_ID, ip.Title, ip.Category,
//       STRING_AGG(cp.StoreName, ',') WITHIN GROUP (ORDER BY cp.StoreName) AS InStockStores,
//       COUNT(DISTINCT cp.StoreName) AS StoreCount
//     FROM InternalProducts ip
//     JOIN CompetitorPrices cp ON cp.SKU = ip.SKU_ID
//     WHERE ip.isActive = 1 AND ip.isInStock = 0
//       AND cp.StockStatus IS NOT NULL AND LOWER(cp.StockStatus) <> 'out of stock'
//     GROUP BY ip.SKU_ID, ip.Title, ip.Category
//     HAVING COUNT(DISTINCT cp.StoreName) >= 2
//   `);
 
//   return result.recordset.map((row) => ({
//     SKU_ID: row.SKU_ID,
//     Title: row.Title,
//     Category: row.Category,
//     CurrentValue: `stores:${row.InStockStores}`,
//     _inStockStores: row.InStockStores,
//     _storeCount: row.StoreCount,
//   }));
// }
 
// // ── Compute NO_LISTING candidates ─────────────────────────────
// // NOTE: Category is deliberately left null here — CompetitorPrices.Category
// // is a raw, inconsistent label scraped straight off the competitor's page
// // (not normalized against CategoryMappings), so it can't be trusted for
// // filtering/grouping. Leaving it null means these alerts simply won't match
// // a category filter (they'll only show under "All categories") until the
// // scraper pipeline is updated to carry StoreSlug through to CompetitorPrices
// // — a separate, bigger fix, deliberately deferred.
// async function computeNoListingAlerts(pool) {
//   const result = await pool.request().query(`
//     SELECT
//       cp.SKU AS SKU_ID,
//       MAX(cp.Name) AS Title,
//       STRING_AGG(cp.StoreName, ',') WITHIN GROUP (ORDER BY cp.StoreName) AS ListedStores,
//       COUNT(DISTINCT cp.StoreName) AS StoreCount
//     FROM CompetitorPrices cp
//     LEFT JOIN InternalProducts ip ON ip.SKU_ID = cp.SKU
//     WHERE ip.SKU_ID IS NULL
//     GROUP BY cp.SKU
//     HAVING COUNT(DISTINCT cp.StoreName) >= 2
//   `);
 
//   return result.recordset.map((row) => ({
//     SKU_ID: row.SKU_ID,
//     Title: row.Title,
//     Category: null, // see note above
//     CurrentValue: `stores:${row.ListedStores}`,
//     _listedStores: row.ListedStores,
//     _storeCount: row.StoreCount,
//   }));
// }
 
// // ── TVP for the reconcile MERGE ────────────────────────────────
// function buildTVP(alertType, rows) {
//   const table = new sql.Table("InsightAlertsType");
//   table.columns.add("SKU_ID", sql.NVarChar(100));
//   table.columns.add("AlertType", sql.NVarChar(20));
//   table.columns.add("Category", sql.NVarChar(200));
//   table.columns.add("Title", sql.NVarChar(500));
//   table.columns.add("CurrentValue", sql.NVarChar(200));
 
//   for (const row of rows) {
//     table.rows.add(
//       row.SKU_ID,
//       alertType,
//       row.Category ?? null,
//       row.Title ?? null,
//       row.CurrentValue ?? null,
//     );
//   }
//   return table;
// }
 
// // ── Reconcile one alert type's freshly-computed set against
// // InsightAlerts. Only touches rows of THIS AlertType — so running
// // LOW_PRICE reconciliation never marks an OOS row as resolved. ────
// async function reconcileAlertType(pool, alertType, computedRows) {
//   const tvp = buildTVP(alertType, computedRows);
 
//   await pool
//     .request()
//     .input("tvp", tvp)
//     .input("AlertType", sql.NVarChar(20), alertType).query(`
//       MERGE InsightAlerts AS target
// USING @tvp AS source
//   ON target.SKU_ID = source.SKU_ID AND target.AlertType = source.AlertType
 
// WHEN MATCHED THEN
//   UPDATE SET
//     Status = CASE
//                WHEN target.Status = 'dismissed'
//                     AND target.SnapshotValue = source.CurrentValue
//                  THEN target.Status          -- unchanged & dismissed: stay dismissed
//                ELSE 'active'                 -- otherwise: active/resolved refresh, or reopen
//              END,
//     CurrentValue    = source.CurrentValue,
//     Category        = source.Category,
//     Title           = source.Title,
//     LastTriggeredAt = CASE
//                         WHEN target.Status = 'dismissed'
//                              AND target.SnapshotValue = source.CurrentValue
//                           THEN target.LastTriggeredAt
//                         ELSE SYSDATETIME()
//                       END,
//     ResolvedAt = CASE
//                    WHEN target.Status = 'dismissed'
//                         AND target.SnapshotValue = source.CurrentValue
//                      THEN target.ResolvedAt
//                    ELSE NULL
//                  END
 
// WHEN NOT MATCHED BY TARGET THEN
//   INSERT (SKU_ID, AlertType, Category, Title, Status, CurrentValue, FirstSeenAt, LastTriggeredAt)
//   VALUES (source.SKU_ID, source.AlertType, source.Category, source.Title,
//           'active', source.CurrentValue, SYSDATETIME(), SYSDATETIME())
 
// WHEN NOT MATCHED BY SOURCE AND target.AlertType = @AlertType AND target.Status = 'active' THEN
//   UPDATE SET Status = 'resolved', ResolvedAt = SYSDATETIME();
//     `);
// }
 
// async function recomputeAndReconcileAll(pool) {
//   const defaultThreshold = await getThresholdPct(pool);
 
//   const [{ lowAlerts, highAlerts }, oosAlerts, noListingAlerts] =
//     await Promise.all([
//       computePriceAlerts(pool, defaultThreshold),
//       computeOOSAlerts(pool),
//       computeNoListingAlerts(pool),
//     ]);
 
//   // Reconcile each type independently so "WHEN NOT MATCHED BY SOURCE"
//   // only ever resolves rows of that same type.
//   await reconcileAlertType(pool, "LOW_PRICE", lowAlerts);
//   await reconcileAlertType(pool, "HIGH_PRICE", highAlerts);
//   await reconcileAlertType(pool, "OOS", oosAlerts);
//   await reconcileAlertType(pool, "NO_LISTING", noListingAlerts);
 
//   return defaultThreshold;
// }
 
// // ── Main entry point ───────────────────────────────────────────
// // skipRecompute: true means "just read InsightAlerts as it currently
// // stands" — no recompute, no MERGE. Use this for filter/sort/pagination
// // changes on the Insights dashboard, where re-running all 4 alert
// // computations on every keystroke would be wasteful. Leave it false (the
// // default) for anything that should reflect the latest scrape data, like
// // the bell's 5-minute poll or the dashboard's first load.
// async function getInsights(
//   pool,
//   {
//     category = null,
//     brand = null,            // InternalProducts.Brand (NO_LISTING alerts have no product row, so no brand)
//     alertType = null,        // 'LOW_PRICE' | 'HIGH_PRICE' | 'PRICE' (both) | 'OOS' | 'NO_LISTING' | null (all)
//     search = null,            // matches SKU_ID or Title, partial
//     sortBy = "newest",        // 'newest' | 'diff'
//     page = null,              // 1-based; omit page/pageSize entirely to get everything unpaginated (bell's usage)
//     pageSize = null,
//     minThresholdPct = null,
//     skipRecompute = false,
//   } = {},
// ) {
//   const defaultThreshold = skipRecompute
//     ? await getThresholdPct(pool)
//     : await recomputeAndReconcileAll(pool);
 
//   const request = pool.request();
//   const whereClauses = [`a.Status = 'active'`];
 
//   // NOTE: category and brand are intentionally NOT filtered in SQL. The dropdown's
//   // option list has to be built from rows that match every OTHER filter,
//   // otherwise picking a category collapses the list down to just that one
//   // category. We apply the category filter in JS further down instead.
//   if (alertType) {
//     if (alertType === "PRICE") {
//       whereClauses.push(`a.AlertType IN ('LOW_PRICE','HIGH_PRICE')`);
//     } else {
//       request.input("AlertType", sql.NVarChar(20), alertType);
//       whereClauses.push("a.AlertType = @AlertType");
//     }
//   }
//   if (search) {
//     request.input("Search", sql.NVarChar(200), `%${search}%`);
//     whereClauses.push("(a.SKU_ID LIKE @Search OR a.Title LIKE @Search)");
//   }
 
//   const result = await request.query(`
//     SELECT a.Id, a.SKU_ID, a.AlertType, a.Category, a.Title, a.CurrentValue,
//            a.FirstSeenAt, a.LastTriggeredAt, ip.Brand
//     FROM InsightAlerts a
//     LEFT JOIN InternalProducts ip ON ip.SKU_ID = a.SKU_ID
//     WHERE ${whereClauses.join(" AND ")}
//     ORDER BY a.LastTriggeredAt DESC
//   `);
 
//   let rows = result.recordset;
 
//   // Parse the diff once here so neither the bell nor the dashboard has to
//   // regex CurrentValue client-side.
//   for (const r of rows) {
//     r.DiffPercent = null;
//     if (r.AlertType === "LOW_PRICE" || r.AlertType === "HIGH_PRICE") {
//       const match = /diff:(-?\d+(\.\d+)?)/.exec(r.CurrentValue || "");
//       if (match) r.DiffPercent = parseFloat(match[1]);
//     }
//   }
 
//   if (minThresholdPct != null && !isNaN(minThresholdPct)) {
//     rows = rows.filter(
//       (r) => r.DiffPercent == null || Math.abs(r.DiffPercent) >= minThresholdPct,
//     );
//   }
 
//   // Dropdown options. Category and Brand narrow each other: the category list
//   // only shows categories that have alerts for the selected brand, and the
//   // brand list only shows brands that have alerts in the selected category.
//   // Each list is computed BEFORE its own filter is applied, so it stays
//   // complete (you can still switch) while a value is selected.
//   const uniqSorted = (list) => [...new Set(list.filter(Boolean))].sort((a, b) => a.localeCompare(b));
//   const categories = uniqSorted(
//     (brand ? rows.filter((r) => r.Brand === brand) : rows).map((r) => r.Category),
//   );
//   const brands = uniqSorted(
//     (category ? rows.filter((r) => r.Category === category) : rows).map((r) => r.Brand),
//   );

//   if (category) {
//     rows = rows.filter((r) => r.Category === category);
//   }
//   if (brand) {
//     rows = rows.filter((r) => r.Brand === brand);
//   }
 
//   if (sortBy === "diff") {
//     rows = [...rows].sort(
//       (a, b) => Math.abs(b.DiffPercent ?? 0) - Math.abs(a.DiffPercent ?? 0),
//     );
//   }
 
//   const total = rows.length;
 
//   let paged = rows;
//   let totalPages = 1;
//   if (pageSize) {
//     totalPages = Math.max(1, Math.ceil(total / pageSize));
//     const start = (Math.max(1, page || 1) - 1) * pageSize;
//     paged = rows.slice(start, start + pageSize);
//   }
 
//   return {
//     data: paged,
//     total,
//     page: page || 1,
//     pageSize: pageSize || total,
//     totalPages,
//     categories,
//     brands,
//     defaultThreshold,
//   };
// }
 
// // ── Dismiss one alert ──────────────────────────────────────────
// async function dismissInsight(pool, id, dismissedBy) {
//   const result = await pool
//     .request()
//     .input("Id", sql.Int, id)
//     .input("DismissedBy", sql.NVarChar(150), dismissedBy).query(`
//       UPDATE InsightAlerts
//       SET Status = 'dismissed', DismissedAt = SYSDATETIME(), DismissedBy = @DismissedBy,
//           SnapshotValue = CurrentValue
//       OUTPUT INSERTED.Id, INSERTED.SKU_ID, INSERTED.AlertType, INSERTED.Status
//       WHERE Id = @Id;
//     `);
//   return result.recordset[0] || null;
// }
 
// // ── Dismiss many alerts at once (the dashboard's "Dismiss selected") ──
// async function bulkDismissInsights(pool, ids, dismissedBy) {
//   if (!Array.isArray(ids) || ids.length === 0) return [];
 
//   const request = pool.request();
//   const paramNames = ids.map((id, i) => {
//     const name = `Id${i}`;
//     request.input(name, sql.Int, id);
//     return `@${name}`;
//   });
//   request.input("DismissedBy", sql.NVarChar(150), dismissedBy);
 
//   const result = await request.query(`
//     UPDATE InsightAlerts
//     SET Status = 'dismissed', DismissedAt = SYSDATETIME(), DismissedBy = @DismissedBy,
//         SnapshotValue = CurrentValue
//     OUTPUT INSERTED.Id
//     WHERE Id IN (${paramNames.join(",")});
//   `);
//   return result.recordset.map((r) => r.Id);
// }
 
// module.exports = { getInsights, dismissInsight, bulkDismissInsights };