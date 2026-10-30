// src/api_server.js
// Run: node src/api_server.js

require('dotenv').config();





//
const { getRecentRuns, getRunDetail, getRunSkuMatches, buildSkuMatchesCsv } = require('./services/scrapeStatsService');
//

const { pushPriceToShopify, checkShopifyAccess } = require('./services/shopifyService'); // add to top imports
const { getStockSnapshot, getLocationNames, snapshotToJson, applyStockUpdates } = require('./services/inventoryService');

const express  = require('express');
const cors     = require('cors');
const sql      = require('mssql');
const { v4: uuidv4 } = require('uuid');
const { AzureCliCredential, ManagedIdentityCredential } = require('@azure/identity');

const {
  loadCategorySettings,
  loadInternalProducts,
  loadCompetitorPrices,
  buildCompetitorMap,
  generateRecommendations,
  updateRecommendedSP,
  calculateRecommendedPrice,
  resolveEffectivePP,   // ← NEW
  getBusinessVars,      // ← NEW
  loadAllInternalProducts
} = require('./recommendation_engine');


const {
  getInsights, getInsightCounts, getInsightsExport, buildInsightsExportCsv,
  dismissInsight, bulkDismissInsights,
} = require('./services/insightsService');

const { scrapeProduct }    = require('./scraper/scrapeProduct');
const { upsertOneProduct } = require('./services/competitorPriceService');
const { STORES }           = require('./urls');
const { runScheduler,runManualScraper, getManualScraperCategories, }     = require('./scheduler/index'); // ← ADDED

const session        = require('express-session');
const { msalClient } = require('./auth/msalConfig');
const { requireAuth } = require('./auth/authMiddleware');
const { requireRole } = require('./auth/authMiddleware');

const app  = express();
const PORT = process.env.PORT || 8000;



// app.js (or wherever you set up Express)
const { log } = require('../blobLogger');

// request logging
app.use((req, res, next) => {
  log('INFO', 'app.js', 'requestLogger', `${req.method} ${req.originalUrl} - IP: ${req.ip}`);
  next();
});




app.use(cors({
  origin     : process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
// Default limit is 100kb - a full-catalog stock export sends ~8,500 SKUs (~130kb).
app.use(express.json({ limit: '2mb' }));

// Trust proxy — required for secure cookies behind Azure's load balancer
app.set('trust proxy', 1);

app.use(session({
  secret           : process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave           : false,
  saveUninitialized: false,
  cookie: {
    secure  : true,
    sameSite: 'none',
    httpOnly: true,
    maxAge  : 24 * 60 * 60 * 1000, // 24 hours
  },
}));




app.use('/api/sync', require('./routes/syncRoutes'));




// ── GET /auth/login ───────────────────────────────────────────
app.get('/auth/login', async (req, res) => {
  const authCodeUrlParams = {
    scopes     : ['user.read'],
    redirectUri: process.env.REDIRECT_URI,
  };
  const authUrl = await msalClient.getAuthCodeUrl(authCodeUrlParams);
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const tokenRequest = {
    code       : req.query.code,
    scopes     : ['user.read'],
    redirectUri: process.env.REDIRECT_URI,
  };
  try {
    const response = await msalClient.acquireTokenByCode(tokenRequest);
    const email = response.account.username.toLowerCase();

    const pool = await getSqlPool();
    const roleResult = await pool.request()
      .input('Email', sql.NVarChar(255), email)
      .query(`SELECT Role FROM UserRoles WHERE Email = @Email`);
    await pool.close();

    if (!roleResult.recordset.length) {
      return res.status(403).send(`<h2>Access denied</h2><p>${email} is not in the system.</p>`);
    }

    req.session.user = {
      name : response.account.name,
      email: email,
      role : roleResult.recordset[0].Role,
    };

    // Save session explicitly before redirecting
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).send('Login failed');
      }
      res.redirect(process.env.FRONTEND_URL);
    });

  } catch (err) {
    console.error('Auth callback error:', err.message);
    res.status(500).send('Login failed 1');
  }
});

// ── GET /auth/me ──────────────────────────────────────────────
app.get('/auth/me', async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ authenticated: false });
  }

  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('Email', sql.NVarChar(255), req.session.user.email)
      .query(`SELECT Role FROM UserRoles WHERE Email = @Email`);

    if (!result.recordset.length) {
      req.session.destroy();
      return res.status(401).json({ authenticated: false });
    }

    const freshRole = result.recordset[0].Role;
    req.session.user.role = freshRole;

    res.json({
      authenticated: true,
      user: {
        name : req.session.user.name,
        email: req.session.user.email,
        role : freshRole,
      },
    });
  } catch (err) {
    console.error('❌ /auth/me role refresh failed:', err.message);
    res.json({
      authenticated: true,
      user: req.session.user,
    });
  } finally {
    if (pool) await pool.close();
  }
});

// ── POST /auth/logout ─────────────────────────────────────────
app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});


// ── SQL connection with token cache ──────────────────────────
// let _cachedToken    = null;
// let _tokenExpiresAt = 0;

// async function getSqlPool() {
//   const now = Date.now();

//   if (!_cachedToken || now >= _tokenExpiresAt - 5 * 60 * 1000) {
//     const credential = process.env.AZURE_ENV === 'production'
//       ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
//       : new AzureCliCredential();

//     const tokenResponse = await credential.getToken(
//       'https://database.windows.net/.default'
//     );

//     _cachedToken    = tokenResponse.token;
//     _tokenExpiresAt = tokenResponse.expiresOnTimestamp ?? (now + 55 * 60 * 1000);
//     console.log('🔑 Azure token refreshed');
//   }

//   return await sql.connect({
//     server  : process.env.db_serverendpoint,
//     database: 'db_tpstechautomata',
//     authentication: {
//       type   : 'azure-active-directory-access-token',
//       options: { token: _cachedToken },
//     },
//     options: {
//       encrypt              : true,
//       trustServerCertificate: false,
//       requestTimeout       : 60_000,
//     },
//   });
// }

// ── SQL connection — persistent pool, NOT closed per-request ──
let _sqlPool         = null;
let _cachedToken     = null;
let _tokenExpiresAt  = 0;

async function getSqlPool() {
  const now = Date.now();

  // Refresh AAD token if missing or expiring soon
  if (!_cachedToken || now >= _tokenExpiresAt - 5 * 60 * 1000) {
    const credential = process.env.AZURE_ENV === 'production'
      ? new ManagedIdentityCredential({ clientId: process.env.db_userclientid })
      : new AzureCliCredential();

    const tokenResponse = await credential.getToken('https://database.windows.net/.default');
    _cachedToken    = tokenResponse.token;
    _tokenExpiresAt = tokenResponse.expiresOnTimestamp ?? (now + 55 * 60 * 1000);
    console.log('🔑 Azure token refreshed');

    // Token rotated — drop the old pool so the next connect uses the fresh token
    if (_sqlPool) {
      try { await _sqlPool.close(); } catch (_) {}
      _sqlPool = null;
    }
  }

  // Reuse the existing pool if it's still connected
  if (_sqlPool && _sqlPool.connected) {
    return _sqlPool;
  }

//   console.log('🔌 Opening new SQL connection pool...');
//   console.log('========================');
// console.log('db_serverendpoint =', process.env.db_serverendpoint);
// console.log('AZURE_ENV =', process.env.AZURE_ENV);
// console.log('Token exists =', !!_cachedToken);
// console.log('Token length =', _cachedToken?.length);
// console.log('========================');
  _sqlPool = await new sql.ConnectionPool({
    server  : process.env.db_serverendpoint,
    database: 'db_tpstechautomata',
    authentication: {
      type   : 'azure-active-directory-access-token',
      options: { token: _cachedToken },
    },
    options: {
      encrypt              : true,
      trustServerCertificate: false,
      requestTimeout       : 60_000,
    },
    pool: {
      max: 10,
      min: 0,
      idleTimeoutMillis: 30000,
    },
  }).connect();

  return _sqlPool;
}




// ── Helper: find store config by product URL ──────────────────
function findStoreByUrl(productUrl) {
  const domainMap = {
    'primeabgb.com'        : 'primeabgb',
    'mdcomputers.in'       : 'mdcomputers',
    'pickpcparts.in'       : 'pickpcparts',
    'vedantcomputers.com'  : 'vedant',
    'vishalperipherals.com': 'vishal',
    'pcstudio.in'          : 'pcstudio',
    'fgtechstore.com'      : 'fgtech',
  };
  for (const [domain, storeName] of Object.entries(domainMap)) {
    if (productUrl.includes(domain)) {
      return STORES.find(s => s.name === storeName) || null;
    }
  }
  return null;
}

