// src/internal_db_sync.js
// CHANGE: TVP + MERGE now includes LastBillDate column.
// ManualPP_UpdatedAt / ManualPP_UpdatedBy are NEVER touched here —
// those are owned exclusively by the manual PP update API.

require('dotenv/config');
const sql = require('mssql');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');
const { connectWithRetry } = require('./utils/connectWithRetry'); // add near top requires
const { fetchCombinedData, clearTokenTimers } = require('./services/azureSqlService.js');

// ─────────────────────────────────────────────────────────────
async function getTargetPool() {
  const credential = process.env.AZURE_ENV === 'production'
    ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
    : new AzureCliCredential();

  const tokenResponse = await credential.getToken('https://database.windows.net/.default');

  return await connectWithRetry({
    server  : process.env.db_serverendpoint,
    database: 'db_tpstechautomata',
    authentication: { type: 'azure-active-directory-access-token', options: { token: tokenResponse.token } },
    options : { encrypt: true, trustServerCertificate: false, requestTimeout: 120_000 },
  }, { label: 'db_tpstechautomata' });
}

// ── TVP — now includes LastBillDate ───────────────────────────
function buildTVP(rows) {
  const table = new sql.Table('InternalProductsType');
  table.columns.add('SKU_ID',       sql.NVarChar(100));
  table.columns.add('Title',        sql.NVarChar(500));
  table.columns.add('Brand',        sql.NVarChar(200));
  table.columns.add('Category',     sql.NVarChar(200));
  table.columns.add('PP',           sql.Decimal(10, 2));
  table.columns.add('SP',           sql.Decimal(10, 2));
  table.columns.add('isActive',     sql.Bit);
  table.columns.add('isInStock',    sql.Bit);
  table.columns.add('LastBillDate', sql.Date);   // NEW

  rows.forEach((row) => {
    table.rows.add(
      row.SKU_ID       ?? null,
      row.Title        ?? null,
      row.Brand        ?? null,
      row.Category     ?? null,
      row.PP           ?? null,
      row.SP           ?? null,
      row.isActive     ?? 0,
      row.isInStock    ?? 0,
      row.LastBillDate ?? null,  // NEW — may be null if no bill in last 30 days
    );
  });

  return table;
}

async function syncInternalProducts() {
  const startTime = Date.now();

  try {
    const { combined } = await fetchCombinedData();
    console.log(`\n📦 Products to sync: ${combined.length}`);

    const valid   = combined.filter(r => r.SKU_ID);
    const skipped = combined.length - valid.length;
    console.log(`   Valid  : ${valid.length}`);
    console.log(`   Skipped: ${skipped} (null SKU)`);

    const dedupMap = new Map();
    for (const row of valid) dedupMap.set(row.SKU_ID, row);
    const deduped = [...dedupMap.values()];
    console.log(`   Deduped: ${deduped.length} unique SKUs (removed ${valid.length - deduped.length} duplicates)`);

    const activeCount  = deduped.filter(r => r.isActive   === 1).length;
    const inStockCount = deduped.filter(r => r.isInStock  === 1).length;
    const bothCount    = deduped.filter(r => r.isActive === 1 && r.isInStock === 1).length;
    console.log(`\n   📊 Shopify flags:`);
    console.log(`      isActive=1  : ${activeCount}`);
    console.log(`      isInStock=1 : ${inStockCount}`);
    console.log(`      both=1      : ${bothCount}  (eligible for recommendation engine)`);

    console.log('\n🔌 Connecting to db_tpstechautomata...');
    const pool = await getTargetPool();
    console.log('   Connected');

    console.log('\n🏗️  Building TVP...');
    const tvp = buildTVP(deduped);
    console.log(`   TVP ready — ${deduped.length} rows packed`);

    console.log('\n📤 Running bulk MERGE into InternalProducts...');
    const mergeStart = Date.now();

    const result = await pool.request()
      .input('tvp', tvp)
      .query(`
        MERGE InternalProducts AS target
        USING (
          SELECT
            SKU_ID,
            MAX(Title)              AS Title,
            MAX(Brand)              AS Brand,
            MAX(Category)           AS Category,
            MAX(PP)                 AS PP,
            MAX(SP)                 AS SP,
            CAST(MAX(CAST(isActive  AS INT)) AS BIT) AS isActive,
            CAST(MAX(CAST(isInStock AS INT)) AS BIT) AS isInStock,
            MAX(LastBillDate)       AS LastBillDate
          FROM @tvp
          GROUP BY SKU_ID
        ) AS source
          ON target.SKU_ID = source.SKU_ID

        WHEN MATCHED THEN
          UPDATE SET
            Title        = source.Title,
            Brand        = source.Brand,
            Category     = source.Category,
            PP           = source.PP,
            SP           = source.SP,
            isActive     = source.isActive,
            isInStock    = source.isInStock,
            LastBillDate = source.LastBillDate,
            UpdatedAt    = GETDATE()
            -- NOTE: ManualPP_UpdatedAt and ManualPP_UpdatedBy are deliberately
            -- NOT updated here. They are owned by the manual PP update API only.

        WHEN NOT MATCHED THEN
          INSERT (SKU_ID, Title, Brand, Category, PP, SP, isActive, isInStock, LastBillDate, UpdatedAt)
          VALUES (source.SKU_ID, source.Title, source.Brand, source.Category,
                  source.PP, source.SP, source.isActive, source.isInStock,
                  source.LastBillDate, GETDATE());
      `);

    const mergeSec = ((Date.now() - mergeStart) / 1000).toFixed(1);
    const totalSec = ((Date.now() - startTime)  / 1000).toFixed(1);

    console.log(`\n🎉 Done!`);
    console.log(`   Rows touched : ${result.rowsAffected[0]}`);
    console.log(`   Merge time   : ${mergeSec}s`);
    console.log(`   Total time   : ${totalSec}s`);

    clearTokenTimers();
    await pool.close();

  } catch (err) {
  console.error('\n❌ Fatal error:', err.message);
  console.error(err.stack);
  process.exit(1);
}
}

syncInternalProducts();

