// src/services/azureSqlService.js
// ─────────────────────────────────────────────────────────────
// CHANGE in this version:
//   - buildPriceMap now stores { price, date } where date is col_date
//   - combineData now includes LastBillDate (most recent bill date per SKU)
//     so internal_db_sync can write it to InternalProducts.
//   - sanitizeSKU is exported so callers writing back to
//     InternalProducts use the exact same SKU format that was stored.
//
// REMOVED:
//   - fetchShopifyFlagsByCategory(category) — the targeted, lightweight
//     flags-only read used by the on-demand category-filter sync has
//     been removed. That sync path no longer exists (isActive/isInStock
//     are now updated exclusively by the daily 9 AM full sync via
//     syncInternalProducts / fetchCombinedData). The `mssql` import
//     (`sql`) is also removed since this was its only user in this file.
// ─────────────────────────────────────────────────────────────

const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

const { connectWithRetry } = require('../utils/connectWithRetry');

const SERVER     = process.env.db_serverendpoint;
const DB_ZOHO    = process.env.db_zoho;
const DB_RETURNS = process.env.db_returns;
const CLIENT_ID  = process.env.db_userclientid;

if (!SERVER)     throw new Error('Missing env var: db_serverendpoint');
if (!DB_ZOHO)    throw new Error('Missing env var: db_zoho');
if (!DB_RETURNS) throw new Error('Missing env var: db_returns');

const SQL_SCOPE        = 'https://database.windows.net//.default';
const TOKEN_REFRESH_MS = 50 * 60 * 1000;

const tokenCache = {
  db_zoho_accesstoken:    { token: null, refreshTimer: null },
  db_returns_accesstoken: { token: null, refreshTimer: null },
};

function getCredential() {
  if (process.env.AZURE_ENV === 'production' && CLIENT_ID) {
    return new ManagedIdentityCredential({ clientId: CLIENT_ID });
  }
  return new AzureCliCredential();
}

async function fetchFreshToken() {
  const credential = getCredential();
  const result = await credential.getToken(SQL_SCOPE);
  return result.token;
}

function scheduleTokenRefresh(cacheKey) {
  if (tokenCache[cacheKey].refreshTimer) clearTimeout(tokenCache[cacheKey].refreshTimer);
  tokenCache[cacheKey].refreshTimer = setTimeout(async () => {
    try {
      tokenCache[cacheKey].token = await fetchFreshToken();
    } catch (err) {
      console.error(`   ⚠️ Token refresh failed: ${err.message}`);
    }
    scheduleTokenRefresh(cacheKey);
  }, TOKEN_REFRESH_MS);
}

async function getToken(cacheKey) {
  if (!tokenCache[cacheKey].token) {
    tokenCache[cacheKey].token = await fetchFreshToken();
    scheduleTokenRefresh(cacheKey);
  }
  return tokenCache[cacheKey].token;
}

function buildConfig(database, accessToken) {
  return {
    server: SERVER,
    database,
    authentication: { type: 'azure-active-directory-access-token', options: { token: accessToken } },
    options: { encrypt: true, trustServerCertificate: false, connectTimeout: 30_000 },
  };
}

async function queryDB(database, queryString, accessToken) {
  let pool;
  try {
    pool = await connectWithRetry(buildConfig(database, accessToken), { label: database });
    const result = await pool.request().query(queryString);
    return result.recordset;
  } finally {
    if (pool) await pool.close();
  }
}

function sanitizeSKU(sku) {
  if (!sku) return null;
  return sku.replace(/[^\x20-\x7E]/g, '').trim();
}

// ── Fetch purchase prices from Zoho (last 30 days) ────────────
async function fetchPurchasePrices() {
  console.log(`📡 Fetching from ${DB_ZOHO} → vw_Zoho_Bills_Data (last 30 days)...`);
  const accessToken = await getToken('db_zoho_accesstoken');
  const rows = await queryDB(
    DB_ZOHO,
    `SELECT col_Zoho_SKU, col_item_price_per_item, col_date
     FROM [dbo].[vw_Zoho_Bills_Data]
     WHERE col_status IN ('paid', 'partially_paid', 'open', 'overdue')
       AND col_Zoho_SKU IS NOT NULL
       AND col_date >= DATEADD(DAY, -30, CAST(GETDATE() AS DATE))`,
    accessToken
  );
  console.log(`   ✅ ${rows.length} rows from Zoho (≤30 days old)`);
  rows.slice(0, 5).forEach(r =>
    console.log(`      → SKU="${r.col_Zoho_SKU}" | Price=${r.col_item_price_per_item} | Date=${r.col_date}`)
  );
  return rows;
}