// ── Helper: recalculate RecommendedSP for one SKU ────────────
async function recalculateRecommendedSP(pool, skuId) {
  const GST               = 0.18;
  const COST_OF_BUSINESS  = 0.07;
  const MIN_PROFIT_MARGIN = 0.05;

  const productResult = await pool.request()
    .input('SKU_ID', sql.NVarChar(100), skuId)
    .query(`SELECT PP FROM InternalProducts WHERE SKU_ID = @SKU_ID AND PP IS NOT NULL`);

  if (!productResult.recordset.length) return null;

  const pp = parseFloat(productResult.recordset[0].PP);

  const competitorResult = await pool.request()
    .input('SKU', sql.NVarChar(100), skuId)
    .query(`
      SELECT TOP 1 CompetitorPrice
      FROM CompetitorPrices
      WHERE SKU = @SKU
        AND CompetitorPrice IS NOT NULL
        AND LOWER(StockStatus) != 'out of stock'
      ORDER BY CompetitorPrice ASC
    `);

  if (!competitorResult.recordset.length) return null;

  const lowestCompetitorPrice = parseFloat(competitorResult.recordset[0].CompetitorPrice);
  const basePrice = parseFloat((pp * (1 + GST + COST_OF_BUSINESS + MIN_PROFIT_MARGIN)).toFixed(2));

  let recommendedSP = basePrice;
  if (lowestCompetitorPrice > basePrice) {
    const target = parseFloat((lowestCompetitorPrice * 0.99).toFixed(2));
    if (target > basePrice) recommendedSP = target;
  }

  await pool.request()
    .input('SKU_ID',        sql.NVarChar(100),  skuId)
    .input('RecommendedSP', sql.Decimal(10, 2), recommendedSP)
    .query(`
      UPDATE InternalProducts
      SET RecommendedSP = @RecommendedSP, RecommendedSPUpdatedAt = GETDATE()
      WHERE SKU_ID = @SKU_ID
    `);

  return recommendedSP;
}




// ── Persist live-calculated RecommendedSP for Basic Recommendations ──
// Runs after computing rows, in chunks, so the variance check on push
// has a real number to compare against instead of NULL.
async function persistRecommendedSP(pool, rows) {
  const CHUNK_SIZE = 400; // stay well under SQL Server's parameter limit
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const request = pool.request();
    const valuesClauses = chunk.map((row, idx) => {
      request.input(`sku${idx}`, sql.NVarChar(100), row.SKU_ID);
      request.input(`rsp${idx}`, sql.Decimal(10, 2), row.RecommendedSP);
      return `(@sku${idx}, @rsp${idx})`;
    });

    const query = `
      UPDATE ip
      SET ip.RecommendedSP = v.RecommendedSP, ip.RecommendedSPUpdatedAt = GETDATE()
      FROM InternalProducts ip
      JOIN (VALUES ${valuesClauses.join(', ')}) AS v(SKU_ID, RecommendedSP)
        ON ip.SKU_ID = v.SKU_ID;
    `;
    await request.query(query);
  }
}




// ── Read a numeric AppSettings value, with a safe fallback ──────
async function getNumericSetting(pool, key, fallback) {
  try {
    const result = await pool.request()
      .input('Key', sql.NVarChar(100), key)
      .query(`SELECT SettingValue FROM AppSettings WHERE SettingKey = @Key`);
    const raw = result.recordset[0]?.SettingValue;
    const parsed = parseFloat(raw);
    return isNaN(parsed) ? fallback : parsed;
  } catch {
    return fallback; // never let a settings-lookup failure block a push
  }
}



// ─────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────

