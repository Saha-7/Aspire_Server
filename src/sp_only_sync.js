// src/sp_only_sync.js
// Lightweight, frequent-interval sync: pulls ONLY sku, price, is_enabled,
// in_stock from vw_Shopify_Product_SKUs and updates SP/isActive/isInStock
// on EXISTING InternalProducts rows. Deliberately does NOT touch PP,
// LastBillDate, or insert new rows — that's internal_db_sync.js's job,
// once a day, after the Zoho join. This file only exists so SP can stay
// fresh on a much tighter interval without dragging that heavier job along.

require('dotenv/config');
const sql = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');
const { connectWithRetry } = require('./utils/connectWithRetry');
const { fetchShopifySKUs, sanitizeSKU } = require('./services/azureSqlService.js');
const { log } = require('../blobLogger');

async function getTargetPool() {
  const credential = process.env.AZURE_ENV === 'production'
    ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
    : new AzureCliCredential();

  const tokenResponse = await credential.getToken('https://database.windows.net/.default');

  return await connectWithRetry({
    server  : process.env.db_serverendpoint,
    database: 'db_tpstechautomata',
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenResponse.token } },
    options : { encrypt: true, trustServerCertificate: false, requestTimeout: 60_000 },
  }, { label: 'db_tpstechautomata' });
}

function buildTVP(rows) {
  const table = new sql.Table('SPOnlyType');
  table.columns.add('SKU_ID',    sql.NVarChar(100));
  table.columns.add('SP',        sql.Decimal(10, 2));
  table.columns.add('isActive',  sql.Bit);
  table.columns.add('isInStock', sql.Bit);

  const seen = new Set();
  for (const row of rows) {
    const sku = sanitizeSKU(row.sku);
    if (!sku || seen.has(sku)) continue; // same last-write-wins dedup pattern as the main sync
    seen.add(sku);
    table.rows.add(sku, row.price ?? null, row.is_enabled ? 1 : 0, row.in_stock ? 1 : 0);
  }
  return table;
}

async function syncSPOnly() {
  const startTime = Date.now();
  log('INFO', 'sp_only_sync.js', 'syncSPOnly', 'Starting lightweight SP-only sync');

  const pool = await getTargetPool();

  const shopifyRows = await fetchShopifySKUs();
  const tvp = buildTVP(shopifyRows);

  const result = await pool.request()
    .input('tvp', tvp)
    .query(`
      MERGE InternalProducts AS target
      USING @tvp AS source
        ON target.SKU_ID = source.SKU_ID

      WHEN MATCHED AND (
        ISNULL(target.SP, -1)        <> ISNULL(source.SP, -1) OR
        ISNULL(target.isActive, -1)  <> ISNULL(source.isActive, -1) OR
        ISNULL(target.isInStock, -1) <> ISNULL(source.isInStock, -1)
      ) THEN
        UPDATE SET
          SP        = source.SP,
          isActive  = source.isActive,
          isInStock = source.isInStock,
          UpdatedAt = GETDATE();
      -- No WHEN NOT MATCHED — this job only refreshes rows that
      -- internal_db_sync.js already created. It never inserts.
    `);

  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`✅ SP-only sync done — rows changed: ${result.rowsAffected[0]}, time: ${totalSec}s`);
  log('INFO', 'sp_only_sync.js', 'syncSPOnly',
    `Rows changed: ${result.rowsAffected[0]}, Total time: ${totalSec}s`);

  await pool.close();
  return { rowsChanged: result.rowsAffected[0], totalSec };
}

module.exports = { syncSPOnly };

if (require.main === module) {
  syncSPOnly()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Fatal error:', err.message);
      log('ERROR', 'sp_only_sync.js', 'syncSPOnly', `Fatal error: ${err.message}`);
      process.exit(1);
    });
}