// ── Fetch SKUs from Shopify ───────────────────────────────────
async function fetchShopifySKUs() {
  console.log(`📡 Fetching from ${DB_RETURNS} → vw_Shopify_Product_SKUs...`);
  const accessToken = await getToken('db_returns_accesstoken');
  const rows = await queryDB(
    DB_RETURNS,
    `SELECT title, shopify_type_name, sku, brand_name, price, compare_at_price,
            is_enabled, in_stock
     FROM [dbo].[vw_Shopify_Product_SKUs]`,
    accessToken
  );
  console.log(`   ✅ ${rows.length} rows from Shopify`);
  rows.slice(0, 5).forEach(r =>
    console.log(`      → SKU="${r.sku}" | Title="${r.title}" | is_enabled=${r.is_enabled} | in_stock=${r.in_stock}`)
  );
  return rows;
}

// ── Build price map — keeps most recent entry per SKU ─────────
// Now also stores the bill date so it can be written to LastBillDate.
function buildPriceMap(zohoRows) {
  const priceMap = new Map(); // key: SKU lowercase → { price, date }

  for (const row of zohoRows) {
    const key = sanitizeSKU(row.col_Zoho_SKU || '');
    if (!key) continue;

    const normalizedKey = key.toLowerCase();
    const date = row.col_date ? new Date(row.col_date) : new Date(0);

    if (!priceMap.has(normalizedKey)) {
      priceMap.set(normalizedKey, { price: row.col_item_price_per_item, date });
    } else {
      if (date > priceMap.get(normalizedKey).date) {
        priceMap.set(normalizedKey, { price: row.col_item_price_per_item, date });
      }
    }
  }

  console.log(`   🗺️  Zoho priceMap size: ${priceMap.size} unique SKUs (last 30 days)`);
  return priceMap;
}

// ── Combine Zoho + Shopify ────────────────────────────────────
// NEW: combined rows now include LastBillDate so the sync can write it.
function combineData(zohoRows, shopifyRows) {
  const priceMap = buildPriceMap(zohoRows);
  let ppMatched = 0, ppMissed = 0, skusCleaned = 0;

  const combined = shopifyRows.map(row => {
    const rawSKU   = row.sku ?? null;
    const cleanSKU = sanitizeSKU(rawSKU);
    if (rawSKU && cleanSKU !== rawSKU) skusCleaned++;

    const key   = (cleanSKU || '').toLowerCase();
    const entry = priceMap.get(key);
    const pp    = entry ? entry.price : null;
    // Store the bill date as a plain Date (or null if no recent bill)
    const lastBillDate = entry ? entry.date : null;

    if (pp !== null) ppMatched++;
    else             ppMissed++;

    return {
      SKU_ID       : cleanSKU,
      Title        : row.title             ?? null,
      Brand        : row.brand_name        ?? null,
      Category     : row.shopify_type_name ?? null,
      SP           : row.price             ?? null,
      MRP          : row.compare_at_price  ?? null,
      PP           : pp,
      isActive     : row.is_enabled ? 1 : 0,
      isInStock    : row.in_stock   ? 1 : 0,
      LastBillDate : lastBillDate,  // NEW — DATE from most recent bill
    };
  });

  if (skusCleaned > 0) console.log(`   🧹 SKUs sanitized: ${skusCleaned}`);
  console.log(`   ✅ PP matched : ${ppMatched} | ⚠️  PP missing: ${ppMissed}`);

  if (ppMissed > 0) {
    console.log('   🔍 Sample unmatched Shopify SKUs (first 5):');
    shopifyRows
      .filter(r => !priceMap.has((sanitizeSKU(r.sku) || '').toLowerCase()))
      .slice(0, 5)
      .forEach(r => console.log(`      → SKU="${r.sku}" | Title="${r.title}"`));
  }

  return combined;
}

async function fetchCombinedData() {
  console.log('🔄 Fetching from both SQL views...');
  const zohoRows    = await fetchPurchasePrices();
  const shopifyRows = await fetchShopifySKUs();
  const combined    = combineData(zohoRows, shopifyRows);
  console.log(`✅ Combined ${combined.length} products`);
  return { zohoRows, shopifyRows, combined };
}

function clearTokenTimers() {
  for (const key of Object.keys(tokenCache)) {
    if (tokenCache[key].refreshTimer) {
      clearTimeout(tokenCache[key].refreshTimer);
      tokenCache[key].refreshTimer = null;
    }
  }
}

module.exports = {
  fetchPurchasePrices,
  fetchShopifySKUs,
  fetchCombinedData,
  clearTokenTimers,
  sanitizeSKU,
};