// ── GET /api/recommendations ──────────────────────────────────
app.get('/api/recommendations', async (req, res) => {
  console.log('RECS ROUTE v2 (brand)');   // temporary
  let pool;
  try {
    pool = await getSqlPool();
        const result = await pool.request().query(`
      SELECT
        i.SKU_ID,
        i.Title,
        i.PP,
        i.SP,
        i.RecommendedSP,
        i.Category,
        i.Brand,
        ROUND(
          ((i.RecommendedSP - (i.PP * 1.30)) / (i.PP * 1.30)) * 100,
          2
        ) AS ExtraProfitPct,
        c.CompetitorPrice,
        c.ProductURL   AS CompetitorURL,
        c.StoreName,
        c.StockStatus  AS CompetitorStockStatus
      FROM InternalProducts i
      INNER JOIN (
        SELECT SKU, CompetitorPrice, ProductURL, StoreName, StockStatus,
          ROW_NUMBER() OVER (PARTITION BY SKU ORDER BY CompetitorPrice ASC) AS rn
        FROM CompetitorPrices
        WHERE CompetitorPrice IS NOT NULL
          AND LOWER(StockStatus) != 'out of stock'
      ) c ON c.SKU = i.SKU_ID AND c.rn = 1
      WHERE i.PP IS NOT NULL AND i.isActive = 1
        AND i.isInStock = 1 AND i.RecommendedSP IS NOT NULL
      ORDER BY i.SKU_ID
    `);
    console.log(`✅ /api/recommendations — ${result.recordset.length} rows served`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ API error:', err.message, '| line:', err.lineNumber);
    console.error('❌ API error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});















// ── GET /api/internal-recommendations ─────────────────────────
// Internal-data-only RecommendedSP — no competitor matching at all.
// Eligibility: PP available + isActive + isInStock, MINUS any SKU
// that's eligible for the Competitor Based table (that table has
// priority — a SKU should never appear in both).
// Computed live on every request, and persisted to SQL so the
// variance check on push has a real value to compare against.
// app.get('/api/internal-recommendations', requireAuth, async (req, res) => {
//   let pool;
//   try {
//     pool = await getSqlPool();

//     const categorySettings = await loadCategorySettings(pool);
//     const internalProducts = await loadInternalProducts(pool);

//     // Fetch the set of SKUs that qualify for Competitor Based Recommendation —
//     // same match condition used in /api/recommendations (valid competitor price,
//     // competitor not out of stock). Basic Recommendations must exclude these.
//     const competitorMatchResult = await pool.request().query(`
//       SELECT DISTINCT SKU
//       FROM CompetitorPrices
//       WHERE CompetitorPrice IS NOT NULL
//         AND LOWER(StockStatus) != 'out of stock'
//     `);
//     const competitorMatchedSkus = new Set(
//       competitorMatchResult.recordset.map(r => (r.SKU || '').trim().toUpperCase())
//     );

//     const eligibleProducts = internalProducts.filter(
//       product => !competitorMatchedSkus.has((product.SKU_ID || '').trim().toUpperCase())
//     );

//     const rows = eligibleProducts.map(product => {
//       const { effectivePP, source } = resolveEffectivePP(product);
//       const { gst, costOfBusiness, profitMargin } = getBusinessVars(categorySettings, product.Category);
//       const multiplier     = 1 + gst + costOfBusiness + profitMargin;
//       const recommendedSP  = parseFloat((effectivePP * multiplier).toFixed(2));

//       return {
//         SKU_ID       : product.SKU_ID,
//         Title        : product.Title,
//         Category     : product.Category,
//         Brand        : product.Brand,
//         PP           : effectivePP,
//         PPSource     : source,
//         SP           : product.SP != null ? parseFloat(product.SP) : null,
//         RecommendedSP: recommendedSP,
//         GSTPct       : parseFloat((gst * 100).toFixed(2)),
//         COBPct       : parseFloat((costOfBusiness * 100).toFixed(2)),
//         MarginPct    : parseFloat((profitMargin * 100).toFixed(2)),
//       };
//     });

//     // Persist so the variance check on push has a real value to compare against.
//     try {
//       await persistRecommendedSP(pool, rows);
//     } catch (persistErr) {
//       console.error('⚠️ Failed to persist RecommendedSP (non-fatal):', persistErr.message);
//     }

//     console.log(`✅ /api/internal-recommendations — ${rows.length} eligible internal products (excluded ${competitorMatchedSkus.size} competitor-matched SKUs)`);
//     res.json({ success: true, data: rows });
//   } catch (err) {
//     console.error('❌ /api/internal-recommendations error:', err.message);
//     res.status(500).json({ success: false, error: err.message });
//   } finally {
//     if (pool) await pool.close();
//   }
// });






// ── GET /api/internal-recommendations ─────────────────────────
// Internal-data-only RecommendedSP — no competitor matching at all.
// Now shows the WHOLE InternalProducts table (active or inactive, PP
// available or not — same spirit as Purchase Price Update), MINUS any
// SKU that's eligible for the Competitor Based table (that table has
// priority — a SKU should never appear in both).
// Computed live on every request, and persisted to SQL so the
// variance check on push has a real value to compare against.
app.get('/api/internal-recommendations', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();

    const categorySettings = await loadCategorySettings(pool);
    // Basic Recommendations now shows the WHOLE InternalProducts table —
    // active or inactive, PP available or not — same spirit as Purchase
    // Price Update. loadInternalProducts() (PP/active/in-stock filtered)
    // stays reserved for the Competitor Based engine.
    const internalProducts = await loadAllInternalProducts(pool);

    // Fetch the set of SKUs that qualify for Competitor Based Recommendation —
    // same match condition used in /api/recommendations (valid competitor price,
    // competitor not out of stock). Basic Recommendations must exclude these.
    const competitorMatchResult = await pool.request().query(`
      SELECT DISTINCT SKU
      FROM CompetitorPrices
      WHERE CompetitorPrice IS NOT NULL
        AND LOWER(StockStatus) != 'out of stock'
    `);
    const competitorMatchedSkus = new Set(
      competitorMatchResult.recordset.map(r => (r.SKU || '').trim().toUpperCase())
    );

    const eligibleProducts = internalProducts.filter(
      product => !competitorMatchedSkus.has((product.SKU_ID || '').trim().toUpperCase())
    );

    const rows = eligibleProducts.map(product => {
      // No PP yet (bill not received / never set) — can't compute a
      // RecommendedSP. Still show the row (that's the whole point of this
      // change), just with the price fields null instead of crashing.
      if (product.PP == null) {
        return {
          SKU_ID       : product.SKU_ID,
          Title        : product.Title,
          Category     : product.Category,
          Brand        : product.Brand,
          isActive     : product.isActive,
          isInStock    : product.isInStock,
          PP           : null,
          PPSource     : null,
          SP           : product.SP != null ? parseFloat(product.SP) : null,
          RecommendedSP: null,
          GSTPct       : null,
          COBPct       : null,
          MarginPct    : null,
        };
      }

      const { effectivePP, source } = resolveEffectivePP(product);
      const { gst, costOfBusiness, profitMargin } = getBusinessVars(categorySettings, product.Category);
      const multiplier     = 1 + gst + costOfBusiness + profitMargin;
      const recommendedSP  = parseFloat((effectivePP * multiplier).toFixed(2));

      return {
        SKU_ID       : product.SKU_ID,
        Title        : product.Title,
        Category     : product.Category,
        Brand        : product.Brand,
        isActive     : product.isActive,
        isInStock    : product.isInStock,
        PP           : effectivePP,
        PPSource     : source,
        SP           : product.SP != null ? parseFloat(product.SP) : null,
        RecommendedSP: recommendedSP,
        GSTPct       : parseFloat((gst * 100).toFixed(2)),
        COBPct       : parseFloat((costOfBusiness * 100).toFixed(2)),
        MarginPct    : parseFloat((profitMargin * 100).toFixed(2)),
      };
    });

    // Persist so the variance check on push has a real value to compare against.
    try {
      await persistRecommendedSP(pool, rows);
    } catch (persistErr) {
      console.error('⚠️ Failed to persist RecommendedSP (non-fatal):', persistErr.message);
    }

    console.log(`✅ /api/internal-recommendations — ${rows.length} eligible internal products (excluded ${competitorMatchedSkus.size} competitor-matched SKUs)`);
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error('❌ /api/internal-recommendations error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});















// ── POST /api/refresh-product ─────────────────────────────────
app.post('/api/refresh-product', async (req, res) => {
  const { competitorUrl, skuId } = req.body;
  if (!competitorUrl || !skuId) {
    return res.status(400).json({ success: false, error: 'Both competitorUrl and skuId are required' });
  }
  console.log(`\n🔄 Manual refresh: SKU=${skuId} | URL=${competitorUrl}`);

  const store = findStoreByUrl(competitorUrl);
  if (!store) {
    return res.status(400).json({
      success: false,
      error: 'Unknown store URL. Supported: primeabgb, mdcomputers, pickpcparts, vedant, vishal, pcstudio',
    });
  }
  console.log(`   Store identified: ${store.name}`);

  let pool;
  try {
    console.log(`   Scraping: ${competitorUrl}`);
    const product = await scrapeProduct(store, competitorUrl);
    if (!product || !product.name) {
      return res.status(422).json({ success: false, error: 'Scraping succeeded but no product data found' });
    }
    console.log(`   Scraped: ${product.name}`);

    const upserted = await upsertOneProduct(product);
    if (!upserted) {
      return res.status(422).json({ success: false, error: 'Product scraped but SKU could not be mapped' });
    }

    pool = await getSqlPool();
    const newRecommendedSP = await recalculateRecommendedSP(pool, skuId);

    const refreshedBy = req.headers['x-user-email'] || 'manual';
    const refreshedAt = new Date().toISOString();

    await pool.request()
      .input('SKU_ID',              sql.NVarChar(100), skuId)
      .input('LastManualRefreshAt', sql.NVarChar(50),  refreshedAt)
      .input('LastManualRefreshBy', sql.NVarChar(100), refreshedBy)
      .query(`
        UPDATE InternalProducts
        SET LastManualRefreshAt = @LastManualRefreshAt,
            LastManualRefreshBy = @LastManualRefreshBy
        WHERE SKU_ID = @SKU_ID
      `);

    console.log(`   ✅ Done — RecommendedSP: ₹${newRecommendedSP} | RefreshedBy: ${refreshedBy}`);
    res.json({
      success: true, skuId, storeName: store.name, productName: product.name,
      newCompetitorPrice: upserted.CompetitorPrice, newRecommendedSP, refreshedAt, refreshedBy,
    });
  } catch (err) {
    console.error(`❌ Manual refresh failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/competitor-details/:skuId ───────────────────────
app.get('/api/competitor-details/:skuId', async (req, res) => {
  const { skuId } = req.params;
  if (!skuId) return res.status(400).json({ success: false, error: 'skuId is required' });

  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('SKU', sql.NVarChar(100), skuId)
      .query(`
        SELECT TOP 4 CompetitorPrice, ProductURL, StoreName, StockStatus
        FROM CompetitorPrices
        WHERE SKU = @SKU AND CompetitorPrice IS NOT NULL
          AND LOWER(StockStatus) != 'out of stock'
        ORDER BY CompetitorPrice ASC
      `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error(`❌ /api/competitor-details/${skuId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});







// ── GET /api/pp-products ──────────────────────────────────────
app.get('/api/pp-products', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT
        SKU_ID, Title, Category, Brand, PP, isActive, isInStock,
        LastBillDate, ManualPP_UpdatedAt, ManualPP_UpdatedBy,
        CASE
          WHEN ManualPP_UpdatedAt IS NOT NULL AND LastBillDate IS NOT NULL
           AND ManualPP_UpdatedAt >= CAST(LastBillDate AS DATETIME2) THEN 'manual'
          WHEN ManualPP_UpdatedAt IS NOT NULL AND LastBillDate IS NULL THEN 'manual'
          ELSE 'bill'
        END AS PPSource
      FROM InternalProducts
      WHERE isActive = 1
      ORDER BY Category, Title
    `);
    console.log(`✅ /api/pp-products — ${result.recordset.length} rows`);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ /api/pp-products error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});




// ── PATCH /api/update-pp ──────────────────────────────────────
app.patch('/api/update-pp', requireAuth, async (req, res) => {
  const { skuId, newPP } = req.body;
  if (!skuId || newPP == null) {
    return res.status(400).json({ success: false, error: 'skuId and newPP are required' });
  }
  const parsedPP = parseFloat(newPP);
  if (isNaN(parsedPP) || parsedPP <= 0) {
    return res.status(400).json({ success: false, error: 'newPP must be a positive number' });
  }

  const updatedBy = req.session?.user?.email || 'unknown';
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('SKU_ID',             sql.NVarChar(100),  skuId)
      .input('PP',                 sql.Decimal(10, 2), parsedPP)
      .input('ManualPP_UpdatedBy', sql.NVarChar(150),  updatedBy)
      .query(`
        UPDATE InternalProducts
        SET PP = @PP, ManualPP_UpdatedAt = GETDATE(), ManualPP_UpdatedBy = @ManualPP_UpdatedBy
        WHERE SKU_ID = @SKU_ID;

        SELECT SKU_ID, PP, ManualPP_UpdatedAt, ManualPP_UpdatedBy, LastBillDate
        FROM InternalProducts WHERE SKU_ID = @SKU_ID;
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }
    console.log(`✅ PP updated: SKU=${skuId} | PP=₹${parsedPP} | By=${updatedBy}`);
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error(`❌ /api/update-pp error for ${skuId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/pp-template-csv ──────────────────────────────────
// Header = SKU,PP,<one column per Shopify location>. If the locations can't
// be loaded the template falls back to the plain SKU,PP header.
app.get('/api/pp-template-csv', requireAuth, async (req, res) => {
  let header = 'SKU,PP';
  try {
    const locations = await getLocationNames();
    if (locations.length > 0) header += ',' + locations.join(',');
  } catch (err) {
    console.error('⚠️ /api/pp-template-csv — could not load locations:', err.message);
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="pp_update_template.csv"');
  res.send(header + '\n');
});









// ── GET /api/insights ────────────────────────────────────────
app.get('/api/insights', requireAuth, async (req, res) => {
  try {
    const pool = await getSqlPool();
    const { category, brand, alertType, search, days, sortBy, page, pageSize, minThreshold, skipRecompute, refresh } = req.query;
    const result = await getInsights(pool, {
      category: category || null,
      brand: brand || null,
      alertType: alertType || null,
      search: search || null,
      days: days || null,
      sortBy: sortBy || 'newest',
      page: page ? parseInt(page, 10) : null,
      pageSize: pageSize ? parseInt(pageSize, 10) : null,
      minThresholdPct: minThreshold != null ? parseFloat(minThreshold) : null,
      skipRecompute: skipRecompute === 'true',
      forceRecompute: refresh === 'true',
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ /api/insights error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/insights/counts ─────────────────────────────────
// One cheap GROUP BY for the summary cards / tab counts (optionally limited to
// the last N days) — replaces four full /api/insights reads.
app.get('/api/insights/counts', requireAuth, async (req, res) => {
  try {
    const pool = await getSqlPool();
    const counts = await getInsightCounts(pool, { days: req.query.days || null });
    res.json({ success: true, ...counts });
  } catch (err) {
    console.error('❌ /api/insights/counts error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/insights/export.csv ─────────────────────────────
// CSV for the Out of stock and Not in catalog tabs. Applies the same filters as
// the table (category, brand, search, days) but returns ALL matching rows.
app.get('/api/insights/export.csv', requireAuth, async (req, res) => {
  const { alertType, category, brand, search, days } = req.query;
  if (alertType !== 'OOS' && alertType !== 'NO_LISTING') {
    return res.status(400).json({ success: false, error: 'alertType must be OOS or NO_LISTING' });
  }
  try {
    const pool = await getSqlPool();
    const exportData = await getInsightsExport(pool, {
      alertType,
      category: category || null,
      brand: brand || null,
      search: search || null,
      days: days || null,
    });
    const csv = buildInsightsExportCsv(exportData, alertType);
    const stamp = new Date().toISOString().slice(0, 10);
    const name = alertType === 'OOS' ? 'out_of_stock' : 'not_in_catalog';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="insights_${name}_${stamp}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('❌ /api/insights/export.csv error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});




















app.get('/api/insights/take-action/:skuId', requireAuth, async (req, res) => {
  const { skuId } = req.params;
  let pool;
  try {
    pool = await getSqlPool();

    const productResult = await pool.request()
      .input('SKU_ID', sql.NVarChar(100), skuId)
      .query(`SELECT SKU_ID, Title, Category, PP, SP FROM InternalProducts WHERE SKU_ID = @SKU_ID`);

    if (!productResult.recordset.length) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }
    const product = productResult.recordset[0];

    const competitorResult = await pool.request()
      .input('SKU_ID', sql.NVarChar(100), skuId)
      .query(`
        SELECT TOP 1 CompetitorPrice AS LowestCompetitorPrice, StoreName, ScrapedAt AS AsOf
        FROM CompetitorPrices
        WHERE SKU = @SKU_ID AND CompetitorPrice IS NOT NULL
          AND StockStatus IS NOT NULL AND LOWER(StockStatus) <> 'out of stock'
        ORDER BY CompetitorPrice ASC
      `);
    const lowestCompetitorPrice = competitorResult.recordset[0]?.LowestCompetitorPrice ?? null;
    const lowestCompetitorStore = competitorResult.recordset[0]?.StoreName ?? null;
    const asOf = competitorResult.recordset[0]?.AsOf ?? null;

    let recommendedSP = null;
    let pricingBreakdown = null;

    if (product.PP != null) {
      const categorySettings = await loadCategorySettings(pool);
      const { gst, costOfBusiness, profitMargin } = getBusinessVars(categorySettings, product.Category);

      pricingBreakdown = {
        gstPct: Math.round(gst * 10000) / 100,
        costOfBusinessPct: Math.round(costOfBusiness * 10000) / 100,
        profitMarginPct: Math.round(profitMargin * 10000) / 100,
      };

      if (lowestCompetitorPrice != null) {
        const { recommendedSP: sp } = calculateRecommendedPrice(
          parseFloat(product.PP), parseFloat(lowestCompetitorPrice), gst, costOfBusiness, profitMargin
        );
        recommendedSP = sp;
      } else {
        const multiplier = 1 + gst + costOfBusiness + profitMargin;
        recommendedSP = Math.round(parseFloat(product.PP) * multiplier);
      }

      // Keep InternalProducts.RecommendedSP in sync with what this modal shows,
      // so the variance check on push compares against the same number.
      // Non-fatal: a failed save must never stop the modal from loading.
      try {
        await persistRecommendedSP(pool, [{ SKU_ID: skuId, RecommendedSP: recommendedSP }]);
      } catch (persistErr) {
        console.error(`⚠️ take-action: failed to persist RecommendedSP for ${skuId} (non-fatal):`, persistErr.message);
      }
    }

    res.json({
      success: true,
      data: {
        skuId: product.SKU_ID,
        title: product.Title,
        category: product.Category,
        pp: product.PP != null ? parseFloat(product.PP) : null,
        sp: product.SP != null ? parseFloat(product.SP) : null,
        recommendedSP,
        pricingBreakdown,
        lowestCompetitorPrice: lowestCompetitorPrice != null ? parseFloat(lowestCompetitorPrice) : null,
        lowestCompetitorStore,
        competitorPriceAsOf: asOf,
      },
    });
  } catch (err) {
    console.error(`❌ /api/insights/take-action/${skuId} error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});

















app.post('/api/insights/dismiss-bulk', requireAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }
    const pool = await getSqlPool();
    const dismissedIds = await bulkDismissInsights(pool, ids, req.user?.email || 'unknown');
    res.json({ success: true, data: dismissedIds });
  } catch (err) {
    console.error('❌ /api/insights/dismiss-bulk error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});




// ── POST /api/insights/:id/dismiss ──────────────────────────────
app.post('/api/insights/:id/dismiss', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid alert id' });
  const dismissedBy = req.session?.user?.email || 'unknown';
  let pool;
  try {
    pool = await getSqlPool();
    const updated = await dismissInsight(pool, id, dismissedBy);
    if (!updated) return res.status(404).json({ success: false, error: 'Alert not found' });
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('❌ /api/insights/:id/dismiss error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});











// ── POST /api/validate-skus ───────────────────────────────────
app.post('/api/validate-skus', requireAuth, async (req, res) => {
  const { skus } = req.body;

  if (!Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ success: false, error: 'skus must be a non-empty array' });
  }
  if (skus.length > 2000) {
    return res.status(400).json({
      success: false,
      error: `Too many SKUs (${skus.length}). Maximum 2000 rows per upload.`,
    });
  }

  let pool;
  try {
    pool = await getSqlPool();

    const request    = pool.request();
    const paramNames = skus.map((sku, i) => {
      request.input(`sku${i}`, sql.NVarChar(100), sku);
      return `@sku${i}`;
    });

    const result = await request.query(`
      SELECT SKU_ID, PP
      FROM InternalProducts
      WHERE SKU_ID IN (${paramNames.join(',')})
    `);

    // FIX: normalize keys to lowercase.
    // SQL Server finds the row case-insensitively, but JavaScript Map
    // is case-sensitive — so "I5-12400F" and "i5-12400F" would be
    // treated as different keys without this normalization.
    const foundMap = new Map();
    for (const row of result.recordset) {
      foundMap.set(row.SKU_ID.toLowerCase(), row.PP != null ? parseFloat(row.PP) : null);
    }

    const valid    = [];
    const notFound = [];

    for (const sku of skus) {
      if (foundMap.has(sku.toLowerCase())) {
        valid.push({ sku, currentPP: foundMap.get(sku.toLowerCase()) });
      } else {
        notFound.push(sku);
      }
    }

    console.log(`✅ /api/validate-skus — ${skus.length} checked | ${notFound.length} not found`);
    res.json({ valid, notFound });

  } catch (err) {
    console.error('❌ /api/validate-skus error:', err.message, err.stack);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── POST /api/bulk-update-pp ──────────────────────────────────
app.post('/api/bulk-update-pp', requireAuth, async (req, res) => {
  const { rows = [], unidentified = [], fileName = '' } = req.body;

  if (rows.length === 0 && unidentified.length === 0) {
    return res.status(400).json({ success: false, error: 'Nothing to process' });
  }
  if (rows.length > 2000) {
    return res.status(400).json({
      success: false,
      error: `Too many rows (${rows.length}). Maximum 2000 per upload.`,
    });
  }

  for (const row of rows) {
    if (!row.skuId || typeof row.skuId !== 'string') {
      return res.status(400).json({ success: false, error: 'Each row must have a skuId string' });
    }
    const pp = parseFloat(row.newPP);
    if (isNaN(pp) || pp <= 0) {
      return res.status(400).json({
        success: false,
        error: `Invalid PP for SKU "${row.skuId}": must be a positive number`,
      });
    }
  }

  const updatedBy = req.session?.user?.email || 'unknown';
  const updatedAt = new Date().toISOString();
  const sessionId = uuidv4();

  let pool;
  try {
    pool = await getSqlPool();

    let updated = 0;
    for (const row of rows) {
      const result = await pool.request()
        .input('SKU_ID',    sql.NVarChar(100),  row.skuId)
        .input('PP',        sql.Decimal(10, 2), parseFloat(row.newPP))
        .input('UpdatedBy', sql.NVarChar(150),  updatedBy)
        .query(`
          UPDATE InternalProducts
          SET PP = @PP, ManualPP_UpdatedAt = GETDATE(), ManualPP_UpdatedBy = @UpdatedBy
          WHERE SKU_ID = @SKU_ID
        `);
      if (result.rowsAffected[0] > 0) updated++;
    }

    await pool.request()
      .input('SessionID',         sql.NVarChar(36),  sessionId)
      .input('UploadedBy',        sql.NVarChar(150), updatedBy)
      .input('TotalRowsInCSV',    sql.Int,           rows.length + unidentified.length)
      .input('UpdatedCount',      sql.Int,           updated)
      .input('UnidentifiedCount', sql.Int,           unidentified.length)
      .input('FileName',          sql.NVarChar(500), fileName || '')
      .query(`
        INSERT INTO BulkUploadSessions
          (SessionID, UploadedBy, TotalRowsInCSV, UpdatedCount, UnidentifiedCount, FileName)
        VALUES
          (@SessionID, @UploadedBy, @TotalRowsInCSV, @UpdatedCount, @UnidentifiedCount, @FileName)
      `);

    if (unidentified.length > 0) {
      const BATCH = 50;
      for (let i = 0; i < unidentified.length; i += BATCH) {
        const batch  = unidentified.slice(i, i + BATCH);
        const req2   = pool.request();
        const values = batch.map((row, idx) => {
          const n = i + idx;
          req2.input(`sid${n}`,  sql.NVarChar(36),   sessionId);
          req2.input(`usku${n}`, sql.NVarChar(100),  row.sku ?? '');
          req2.input(`upp${n}`,  sql.Decimal(10, 2), row.pp  ?? null);
          req2.input(`uby${n}`,  sql.NVarChar(150),  updatedBy);
          return `(@sid${n}, @usku${n}, @upp${n}, GETDATE(), @uby${n})`;
        });
        await req2.query(`
          INSERT INTO UnIdentifiedProducts (SessionID, SKU, PP, UploadedAt, UploadedBy)
          VALUES ${values.join(',')}
        `);
      }
    }

    console.log(`✅ /api/bulk-update-pp — session=${sessionId} | updated=${updated} | unidentified=${unidentified.length} | by=${updatedBy}`);

    res.json({
      success: true,
      data: { sessionId, updated, unidentifiedCount: unidentified.length, updatedBy, updatedAt },
    });

  } catch (err) {
    console.error('❌ /api/bulk-update-pp error:', err.message, err.stack);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── POST /api/stock-snapshot ──────────────────────────────────
// Current per-location stock for the given SKUs, read LIVE from Shopify
// (falls back to the inventory view if Shopify is unreachable - the response
// says which via data.source). Used by the PP sheet download and by the
// upload preview.
app.post('/api/stock-snapshot', requireAuth, async (req, res) => {
  const { skus } = req.body;
  if (!Array.isArray(skus) || skus.length === 0) {
    return res.status(400).json({ success: false, error: 'skus must be a non-empty array' });
  }
  if (skus.length > 10000) {
    return res.status(400).json({ success: false, error: `Too many SKUs (${skus.length}). Maximum 10000.` });
  }
  try {
    // Live per-item reads are limited by Shopify's API rate limit (and the 230s App Service
    // request timeout), so big exports use the last-synced DB view instead of live stock.
    const LIVE_MAX_SKUS = 500;
    const skipLive = skus.length > LIVE_MAX_SKUS
      ? `${skus.length} products is too many for a live Shopify read (limit ${LIVE_MAX_SKUS}), so stock is from the last sync`
      : null;
    const snapshot = await getStockSnapshot(skus, { skipLive });
    console.log(`✅ /api/stock-snapshot — ${skus.length} SKUs | source=${snapshot.source}`);
    res.json({ success: true, data: snapshotToJson(snapshot) });
  } catch (err) {
    console.error('❌ /api/stock-snapshot error:', err.message, err.stack);
    res.status(500).json({
      success: false,
      error: 'Current stock could not be loaded right now. Please try again in a few minutes. If it keeps happening, contact the tech team.',
      technical: err.message,
    });
  }
});


// ── GET /api/stock-check?sku=ABC  (or ?sku=A&sku=B) ───────────
// Debug helper, openable straight in the browser (no Postman needed) while
// logged in. For each SKU it shows what the DB view says, what Shopify says
// live, and the final per-location result the sheet would use.
// NOTE: a "+" inside a SKU must be written as %2B in the URL.
app.get('/api/stock-check', requireAuth, async (req, res) => {
  const skus = [].concat(req.query.sku || []).map(s => String(s).trim()).filter(Boolean);
  if (skus.length === 0 || skus.length > 20) {
    return res.status(400).json({ success: false, error: 'Pass 1-20 SKUs, e.g. /api/stock-check?sku=YD3200C5FHBOX' });
  }
  try {
    const { fetchInventoryViewRows } = require('./services/azureSqlService');
    const [snapshot, viewRows] = await Promise.all([getStockSnapshot(skus), fetchInventoryViewRows()]);
    const wanted = new Set(skus.map(s => s.toLowerCase()));
    const result = {};
    for (const sku of skus) result[sku] = { dbView: {}, final: {} };
    for (const r of viewRows) {
      const k = String(r.sku || '').trim();
      if (wanted.has(k.toLowerCase())) {
        const target = skus.find(x => x.toLowerCase() === k.toLowerCase());
        result[target].dbView[String(r.location_name).trim()] = Number(r.quantity);
      }
    }
    const json = snapshotToJson(snapshot);
    for (const sku of skus) result[sku].final = json.stock[sku.toLowerCase()] || {};
    res.json({
      success: true,
      source: json.source,            // 'shopify-live' or 'view-fallback'
      liveError: json.liveError,      // why live read failed, if it did
      allLocationColumns: json.locations,
      skus: result,                   // dbView = DB view rows, final = what the sheet shows (missing location = NA)
    });
  } catch (err) {
    console.error('❌ /api/stock-check error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── POST /api/bulk-update-stock ───────────────────────────────
// rows: [{ skuId, stock: { "<Location>": "<cell text>" } }]
// Blank cell = 0. Diffs against live Shopify stock, pushes only the changes
// to Shopify, and writes each change to InventoryUpdateLog.
app.post('/api/bulk-update-stock', requireAuth, async (req, res) => {
  const { rows = [], fileName = '', ppSessionId = null } = req.body;

  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ success: false, error: 'Nothing to process' });
  }
  if (rows.length > 500) {
    return res.status(400).json({ success: false, error: `Too many rows (${rows.length}) for a stock update. Maximum 500 per upload (live Shopify stock is read for each).` });
  }
  for (const row of rows) {
    if (!row.skuId || typeof row.skuId !== 'string' || typeof row.stock !== 'object' || row.stock === null) {
      return res.status(400).json({ success: false, error: 'Each row must have a skuId string and a stock object' });
    }
  }

  const updatedBy = req.session?.user?.email || 'unknown';
  let pool;
  try {
    pool = await getSqlPool();
    const result = await applyStockUpdates(pool, { rows, updatedBy, ppSessionId, fileName });
    res.json({ success: true, data: { ...result, updatedBy, updatedAt: new Date().toISOString() } });
  } catch (err) {
    console.error('❌ /api/bulk-update-stock error:', err.message, err.stack);
    const known = (err.status && err.status < 500) || err.status === 502;
    res.status(err.status || 500).json({
      success: false,
      error: known ? err.message : 'Something went wrong while updating stock, so nothing was changed. Please try again. If it keeps happening, contact the tech team.',
      technical: err.technical || (known ? undefined : err.message),
      details: err.details,
    });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/shopify-access-check ─────────────────────────────
// Diagnostic: API version in use, scopes the app really has (write_inventory
// is needed to set quantities AND to activate a location), and Shopify locations.
app.get('/api/shopify-access-check', requireAuth, async (req, res) => {
  try {
    res.json({ success: true, data: await checkShopifyAccess() });
  } catch (err) {
    console.error('❌ /api/shopify-access-check error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── GET /api/bulk-upload-history ──────────────────────────────
app.get('/api/bulk-upload-history', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT TOP 100
        SessionID, UploadedAt, UploadedBy,
        TotalRowsInCSV, UpdatedCount, UnidentifiedCount, FileName
      FROM BulkUploadSessions
      ORDER BY UploadedAt DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ /api/bulk-upload-history error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/bulk-upload-session/:sessionId/unidentified ──────
app.get('/api/bulk-upload-session/:sessionId/unidentified', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('SessionID', sql.NVarChar(36), sessionId)
      .query(`
        SELECT SKU, PP, UploadedAt, UploadedBy
        FROM UnIdentifiedProducts
        WHERE SessionID = @SessionID
        ORDER BY SKU
      `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error(`❌ /api/bulk-upload-session/${sessionId}/unidentified:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── GET /api/bulk-upload-session/:sessionId/export ────────────
app.get('/api/bulk-upload-session/:sessionId/export', requireAuth, async (req, res) => {
  const { sessionId } = req.params;
  let pool;
  try {
    pool = await getSqlPool();

    const sessionResult = await pool.request()
      .input('SessionID', sql.NVarChar(36), sessionId)
      .query(`SELECT UploadedAt FROM BulkUploadSessions WHERE SessionID = @SessionID`);

    const rowsResult = await pool.request()
      .input('SessionID', sql.NVarChar(36), sessionId)
      .query(`
        SELECT SKU, PP, UploadedAt, UploadedBy
        FROM UnIdentifiedProducts
        WHERE SessionID = @SessionID
        ORDER BY SKU
      `);

    const lines = ['SKU,PP,UploadedAt,UploadedBy'];
    for (const row of rowsResult.recordset) {
      const uploadedAt = row.UploadedAt ? new Date(row.UploadedAt).toISOString() : '';
      lines.push(`${row.SKU},${row.PP ?? ''},${uploadedAt},${row.UploadedBy}`);
    }

    const sessionDate = sessionResult.recordset[0]?.UploadedAt
      ? new Date(sessionResult.recordset[0].UploadedAt).toISOString().slice(0, 10)
      : 'unknown';

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="unidentified_skus_${sessionDate}.csv"`);
    res.send(lines.join('\n'));

  } catch (err) {
    console.error(`❌ /api/bulk-upload-session/${sessionId}/export:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});







// ── GET /api/app-settings/:key ──────────────────────────────────
app.get('/api/app-settings/:key', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('Key', sql.NVarChar(100), req.params.key)
      .query(`SELECT SettingKey, SettingValue, UpdatedAt, UpdatedBy FROM AppSettings WHERE SettingKey = @Key`);

    if (!result.recordset.length) {
      return res.status(404).json({ success: false, error: `Setting not found: ${req.params.key}` });
    }
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error('❌ /api/app-settings GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});





// ── PUT /api/app-settings/:key ──────────────────────────────────
app.put('/api/app-settings/:key', requireAuth, async (req, res) => {
  const { value } = req.body;
  if (value == null || value === '') {
    return res.status(400).json({ success: false, error: 'value is required' });
  }

  const updatedBy = req.session?.user?.email || 'unknown';
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('Key',       sql.NVarChar(100), req.params.key)
      .input('Value',     sql.NVarChar(100), String(value))
      .input('UpdatedBy', sql.NVarChar(150), updatedBy)
      .query(`
        UPDATE AppSettings
        SET SettingValue = @Value, UpdatedAt = GETDATE(), UpdatedBy = @UpdatedBy
        WHERE SettingKey = @Key;
        SELECT SettingKey, SettingValue, UpdatedAt, UpdatedBy FROM AppSettings WHERE SettingKey = @Key;
      `);

    if (!result.recordset.length) {
      return res.status(404).json({ success: false, error: `Setting not found: ${req.params.key}` });
    }
    console.log(`✅ /api/app-settings/${req.params.key} updated to ${value} by ${updatedBy}`);
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error('❌ /api/app-settings PUT error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});




// ── GET /api/category-settings ────────────────────────────────
app.get('/api/category-settings', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT
        cs.CategoryName,
        cs.GST,
        cs.CostOfBusiness,
        cs.ProfitMargin,
        cs.PPLookbackDays,
        cs.ScrapFreqDays,
        cs.IsScrapEnabled,
        cs.UpdatedAt,
        cs.UpdatedBy,
        MAX(ip.LastScrapedAt) AS LastScrapedAt
      FROM CategorySettings cs
      LEFT JOIN InternalProducts ip ON ip.Category = cs.CategoryName
      GROUP BY
        cs.CategoryName, cs.GST, cs.CostOfBusiness, cs.ProfitMargin,
        cs.PPLookbackDays, cs.ScrapFreqDays, cs.IsScrapEnabled,
        cs.UpdatedAt, cs.UpdatedBy
      ORDER BY cs.CategoryName
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});








// ── PUT /api/category-settings/:category ─────────────────────
app.put('/api/category-settings/:category', requireAuth, async (req, res) => {
  const categoryName = decodeURIComponent(req.params.category);
  const { GST, CostOfBusiness, ProfitMargin, PPLookbackDays, ScrapFreqDays, IsScrapEnabled } = req.body;
  const updatedBy = req.session?.user?.email || 'unknown';

  if (GST !== undefined && GST !== null) {
    const v = parseFloat(GST);
    if (isNaN(v) || v < 0 || v > 100) {
      return res.status(400).json({ success: false, error: 'GST must be between 0 and 100' });
    }
  }
  if (CostOfBusiness !== undefined && CostOfBusiness !== null) {
    const v = parseFloat(CostOfBusiness);
    if (isNaN(v) || v < 0 || v > 100) {
      return res.status(400).json({ success: false, error: 'CostOfBusiness must be between 0 and 100' });
    }
  }
  if (ProfitMargin !== undefined && ProfitMargin !== null) {
    const v = parseFloat(ProfitMargin);
    if (isNaN(v) || v < 0 || v > 100) {
      return res.status(400).json({ success: false, error: 'ProfitMargin must be between 0 and 100' });
    }
  }
  if (PPLookbackDays !== undefined && PPLookbackDays !== null) {
    const v = parseInt(PPLookbackDays);
    if (isNaN(v) || v < 1 || v > 365) {
      return res.status(400).json({ success: false, error: 'PPLookbackDays must be between 1 and 365' });
    }
  }
  if (ScrapFreqDays !== undefined && ScrapFreqDays !== null) {
    const v = parseInt(ScrapFreqDays);
    if (isNaN(v) || v < 1 || v > 365) {
      return res.status(400).json({ success: false, error: 'ScrapFreqDays must be between 1 and 365' });
    }
  }

  let pool;
  try {
    pool = await getSqlPool();

    const result = await pool.request()
      .input('CategoryName',    sql.NVarChar(200),  categoryName)
      .input('GST',             sql.Decimal(5, 2),  GST            ?? null)
      .input('CostOfBusiness',  sql.Decimal(5, 2),  CostOfBusiness ?? null)
      .input('ProfitMargin',    sql.Decimal(5, 2),  ProfitMargin   ?? null)
      .input('PPLookbackDays',  sql.Int,             PPLookbackDays ?? null)
      .input('ScrapFreqDays',   sql.Int,             ScrapFreqDays  ?? 7)
      .input('IsScrapEnabled',  sql.Bit,             IsScrapEnabled ?? 1)
      .input('UpdatedBy',       sql.NVarChar(150),   updatedBy)
      .query(`
        MERGE CategorySettings AS target
        USING (SELECT @CategoryName AS CategoryName) AS source
          ON target.CategoryName = source.CategoryName

        WHEN MATCHED THEN
          UPDATE SET
            GST            = @GST,
            CostOfBusiness = @CostOfBusiness,
            ProfitMargin   = @ProfitMargin,
            PPLookbackDays = @PPLookbackDays,
            ScrapFreqDays  = @ScrapFreqDays,
            IsScrapEnabled = @IsScrapEnabled,
            UpdatedAt      = GETDATE(),
            UpdatedBy      = @UpdatedBy

        WHEN NOT MATCHED THEN
          INSERT (CategoryName, GST, CostOfBusiness, ProfitMargin, PPLookbackDays,
                  ScrapFreqDays, IsScrapEnabled, UpdatedAt, UpdatedBy)
          VALUES (@CategoryName, @GST, @CostOfBusiness, @ProfitMargin, @PPLookbackDays,
                  @ScrapFreqDays, @IsScrapEnabled, GETDATE(), @UpdatedBy);

        SELECT CategoryName, GST, CostOfBusiness, ProfitMargin, PPLookbackDays,
               ScrapFreqDays, IsScrapEnabled, UpdatedAt, UpdatedBy
        FROM CategorySettings
        WHERE CategoryName = @CategoryName;
      `);

    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});












// ── GET /api/users ────────────────────────────────────────────
app.get('/api/users', requireRole('admin'), async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT Email, Role, AddedBy, AddedAt, UpdatedBy, UpdatedAt
      FROM UserRoles
      ORDER BY AddedAt DESC
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ /api/users GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── POST /api/users ───────────────────────────────────────────
app.post('/api/users', requireRole('admin'), async (req, res) => {
  const { email, role } = req.body;
  if (!email || !role) {
    return res.status(400).json({ success: false, error: 'email and role are required' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const validRoles = ['admin', 'supervisor', 'sales'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ success: false, error: `role must be one of: ${validRoles.join(', ')}` });
  }

  const addedBy = req.session.user.email;
  let pool;
  try {
    pool = await getSqlPool();
    await pool.request()
      .input('Email',   sql.NVarChar(255), normalizedEmail)
      .input('Role',    sql.NVarChar(50),  role)
      .input('AddedBy', sql.NVarChar(255), addedBy)
      .query(`
        MERGE UserRoles AS target
        USING (SELECT @Email AS Email) AS source
          ON target.Email = source.Email
        WHEN MATCHED THEN
          UPDATE SET
            Role      = @Role,
            UpdatedBy = @AddedBy,
            UpdatedAt = GETDATE()
        WHEN NOT MATCHED THEN
          INSERT (Email, Role, AddedBy)
          VALUES (@Email, @Role, @AddedBy);
      `);

    console.log(`✅ /api/users — upserted: ${normalizedEmail} as ${role} by ${addedBy}`);
    res.json({ success: true, data: { email: normalizedEmail, role } });
  } catch (err) {
    console.error('❌ /api/users POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── DELETE /api/users/:email ──────────────────────────────────
app.delete('/api/users/:email', requireRole('admin'), async (req, res) => {
  const targetEmail = decodeURIComponent(req.params.email).toLowerCase();
  const selfEmail   = req.session.user.email;

  if (targetEmail === selfEmail) {
    return res.status(400).json({ success: false, error: 'You cannot remove yourself' });
  }

  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('Email', sql.NVarChar(255), targetEmail)
      .query(`DELETE FROM UserRoles WHERE Email = @Email`);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    console.log(`✅ /api/users DELETE — removed: ${targetEmail} by ${selfEmail}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`❌ /api/users DELETE error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});


// ── POST /api/run-recommendation-engine ───────────────────────
const activeJobs = new Map();

app.post('/api/run-recommendation-engine', requireAuth, async (req, res) => {
  const id         = uuidv4();
  const startedBy  = req.session?.user?.email || 'unknown';

  const alreadyRunning = [...activeJobs.values()].find(j => j.status === 'running');
  if (alreadyRunning) {
    return res.status(409).json({
      success: false,
      error  : 'Recommendation engine is already running. Wait for it to finish.'
    });
  }

  activeJobs.set(id, {
    status    : 'running',
    startedAt : new Date().toISOString(),
    startedBy,
    updatedCount: null,
    error     : null,
    finishedAt: null,
  });

  console.log(`🚀 Recommendation engine triggered by ${startedBy} | job=${id}`);

  (async () => {
    const job = activeJobs.get(id);
    try {
      const pool = await getSqlPool();

      const categorySettings = await loadCategorySettings(pool);
      const internalProducts = await loadInternalProducts(pool);
      const competitorRows   = await loadCompetitorPrices(pool);
      const competitorMap    = buildCompetitorMap(competitorRows);
      const recommendations  = generateRecommendations(internalProducts, competitorMap, categorySettings);
      await updateRecommendedSP(pool, recommendations);
      await pool.close();

      job.status       = 'done';
      job.updatedCount = recommendations.length;
      job.finishedAt   = new Date().toISOString();
      console.log(`✅ Recommendation engine done | job=${id} | updated=${recommendations.length}`);

    } catch (err) {
      job.status     = 'error';
      job.error      = err.message;
      job.finishedAt = new Date().toISOString();
      console.error(`❌ Recommendation engine failed | job=${id}:`, err.message);
    }
  })();

  res.json({ success: true, jobId: id });
});


// ── GET /api/recommendation-job/:jobId ────────────────────────
app.get('/api/recommendation-job/:jobId', requireAuth, (req, res) => {
  const job = activeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: job });
});


// ─────────────────────────────────────────────────────────────
// SCRAPER ROUTES
// ─────────────────────────────────────────────────────────────

const scraperJobs = new Map();
// Structure: jobId → {
//   status         : 'running' | 'done' | 'error' | 'cancelled',
//   startedAt      : ISO string,
//   startedBy      : email,
//   cancelRequested: boolean,
//   logs           : string[],  ← captured log lines for UI
//   error          : null | string,
//   finishedAt     : null | ISO string,
// }





const COMPLETED_LOCK_HOURS = 48; // a successfully-done category stays locked this long

// A category is blocked if some job for it is 'running', or finished
// 'done' within the last 48h. 'error'/'cancelled' jobs never block.
function findCategoryConflicts(categoryNames) {
  const requested = new Set(categoryNames);
  const conflicts = [];
  const now = Date.now();

  for (const category of requested) {
    let blockingJob = null;

    for (const job of scraperJobs.values()) {
      if (!job.categoryNames?.includes(category)) continue;

      if (job.status === 'running') {
        blockingJob = job;
        break;
      }

      const actuallySucceeded = !job.succeededCategories || job.succeededCategories.includes(category);
      if (job.status === 'done' && job.finishedAt && actuallySucceeded) {
        const hoursSince = (now - new Date(job.finishedAt).getTime()) / 3_600_000;
        if (hoursSince < COMPLETED_LOCK_HOURS &&
            (!blockingJob || new Date(job.finishedAt) > new Date(blockingJob.finishedAt))) {
          blockingJob = job;
        }
      }
    }

    if (blockingJob) {
      conflicts.push({
        categoryName: category,
        status      : blockingJob.status,
        startedBy   : blockingJob.startedBy,
        startedAt   : blockingJob.startedAt,
        finishedAt  : blockingJob.finishedAt,
      });
    }
  }

  return conflicts;
}





// ── POST /api/run-scraper ─────────────────────────────────────
// Triggers the full scheduler (all due categories) on demand.
// Role gate: admin + supervisor only.
app.post('/api/run-scraper', requireRole(['admin', 'supervisor']), async (req, res) => {
  const id        = uuidv4();
  const startedBy = req.session?.user?.email || 'unknown';

  const categoryNames = Array.isArray(req.body?.categoryNames)
  ? req.body.categoryNames
  : [];

if (categoryNames.length === 0) {
  return res.status(400).json({
    success: false,
    error: 'Select at least one category to scrape.',
  });
}

  // const alreadyRunning = [...scraperJobs.values()].find(j => j.status === 'running');
  // if (alreadyRunning) {
  //   return res.status(409).json({
  //     success: false,
  //     error  : 'Scraper is already running. Wait for it to finish.',
  //   });
  // }


  const conflicts = findCategoryConflicts(categoryNames);
  if (conflicts.length > 0) {
    return res.status(409).json({
      success: false,
      error: `${conflicts.length} selected categor${conflicts.length === 1 ? 'y is' : 'ies are'} already in progress or recently completed.`,
      conflicts,
    });
  }

  const job = {
    status         : 'running',
    startedAt      : new Date().toISOString(),
    startedBy,
    categoryNames,
    cancelRequested: false,
    logs           : [],
    error          : null,
    finishedAt     : null,
  };
  scraperJobs.set(id, job);

  // Custom logger — captures to job.logs[] AND console
  function jobLog(msg) {
    const timestamp = new Date().toLocaleTimeString('en-IN', { hour12: false });
    const line = `[${timestamp}] ${msg}`;
    console.log(line);
    job.logs.push(line);
  }

  jobLog(`🚀 Scraper started by ${startedBy}`);
  console.log(`🚀 Manual scraper triggered by ${startedBy} | job=${id}`);

  // Fire and forget
  (async () => {
    try {
//       await runManualScraper({
//   categoryNames,
//   log        : jobLog,
//   isCancelled: () => job.cancelRequested,
// });

//
const outcome = await runManualScraper({
  categoryNames,
  log        : jobLog,
  isCancelled: () => job.cancelRequested,
  runId      : id,
  startedBy,
  runStartedAt: new Date(job.startedAt),
});
//
      job.succeededCategories = outcome?.succeededCategories || [];
      job.failedCategories    = outcome?.failedCategories || [];

      if (job.cancelRequested) {
        job.status     = 'cancelled';
        job.finishedAt = new Date().toISOString();
        jobLog('🛑 Scraper was cancelled by user.');
        console.log(`🛑 Scraper cancelled | job=${id}`);
      } else if (job.succeededCategories.length === 0 && job.failedCategories.length > 0) {
        job.status     = 'error';
        job.error      = `0 products scraped for: ${job.failedCategories.join(', ')} — likely Bright Data throttling/blocking, not empty categories.`;
        job.finishedAt = new Date().toISOString();
        jobLog(`❌ ${job.error}`);
        console.log(`❌ Manual scraper produced no data | job=${id}`);
      } else {
        job.status     = 'done';
        job.finishedAt = new Date().toISOString();
        if (job.failedCategories.length > 0) {
          jobLog(`⚠️  Completed with partial failures — no data for: ${job.failedCategories.join(', ')} (not locked, safe to retry).`);
        }
        jobLog('✅ Scraper completed successfully.');
        console.log(`✅ Manual scraper done | job=${id}`);
      }
    } catch (err) {
      job.status     = 'error';
      job.error      = err.message;
      job.finishedAt = new Date().toISOString();
      jobLog(`❌ Fatal error: ${err.message}`);
      console.error(`❌ Manual scraper failed | job=${id}:`, err.message);
    }
  })();

  res.json({ success: true, jobId: id });
});




// ── GET /api/scraper-jobs/active ───────────────────────────────
// Global, cross-user view — any logged-in user can see this. Shows
// the last 10 jobs regardless of status/age. Blocking (above) always
// scans the full Map, independent of this 10-item display cap.
app.get('/api/scraper-jobs/active', requireAuth, (req, res) => {
  const jobs = [...scraperJobs.entries()]
    .map(([jobId, job]) => ({
      jobId,
      status       : job.status,
      startedBy    : job.startedBy,
      categoryNames: job.categoryNames || [],
      startedAt    : job.startedAt,
      finishedAt   : job.finishedAt,
      error        : job.error,
      failedCategories: job.failedCategories || [],
    }))
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, 10);

  res.json({ success: true, data: jobs });
});





// ── GET /api/scraper-job/:jobId ───────────────────────────────
app.get('/api/scraper-job/:jobId', requireRole(['admin', 'supervisor']), (req, res) => {
  const job = scraperJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  res.json({ success: true, data: job });
});


// ── POST /api/scraper-job/:jobId/cancel ───────────────────────
// Sets cancelRequested = true. Scheduler stops after current category.
app.post('/api/scraper-job/:jobId/cancel', requireRole(['admin', 'supervisor']), (req, res) => {
  const job = scraperJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });
  if (job.status !== 'running') {
    return res.status(400).json({ success: false, error: 'Job is not running' });
  }

  job.cancelRequested = true;
  const cancelledBy = req.session?.user?.email || 'unknown';
  const timestamp = new Date().toLocaleTimeString('en-IN', { hour12: false });
  job.logs.push(`[${timestamp}] 🛑 Cancel requested by ${cancelledBy} — will stop shortly (finishing current in-flight requests).`);

  console.log(`🛑 Scraper cancel requested by ${cancelledBy} | job=${req.params.jobId}`);
  res.json({ success: true, message: 'Cancel requested — scraper will stop shortly, after finishing current in-flight requests.' });
});





// ── GET /api/scraper-job/:jobId/logs ──────────────────────────
// Returns captured log lines. Frontend polls this every 3s.
// Pass ?from=N to get only lines after index N (reduces payload).
app.get('/api/scraper-job/:jobId/logs', requireRole(['admin', 'supervisor']), (req, res) => {
  const job = scraperJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

  const from  = parseInt(req.query.from) || 0;
  const lines = job.logs.slice(from);

  res.json({
    success: true,
    data: {
      lines,
      total : job.logs.length,
      status: job.status,
    },
  });
});







app.get('/api/scraper-categories',requireRole(['admin', 'supervisor']),
  async (req, res) => {
    try {
      const data = await getManualScraperCategories();
      res.json({ success: true, data });
    } catch (err) {
      console.error('❌ /api/scraper-categories error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  }
);

app.get('/api/scrape-stats/runs', requireRole(['admin', 'supervisor']), async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const data = await getRecentRuns(pool, parseInt(req.query.limit) || 25);
    res.json({ success: true, data });
  } catch (err) {
    console.error('❌ /api/scrape-stats/runs error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});

app.get('/api/scrape-stats/:runId', requireRole(['admin', 'supervisor']), async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const data = await getRunDetail(pool, req.params.runId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('❌ /api/scrape-stats/:runId error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});

app.get('/api/scrape-stats/:runId/sku-matches.csv', requireRole(['admin', 'supervisor']), async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const { runId, rows } = await getRunSkuMatches(pool, req.params.runId);
    const csv = buildSkuMatchesCsv(rows);

    const filename = `scrape-sku-matches-${runId || 'none'}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('❌ /api/scrape-stats/:runId/sku-matches.csv error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});



app.get('/api/scrape-stats/:runId/sku-matches', requireRole(['admin', 'supervisor']), async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const data = await getRunSkuMatches(pool, req.params.runId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('❌ /api/scrape-stats/:runId/sku-matches error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});



// ── GET /api/health ───────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});





// ─────────────────────────────────────────────────────────────
// CATEGORY MAPPING ROUTES
// ─────────────────────────────────────────────────────────────

// ── GET /api/store-categories ─────────────────────────────────
// Returns all store+slug pairs from urls.js as a flat list.
// This is the "source" side of the mapping UI.
app.get('/api/store-categories', requireRole(['admin', 'supervisor']), (req, res) => {
  const flat = [];
  for (const store of STORES) {
    for (const category of store.categories) {
      flat.push({
        storeName: store.name,
        storeSlug: category.slug,
        storeUrl : category.url,
      });
    }
  }
  // Deduplicate — vedant has duplicate ssd/hdd entries in urls.js
  const seen = new Set();
  const deduped = flat.filter(entry => {
    const key = `${entry.storeName}::${entry.storeSlug}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  res.json({ success: true, data: deduped });
});


// ── GET /api/category-mappings ────────────────────────────────
// Returns all saved mappings from CategoryMappings table.
app.get('/api/category-mappings', requireRole(['admin', 'supervisor']), async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request().query(`
      SELECT ID, InternalCategory, StoreName, StoreSlug, MappedBy, MappedAt
      FROM CategoryMappings
      ORDER BY InternalCategory, StoreName, StoreSlug
    `);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error('❌ /api/category-mappings GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});



// ── POST /api/category-mappings ───────────────────────────────
// Many-to-many: always INSERTs a new row unless the exact triple
// (StoreName + StoreSlug + InternalCategory) already exists.
app.post('/api/category-mappings', requireRole(['admin', 'supervisor']), async (req, res) => {
  const { internalCategory, storeName, storeSlug } = req.body;

  if (!internalCategory || !storeName || !storeSlug) {
    return res.status(400).json({
      success: false,
      error: 'internalCategory, storeName, and storeSlug are all required',
    });
  }

  const mappedBy = req.session?.user?.email || 'unknown';
  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('InternalCategory', sql.NVarChar(200), internalCategory)
      .input('StoreName',        sql.NVarChar(100), storeName)
      .input('StoreSlug',        sql.NVarChar(200), storeSlug)
      .input('MappedBy',         sql.NVarChar(150), mappedBy)
      .query(`
        -- Insert only if this exact triple doesn't exist yet (ignore duplicates)
        IF NOT EXISTS (
          SELECT 1 FROM CategoryMappings
          WHERE StoreName        = @StoreName
            AND StoreSlug        = @StoreSlug
            AND InternalCategory = @InternalCategory
        )
        BEGIN
          INSERT INTO CategoryMappings (InternalCategory, StoreName, StoreSlug, MappedBy)
          VALUES (@InternalCategory, @StoreName, @StoreSlug, @MappedBy);
        END

        SELECT ID, InternalCategory, StoreName, StoreSlug, MappedBy, MappedAt
        FROM CategoryMappings
        WHERE StoreName        = @StoreName
          AND StoreSlug        = @StoreSlug
          AND InternalCategory = @InternalCategory;
      `);

    console.log(`✅ /api/category-mappings — mapped ${storeName}/${storeSlug} → ${internalCategory} by ${mappedBy}`);
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error('❌ /api/category-mappings POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});





// ── DELETE /api/category-mappings/:id ────────────────────────
// Removes a mapping by its ID.
app.delete('/api/category-mappings/:id', requireRole(['admin', 'supervisor']), async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ success: false, error: 'Invalid ID' });
  }

  let pool;
  try {
    pool = await getSqlPool();
    const result = await pool.request()
      .input('ID', sql.Int, id)
      .query(`DELETE FROM CategoryMappings WHERE ID = @ID`);

    if (result.rowsAffected[0] === 0) {
      return res.status(404).json({ success: false, error: 'Mapping not found' });
    }

    console.log(`✅ /api/category-mappings DELETE — ID=${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`❌ /api/category-mappings DELETE error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});









// ── POST /api/push-to-shopify ─────────────────────────────────
app.post('/api/push-to-shopify', requireAuth, async (req, res) => {
  const { skuId, sp, isManual, confirmVariance } = req.body;

  if (!skuId || sp == null) {
    return res.status(400).json({ success: false, error: 'skuId and sp are required' });
  }
  const parsedSP = parseFloat(sp);
  if (isNaN(parsedSP) || parsedSP <= 0) {
    return res.status(400).json({ success: false, error: 'sp must be a positive number' });
  }

  const pushedBy = req.session?.user?.email || 'unknown';
  let pool;
  try {
    pool = await getSqlPool();

    // ── Variance check — against your own DB, before Shopify is touched at all ──
    const checkRow = await pool.request()
      .input('SKU_ID', sql.NVarChar(100), skuId)
      .query(`SELECT RecommendedSP, SP FROM InternalProducts WHERE SKU_ID = @SKU_ID`); // ← added SP

    if (!checkRow.recordset.length) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }

    const currentSP = checkRow.recordset[0].SP; // ← NEW: value before this push, for OldSellingPrice
    const systemSPRaw = checkRow.recordset[0].RecommendedSP;
    let systemSP = systemSPRaw != null ? parseFloat(systemSPRaw) : null;

    // No stored recommendation (e.g. SKU opened from the Insights modal
    // before any engine run persisted one)? Compute it live instead of
    // silently skipping the % variance check.
    if (systemSP === null || isNaN(systemSP) || systemSP <= 0) {
      try {
        const live = await computeLiveRecommendedSPForSku(pool, skuId);
        if (live != null && !isNaN(live) && live > 0) {
          systemSP = live;
          try {
            await persistRecommendedSP(pool, [{ SKU_ID: skuId, RecommendedSP: live }]);
          } catch (_) { /* best-effort */ }
        }
      } catch (liveErr) {
        console.error(`⚠️ push-to-shopify: live RecommendedSP fallback failed for ${skuId}:`, liveErr.message);
      }
    }

    const VARIANCE_THRESHOLD = await getNumericSetting(pool, 'VARIANCE_THRESHOLD', 0.10);
    let variance = 0;
    let requiresConfirm = false;

    if (systemSP === null || isNaN(systemSP) || systemSP <= 0) {
      requiresConfirm = true;
    } else {
      variance = Math.abs(parsedSP - systemSP) / systemSP;
      requiresConfirm = variance > VARIANCE_THRESHOLD;
    }

    if (requiresConfirm && !confirmVariance) {
      return res.status(422).json({
        success: false,
        error: 'variance_check_failed',
        message: systemSP
          ? `Entered SP (₹${parsedSP}) differs from system RecommendedSP (₹${systemSP}) by ${(variance * 100).toFixed(1)}%. Confirm to proceed.`
          : `No system-calculated RecommendedSP is stored for this SKU yet — please confirm ₹${parsedSP} is correct before pushing.`,
        systemSP,
      });
    }

    // Push to Shopify first — don't touch SQL if this fails
    await pushPriceToShopify(skuId, parsedSP);

    const request = pool.request()
      .input('SKU_ID',          sql.NVarChar(100),  skuId)
      .input('SP',              sql.Decimal(10, 2), parsedSP)
      .input('OldSellingPrice', sql.Decimal(10, 2), currentSP) // ← NEW
      .input('PushedBy',        sql.NVarChar(150),  pushedBy);

    let updateQuery = `
      UPDATE InternalProducts
      SET ShopifyPushedSP = @SP, ShopifyPushedAt = GETDATE(),
          ShopifyPushedBy = @PushedBy, ShopifyPushStatus = 'success',
          OldSellingPrice = @OldSellingPrice
    `;
    if (isManual) {
      updateQuery += `,
          ManualRecommendedSP = @SP, ManualRecommendedSP_UpdatedAt = GETDATE(),
          ManualRecommendedSP_UpdatedBy = @PushedBy
      `;
    }
    updateQuery += ` WHERE SKU_ID = @SKU_ID;
      SELECT SKU_ID, RecommendedSP, ManualRecommendedSP, ShopifyPushedSP, ShopifyPushedAt, OldSellingPrice
      FROM InternalProducts WHERE SKU_ID = @SKU_ID;
    `;

    const result = await request.query(updateQuery);

    console.log(`✅ Pushed to Shopify: SKU=${skuId} | SP=₹${parsedSP} (was ₹${currentSP ?? 'N/A'}) | By=${pushedBy} | Manual=${!!isManual}`);
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error(`❌ /api/push-to-shopify error for ${skuId}:`, err.message);
    try {
      const failPool = await getSqlPool();
      await failPool.request()
        .input('SKU_ID', sql.NVarChar(100), skuId)
        .query(`UPDATE InternalProducts SET ShopifyPushStatus = 'failed' WHERE SKU_ID = @SKU_ID`);
    } catch (_) {}
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (pool) await pool.close();
  }
});




// error logging — after all routes
app.use((err, req, res, next) => {
  log('ERROR', 'app.js', 'errorHandler', err.stack || err.message);
  // 4xx raised by middleware (e.g. "request entity too large") keeps its real status and message
  if (err && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ success: false, error: err.message });
  }
  res.status(500).json({ error: 'Internal Server Error' });
});





app.listen(PORT, () => {
  console.log(`🚀 API server running at http://localhost:${PORT}`);
  console.log(`   GET  http://localhost:${PORT}/api/recommendations`);
  console.log(`   POST http://localhost:${PORT}/api/refresh-product`);
  console.log(`   GET  http://localhost:${PORT}/api/health`);
});