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
  loadAllInternalProducts,
  loadActiveInStockInternalProducts,
  loadInternalProductBySku
} = require('./recommendation_engine');


const {
  getInsights, getInsightCounts, getInsightsExport, buildInsightsExportCsv,
  dismissInsight, bulkDismissInsights,
} = require('./services/insightsService');

const { scrapeProduct }    = require('./scraper/scrapeProduct');
const { upsertOneProduct } = require('./services/competitorPriceService');
const { STORES }           = require('./urls');
const { computeRecommendedSP, computeFloor, getProductWeightKg } = require('./services/pricing');
const { getGlobalScrapeLimiter } = require('./scraper/concurrency');
const { runScheduler,runManualScraper, getManualScraperCategories, }     = require('./scheduler/index'); // ← ADDED

const session        = require('express-session');
const { msalClient } = require('./auth/msalConfig');
const { requireAuth } = require('./auth/authMiddleware');
const { requireRole } = require('./auth/authMiddleware');
const { getUserScope, partitionSkus, requireWriteAccess } = require('./services/accessScope'); // category/brand RBAC

// Audit log (dbo.AuditEvents) — see src/audit/auditService.js
const audit = require('./audit/auditService');
const { MODULES, ACTIONS, SOURCES, STATUS } = audit;

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

// Production (Azure, https, cross-site SWA -> App Service) needs secure + SameSite=None.
// Local http://localhost needs secure:false + lax, otherwise the browser drops the cookie.
const isProd = process.env.AZURE_ENV === 'production';

app.use(session({
  secret           : process.env.SESSION_SECRET || 'dev-secret-change-in-prod',
  resave           : false,
  saveUninitialized: false,
  cookie: {
    secure  : isProd,
    sameSite: isProd ? 'none' : 'lax',
    httpOnly: true,
    maxAge  : 24 * 60 * 60 * 1000, // 24 hours
  },
}));




app.use('/api/sync', require('./routes/syncRoutes'));

// Admin-only, read-only category/brand -> salesperson mapping (Settings tab)
app.use('/api/salesperson-mapping', requireRole('admin'),
        require('./routes/salespersonMappingRoutes')(getSqlPool));

// Brand-wise business variables (Settings → Business Variables)
app.use('/api/business-variables', requireAuth,
        require('./routes/businessVariablesRoutes')(getSqlPool));

// Admin-only audit log: filterable events + activity feed (read-only)
app.use('/api/audit', requireRole('admin'),
        require('./routes/auditRoutes')(getSqlPool));




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

    // Shared pool: never close it per request
    const pool = await getSqlPool();
    const roleResult = await pool.request()
      .input('Email', sql.NVarChar(255), email)
      .query(`SELECT Role FROM UserRoles WHERE Email = @Email`);

    const who = {
      actorEmail: email,
      actorName : response.account.name || null,
      ipAddress : audit.clientIp(req),
    };

    if (!roleResult.recordset.length) {
      await audit.recordSafe(pool, {
        ...who, module: MODULES.AUTH, action: ACTIONS.LOGIN_DENIED, source: SOURCES.UI,
        status: STATUS.DENIED, entityType: 'USER', entityId: email,
        summary: `Sign-in refused: ${email} is not in the system`,
      });
      return res.status(403).send(`<h2>Access denied</h2><p>${email} is not in the system.</p>`);
    }

    const role = roleResult.recordset[0].Role;
    req.session.user = { name: response.account.name, email, role };

    await audit.recordSafe(pool, {
      ...who, actorRole: role, module: MODULES.AUTH, action: ACTIONS.LOGIN, source: SOURCES.UI,
      entityType: 'USER', entityId: email,
      summary: `${response.account.name || email} signed in`,
      details: { sessionId: req.sessionID },
    });

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
  }
});

// ── POST /auth/logout ─────────────────────────────────────────
app.post('/auth/logout', async (req, res) => {
  const u = req.session?.user;
  const sessionId = req.sessionID;
  if (u) {
    try {
      const pool = await getSqlPool();
      await audit.recordSafe(pool, {
        ...audit.actorFromReq(req), module: MODULES.AUTH, action: ACTIONS.LOGOUT, source: SOURCES.UI,
        entityType: 'USER', entityId: u.email,
        summary: `${u.name || u.email} signed out`,
        details: { sessionId },
      });
    } catch (err) {
      console.error('⚠️ logout audit skipped:', err.message);
    }
  }
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
    'theitdepot.com'       : 'theitdepot',
    'computechstore.in'    : 'computechstore',
    'varietyinfotech.com'  : 'varietyinfotech',
    'ugreenindia.com'      : 'ugreenindia',
    'amazon.in'            : 'amazon',
    'elitehubs.com'        : 'elitehubs',
  };
  for (const [domain, storeName] of Object.entries(domainMap)) {
    if (productUrl.includes(domain)) {
      return STORES.find(s => s.name === storeName) || null;
    }
  }
  return null;
}

// ── Helper: recalculate RecommendedSP for one SKU ────────────
// Uses the SAME business variables (brand → category → default) and the SAME
// shared pricing function as the Basic list, so a row refresh can never
// disagree with the table. (This used to hardcode 18/7/5.)
async function recalculateRecommendedSP(pool, skuId) {
  const product = await loadInternalProductBySku(pool, skuId);
  if (!product || product.PP == null) return null;

  const categorySettings = await loadCategorySettings(pool);
  const summaryMap       = await loadCompetitorSummaryMap(pool, skuId);
  const row = buildBasicRecommendationRow(product, categorySettings, summaryMap.get(normSku(skuId)));

  await persistRecommendedSP(pool, [row]);
  return row.RecommendedSP;
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
app.get('/api/recommendations', requireAuth, async (req, res) => {
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
    // Floor + breakdown come from the shared pricing function (same formula as
    // everywhere else), so "Extra Profit" = how far the recommended price sits
    // above the real floor, and the tooltip shows the real percentages.
    const categorySettings = await loadCategorySettings(pool);
    const rows = result.recordset.map((r) => {
      const vars = getBusinessVars(categorySettings, r.Category, r.Brand);
      const { baseFloor, breakdown } = computeFloor({
        pp: parseFloat(r.PP), vars, weightKg: getProductWeightKg(r),
      });
      return {
        ...r,
        BaseFloor     : baseFloor,
        ExtraProfitPct: baseFloor > 0
          ? parseFloat((((r.RecommendedSP - baseFloor) / baseFloor) * 100).toFixed(2))
          : null,
        GSTPct        : breakdown.gstPct,
        COBPct        : breakdown.cobPct,
        MarginPct     : breakdown.marginPct,
        ShopifyFeePct : breakdown.shopifyFeePct,
        GatewayPct    : breakdown.paymentGatewayPct,
        PackingCost   : breakdown.packingCost,
        ShippingCost  : breakdown.shippingCost,
        WeightKg      : breakdown.weightKg,
      };
    });

    const scope = await getUserScope(req);
    const visibleRows = scope.filterRows(rows);
    console.log(`✅ /api/recommendations — ${visibleRows.length} rows served`);
    res.json({ success: true, data: visibleRows });
  } catch (err) {
    console.error('❌ API error:', err.message, '| line:', err.lineNumber);
    console.error('❌ API error:', err.message);
    res.status(500).json({ success: false, error: err.message });
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






const normSku = (v) => String(v || '').trim().toUpperCase();

// ── Competitor summary per SKU (for the Basic table) ─────────────────
// "Matched" = the SKU has at least one row in CompetitorPrices (SKU match
// only — no other condition). One query for all SKUs, or for one SKU.
// Returns Map(normalisedSKU → { storeCount, lowestPrice, storeName, stockStatus })
// lowestPrice / storeName / stockStatus describe the lowest IN-STOCK
// competitor; they are null when the SKU is matched but every store is
// out of stock (the row is still "matched").
async function loadCompetitorSummaryMap(pool, skuId = null) {
  const request = pool.request();
  let where = '';
  if (skuId) {
    request.input('SKU', sql.NVarChar(100), skuId);
    where = 'WHERE SKU = @SKU';
  }
  const result = await request.query(`
    WITH ranked AS (
      SELECT SKU, CompetitorPrice, StoreName, StockStatus,
        COUNT(*) OVER (PARTITION BY SKU) AS StoreCount,
        ROW_NUMBER() OVER (
          PARTITION BY SKU
          ORDER BY
            CASE WHEN CompetitorPrice IS NOT NULL
                  AND StockStatus IS NOT NULL
                  AND LOWER(StockStatus) <> 'out of stock' THEN 0 ELSE 1 END,
            CompetitorPrice ASC
        ) AS rn
      FROM CompetitorPrices
      ${where}
    )
    SELECT SKU, CompetitorPrice, StoreName, StockStatus, StoreCount
    FROM ranked
    WHERE rn = 1
  `);

  const map = new Map();
  for (const r of result.recordset) {
    const inStock = r.CompetitorPrice != null
      && r.StockStatus != null
      && String(r.StockStatus).toLowerCase().trim() !== 'out of stock';
    map.set(normSku(r.SKU), {
      storeCount : Number(r.StoreCount) || 0,
      lowestPrice: inStock ? parseFloat(r.CompetitorPrice) : null,
      storeName  : inStock ? r.StoreName : null,
      stockStatus: inStock ? r.StockStatus : null,
    });
  }
  return map;
}

// ── Build ONE Basic Recommendations row ───────────────────────
// Shared by the list endpoint, the single-row endpoint, the row Refresh and
// recalculateRecommendedSP so every path produces the same shape and math.
// `competitor` is optional (from loadCompetitorSummaryMap): matched SKUs
// get the competitor-aware recommendation, unmatched ones the plain floor.
function buildBasicRecommendationRow(product, categorySettings, competitor = null) {
  const base = {
    SKU_ID   : product.SKU_ID,
    Title    : product.Title,
    Category : product.Category,
    Brand    : product.Brand,
    isActive : product.isActive,
    isInStock: product.isInStock,
    SP       : product.SP != null ? parseFloat(product.SP) : null,
    // Competitor info (display only — empty when the SKU is not matched)
    HasCompetitor        : !!competitor,
    CompetitorCount      : competitor ? competitor.storeCount : 0,
    CompetitorPrice      : competitor ? competitor.lowestPrice : null,
    StoreName            : competitor ? competitor.storeName : null,
    CompetitorStockStatus: competitor ? competitor.stockStatus : null,
  };

  // No PP yet (bill not received / never set) — can't compute a
  // RecommendedSP. Still show the row (and its competitor prices) so the
  // user can set the PP from it.
  if (product.PP == null) {
    return {
      ...base,
      PP             : null,
      PPSource       : null,
      RecommendedSP  : null,
      BaseFloor      : null,
      PricingStrategy: null,
      ExtraProfitPct : null,
      GSTPct         : null,
      COBPct         : null,
      MarginPct      : null,
      ShopifyFeePct  : null,
      GatewayPct     : null,
      PackingCost    : null,
      ShippingCost   : null,
      WeightKg       : null,
    };
  }

  const { effectivePP, source } = resolveEffectivePP(product);
  const vars = getBusinessVars(categorySettings, product.Category, product.Brand);

  const { recommendedSP, baseFloor, pricingStrategy, breakdown } = computeRecommendedSP({
    pp: effectivePP,
    vars,                                   // GST / COB / margin + global costs
    lowestCompetitorPrice: competitor ? competitor.lowestPrice : null,
    weightKg: getProductWeightKg(product),  // null until the weight view is wired in
  });

  return {
    ...base,
    PP             : effectivePP,
    PPSource       : source,
    RecommendedSP  : recommendedSP,
    BaseFloor      : baseFloor,
    PricingStrategy: pricingStrategy,
    ExtraProfitPct : baseFloor > 0
      ? parseFloat((((recommendedSP - baseFloor) / baseFloor) * 100).toFixed(2))
      : null,
    // Breakdown shown in the Recommended SP tooltip
    GSTPct         : breakdown.gstPct,
    COBPct         : breakdown.cobPct,
    MarginPct      : breakdown.marginPct,
    ShopifyFeePct  : breakdown.shopifyFeePct,
    GatewayPct     : breakdown.paymentGatewayPct,
    PackingCost    : breakdown.packingCost,
    ShippingCost   : breakdown.shippingCost,   // null = no weight data yet
    WeightKg       : breakdown.weightKg,
  };
}

// ── GET /api/internal-recommendations ─────────────────────────
// Basic Recommendations: ACTIVE + IN-STOCK products (PP may or may not be
// set — rows without PP are listed so the PP can be set from the row).
// Every row also carries its competitor summary when the SKU is matched with
// any competitor (SKU match only). Matched rows get the competitor-aware
// Recommended SP (1% below the lowest in-stock competitor, never below the
// floor); unmatched rows get the plain floor.
// Computed live on every request, and persisted to SQL so the variance
// check on push has a real value to compare against.
app.get('/api/internal-recommendations', requireAuth, async (req, res) => {
  let pool;
  try {
    pool = await getSqlPool();

    const categorySettings = await loadCategorySettings(pool);
    const internalProducts = await loadActiveInStockInternalProducts(pool);
    const competitorMap    = await loadCompetitorSummaryMap(pool);

    const rows = internalProducts.map(product =>
      buildBasicRecommendationRow(product, categorySettings, competitorMap.get(normSku(product.SKU_ID)))
    );

    // Persist so the variance check on push has a real value to compare against.
    try {
      await persistRecommendedSP(pool, rows);
    } catch (persistErr) {
      console.error('⚠️ Failed to persist RecommendedSP (non-fatal):', persistErr.message);
    }

    const scope = await getUserScope(req);
    const visibleRows = scope.filterRows(rows);
    const matchedCount = rows.filter(r => r.HasCompetitor).length;
    console.log(`✅ /api/internal-recommendations — ${visibleRows.length} rows served (${rows.length} active + in-stock products, ${matchedCount} competitor-matched)`);
    res.json({ success: true, data: visibleRows });
  } catch (err) {
    console.error('❌ /api/internal-recommendations error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/internal-recommendations/:sku ────────────────────
// Recalculates ONE row of Basic Recommendations (used right after a PP is
// set / edited from the table). Only this SKU is read, computed and persisted
// — nothing else is touched. Persisting matters: the push variance check
// compares against InternalProducts.RecommendedSP.
app.get('/api/internal-recommendations/:sku', requireAuth, async (req, res) => {
  const skuId = String(req.params.sku || '').trim();
  try {
    if (!skuId) {
      return res.status(400).json({ success: false, error: 'sku is required' });
    }
    const pool = await getSqlPool();

    const product = await loadInternalProductBySku(pool, skuId);
    if (!product) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }

    // Same category/brand visibility rule as the list endpoint
    const scope = await getUserScope(req);
    if (scope.filterRows([product]).length === 0) {
      return res.status(403).json({ success: false, error: 'You are not assigned to this category/brand' });
    }

    const categorySettings = await loadCategorySettings(pool);
    const competitorMap    = await loadCompetitorSummaryMap(pool, skuId);
    const row = buildBasicRecommendationRow(product, categorySettings, competitorMap.get(normSku(skuId)));

    try {
      await persistRecommendedSP(pool, [row]);
    } catch (persistErr) {
      console.error('⚠️ Failed to persist RecommendedSP (non-fatal):', persistErr.message);
    }

    console.log(`✅ /api/internal-recommendations/${skuId} — PP=${row.PP} RecommendedSP=${row.RecommendedSP}`);
    res.json({ success: true, data: row });
  } catch (err) {
    console.error(`❌ /api/internal-recommendations/${skuId} error:`, err.message);
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});















// ── POST /api/refresh-product ─────────────────────────────────
app.post('/api/refresh-product', requireAuth, requireWriteAccess, async (req, res) => {
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
    // Role-based scope: check BEFORE spending a scrape on a SKU the user can't touch
    const scope = await getUserScope(req);
    if (!scope.unrestricted) {
      const scopePool = await getSqlPool();
      const { denied } = await partitionSkus(scopePool, scope, [skuId]);
      if (denied.length) {
        return res.status(403).json({ success: false, error: 'You are not assigned to this category/brand' });
      }
    }
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

    const refreshedBy = req.session?.user?.email || req.headers['x-user-email'] || 'manual';
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
    await audit.recordSafe(pool, {
      ...audit.actorFromReq(req), module: MODULES.SCRAPER, action: ACTIONS.REFRESH, source: SOURCES.UI,
      entityType: 'SKU', entityId: skuId, fieldName: 'RecommendedSP', newValue: newRecommendedSP,
      summary: `Manual refresh of ${skuId} from ${store.name}: competitor price ${upserted.CompetitorPrice ?? 'n/a'}, recommended SP ${newRecommendedSP ?? 'n/a'}`,
      details: { competitorUrl, store: store.name, competitorPrice: upserted.CompetitorPrice ?? null },
    });
    res.json({
      success: true, skuId, storeName: store.name, productName: product.name,
      newCompetitorPrice: upserted.CompetitorPrice, newRecommendedSP, refreshedAt, refreshedBy,
    });
  } catch (err) {
    console.error(`❌ Manual refresh failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── POST /api/refresh-sku-competitors ─────────────────────────
// Basic table row Refresh: re-scrapes EVERY stored competitor URL for one
// SKU (only SKUs that are already matched have URLs), upserts them, and
// returns the freshly recalculated Basic row. Scrapes go through the shared
// process-wide limiter so they can never exceed SCRAPE_CONCURRENCY together
// with any running category scrape.
app.post('/api/refresh-sku-competitors', requireAuth, requireWriteAccess, async (req, res) => {
  const skuId = String(req.body?.skuId || '').trim();
  if (!skuId) {
    return res.status(400).json({ success: false, error: 'skuId is required' });
  }
  console.log(`\n🔄 Refresh all competitors: SKU=${skuId}`);

  try {
    const pool = await getSqlPool();

    const scope = await getUserScope(req);
    if (!scope.unrestricted) {
      const { denied } = await partitionSkus(pool, scope, [skuId]);
      if (denied.length) {
        return res.status(403).json({ success: false, error: 'You are not assigned to this category/brand' });
      }
    }

    const urlRows = await pool.request()
      .input('SKU', sql.NVarChar(100), skuId)
      .query(`SELECT StoreName, ProductURL FROM CompetitorPrices WHERE SKU = @SKU AND ProductURL IS NOT NULL`);

    if (!urlRows.recordset.length) {
      return res.status(404).json({ success: false, error: 'No competitor URLs stored for this SKU' });
    }

    const limit = getGlobalScrapeLimiter(parseInt(process.env.SCRAPE_CONCURRENCY || '5', 10));

    const results = await Promise.all(urlRows.recordset.map(r => limit(async () => {
      const store = findStoreByUrl(r.ProductURL);
      if (!store) return { store: r.StoreName, ok: false, error: 'Unknown store URL' };
      try {
        const product = await scrapeProduct(store, r.ProductURL);
        if (!product || !product.name) return { store: store.name, ok: false, error: 'No product data found' };
        const upserted = await upsertOneProduct(product);
        if (!upserted) return { store: store.name, ok: false, error: 'SKU could not be mapped' };
        return { store: store.name, ok: true, price: upserted.CompetitorPrice ?? null };
      } catch (e) {
        return { store: store.name, ok: false, error: e.message };
      }
    })));

    const okCount = results.filter(r => r.ok).length;
    if (okCount === 0) {
      return res.status(422).json({ success: false, error: 'Could not refresh any store', results });
    }

    // Fresh row (competitor summary + recommended SP) after the upserts
    const product = await loadInternalProductBySku(pool, skuId);
    if (!product) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }
    const categorySettings = await loadCategorySettings(pool);
    const competitorMap    = await loadCompetitorSummaryMap(pool, skuId);
    const row = buildBasicRecommendationRow(product, categorySettings, competitorMap.get(normSku(skuId)));
    try {
      await persistRecommendedSP(pool, [row]);
    } catch (persistErr) {
      console.error('⚠️ Failed to persist RecommendedSP (non-fatal):', persistErr.message);
    }

    const refreshedBy = req.session?.user?.email || req.headers['x-user-email'] || 'manual';
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

    await audit.recordSafe(pool, {
      ...audit.actorFromReq(req), module: MODULES.SCRAPER, action: ACTIONS.REFRESH, source: SOURCES.UI,
      entityType: 'SKU', entityId: skuId, fieldName: 'RecommendedSP', newValue: row.RecommendedSP,
      summary: `Manual refresh of ${skuId} from ${okCount}/${results.length} competitor stores: recommended SP ${row.RecommendedSP ?? 'n/a'}`,
      details: { results },
    });

    res.json({
      success: true, skuId, row, results, refreshedAt, refreshedBy,
      message: `${okCount} of ${results.length} stores updated`,
    });
  } catch (err) {
    console.error(`❌ Refresh all competitors failed: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── GET /api/competitor-details/:skuId ───────────────────────
app.get('/api/competitor-details/:skuId', requireAuth, async (req, res) => {
  const { skuId } = req.params;
  if (!skuId) return res.status(400).json({ success: false, error: 'skuId is required' });

  let pool;
  try {
    pool = await getSqlPool();
    const scope = await getUserScope(req);
    const { denied } = await partitionSkus(pool, scope, [skuId]);
    if (denied.length) {
      return res.status(403).json({ success: false, error: 'You are not assigned to this category/brand' });
    }
    // ?all=1 (Basic table): every matched store, in-stock first (cheapest
    // first), out-of-stock last, no 4-row cap. Default (Intelligence table):
    // unchanged — top 4 cheapest in-stock stores.
    const showAll = req.query.all === '1' || req.query.all === 'true';
    const query = showAll
      ? `
        SELECT CompetitorPrice, ProductURL, StoreName, StockStatus, ScrapedAt
        FROM CompetitorPrices
        WHERE SKU = @SKU
        ORDER BY
          CASE WHEN CompetitorPrice IS NOT NULL AND StockStatus IS NOT NULL
                AND LOWER(StockStatus) <> 'out of stock' THEN 0 ELSE 1 END,
          CompetitorPrice ASC
      `
      : `
        SELECT TOP 4 CompetitorPrice, ProductURL, StoreName, StockStatus, ScrapedAt
        FROM CompetitorPrices
        WHERE SKU = @SKU AND CompetitorPrice IS NOT NULL
          AND LOWER(StockStatus) != 'out of stock'
        ORDER BY CompetitorPrice ASC
      `;
    const result = await pool.request()
      .input('SKU', sql.NVarChar(100), skuId)
      .query(query);
    res.json({ success: true, data: result.recordset });
  } catch (err) {
    console.error(`❌ /api/competitor-details/${skuId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
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
      ORDER BY Category, Title
    `);
    // ^ ALL products — active or inactive, in stock or out of stock.
    //   The Active / Stock filters live in the UI (default: show everything).
    const scope = await getUserScope(req);
    const visibleRows = scope.filterRows(result.recordset);
    console.log(`✅ /api/pp-products — ${visibleRows.length} rows`);
    res.json({ success: true, data: visibleRows });
  } catch (err) {
    console.error('❌ /api/pp-products error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});




// ── PATCH /api/update-pp ──────────────────────────────────────
app.patch('/api/update-pp', requireAuth, requireWriteAccess, async (req, res) => {
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
  let tx = null;
  try {
    pool = await getSqlPool();
    const scope = await getUserScope(req);
    const { denied } = await partitionSkus(pool, scope, [skuId]);
    if (denied.length) {
      await audit.recordSafe(pool, {
        ...audit.actorFromReq(req), module: MODULES.PURCHASE_PRICE, action: ACTIONS.UPDATE, source: SOURCES.UI,
        status: STATUS.DENIED, entityType: 'SKU', entityId: skuId, fieldName: 'PP', newValue: parsedPP,
        summary: `Blocked: tried to set PP of ${skuId} to ${parsedPP} (not assigned to this category/brand)`,
      });
      return res.status(403).json({ success: false, error: 'You are not assigned to this category/brand' });
    }

    // Change + audit row commit together (or not at all)
    tx = new sql.Transaction(pool);
    await tx.begin();

    const before = await tx.request()
      .input('SKU_ID', sql.NVarChar(100), skuId)
      .query(`SELECT PP, Category, Brand FROM InternalProducts WHERE SKU_ID = @SKU_ID`);
    if (!before.recordset.length) {
      await tx.rollback(); tx = null;
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }
    const old = before.recordset[0];

    const result = await tx.request()
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

    await audit.record(tx, {
      ...audit.actorFromReq(req), module: MODULES.PURCHASE_PRICE, action: ACTIONS.UPDATE, source: SOURCES.UI,
      entityType: 'SKU', entityId: skuId, category: old.Category, brand: old.Brand,
      fieldName: 'PP', oldValue: old.PP, newValue: parsedPP,
      summary: `PP of ${skuId} changed from ${old.PP ?? 'none'} to ${parsedPP}`,
    });
    await tx.commit(); tx = null;

    console.log(`✅ PP updated: SKU=${skuId} | PP=₹${parsedPP} | By=${updatedBy}`);
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    console.error(`❌ /api/update-pp error for ${skuId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
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
    const scope = await getUserScope(req);
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
      scope,
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
    const scope = await getUserScope(req);
    const counts = await getInsightCounts(pool, { days: req.query.days || null, scope });
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
    const scope = await getUserScope(req);
    const exportData = await getInsightsExport(pool, {
      scope,
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
      .query(`SELECT SKU_ID, Title, Category, Brand, PP, SP FROM InternalProducts WHERE SKU_ID = @SKU_ID`);

    if (!productResult.recordset.length) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }
    const product = productResult.recordset[0];

    const scope = await getUserScope(req);
    if (!scope.allows(product.Category, product.Brand)) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }

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
      const vars = getBusinessVars(categorySettings, product.Category, product.Brand);

      // Same shared formula as every other table (with or without a competitor).
      const calc = computeRecommendedSP({
        pp: parseFloat(product.PP),
        vars,
        lowestCompetitorPrice: lowestCompetitorPrice != null ? parseFloat(lowestCompetitorPrice) : null,
        weightKg: getProductWeightKg(product),
      });
      recommendedSP = calc.recommendedSP;

      pricingBreakdown = {
        gstPct            : calc.breakdown.gstPct,
        costOfBusinessPct : calc.breakdown.cobPct,
        profitMarginPct   : calc.breakdown.marginPct,
        shopifyFeePct     : calc.breakdown.shopifyFeePct,
        paymentGatewayPct : calc.breakdown.paymentGatewayPct,
        packingCost       : calc.breakdown.packingCost,
        shippingCost      : calc.breakdown.shippingCost,   // null = no weight data yet
        weightKg          : calc.breakdown.weightKg,
      };

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
  }
});

















app.post('/api/insights/dismiss-bulk', requireAuth, requireWriteAccess, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
    }
    const pool = await getSqlPool();
    const scope = await getUserScope(req);

    // State BEFORE the dismiss (see single-dismiss route)
    const numericIds = ids.map(Number).filter(Number.isInteger);
    const beforeRes = await pool.request()
      .input('Ids', sql.NVarChar(sql.MAX), JSON.stringify(numericIds))
      .query(`SELECT Id, SKU_ID, AlertType, Category, Status, DismissedBy, DismissedAt
              FROM InsightAlerts WHERE Id IN (SELECT CAST(value AS INT) FROM OPENJSON(@Ids))`);
    const beforeById = new Map(beforeRes.recordset.map(r => [r.Id, r]));

    const dismissedIds = await bulkDismissInsights(pool, ids, req.session?.user?.email || req.user?.email || 'unknown', scope);

    if (dismissedIds.length) {
      const actor = audit.actorFromReq(req);
      const batchId = uuidv4();
      const events = dismissedIds.map(aid => {
        const b = beforeById.get(aid) || {};
        return {
          ...actor, module: MODULES.INSIGHTS, action: ACTIONS.DISMISS, source: SOURCES.UI,
          entityType: 'ALERT', entityId: b.SKU_ID, category: b.Category,
          fieldName: 'Status', oldValue: b.Status, newValue: 'dismissed',
          summary: `Dismissed ${b.AlertType || 'alert'} for ${b.SKU_ID || aid}`,
          batchId, details: { alertId: aid, alertType: b.AlertType, previouslyDismissedBy: b.DismissedBy || null, previouslyDismissedAt: b.DismissedAt || null },
        };
      });
      events.unshift({
        ...actor, module: MODULES.INSIGHTS, action: ACTIONS.BULK_DISMISS, source: SOURCES.UI,
        entityType: 'BATCH', entityId: `${dismissedIds.length} alerts`, batchId,
        summary: `Dismissed ${dismissedIds.length} insight alert${dismissedIds.length === 1 ? '' : 's'}${ids.length !== dismissedIds.length ? ` (${ids.length - dismissedIds.length} skipped)` : ''}`,
        details: { requested: ids.length, dismissed: dismissedIds.length },
      });
      await audit.recordSafe(pool, events);
    }
    res.json({ success: true, data: dismissedIds });
  } catch (err) {
    console.error('❌ /api/insights/dismiss-bulk error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});




// ── POST /api/insights/:id/dismiss ──────────────────────────────
app.post('/api/insights/:id/dismiss', requireAuth, requireWriteAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid alert id' });
  const dismissedBy = req.session?.user?.email || 'unknown';
  let pool;
  try {
    pool = await getSqlPool();
    const scope = await getUserScope(req);

    // State BEFORE the dismiss — dismissing overwrites DismissedBy/At for everyone, so keep the history here
    const before = await pool.request().input('Id', sql.Int, id).query(
      `SELECT Status, DismissedBy, DismissedAt, Category FROM InsightAlerts WHERE Id = @Id`);
    const prev = before.recordset[0] || {};

    const updated = await dismissInsight(pool, id, dismissedBy, scope);
    if (!updated) return res.status(404).json({ success: false, error: 'Alert not found' });

    await audit.recordSafe(pool, {
      ...audit.actorFromReq(req), module: MODULES.INSIGHTS, action: ACTIONS.DISMISS, source: SOURCES.UI,
      entityType: 'ALERT', entityId: updated.SKU_ID, category: prev.Category,
      fieldName: 'Status', oldValue: prev.Status, newValue: updated.Status,
      summary: `Dismissed ${updated.AlertType} alert for ${updated.SKU_ID}`,
      details: {
        alertId: id, alertType: updated.AlertType,
        previouslyDismissedBy: prev.DismissedBy || null, previouslyDismissedAt: prev.DismissedAt || null,
      },
    });
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

    // Role-based scope: SKUs outside the user's category/brand are treated as
    // "not found" (so the existing upload preview handles them, and nothing is revealed).
    const scope = await getUserScope(req);
    const { allowed: inScope } = await partitionSkus(pool, scope, [...foundMap.keys()]);
    const inScopeSet = new Set(inScope.map(k => k.toLowerCase()));

    const valid    = [];
    const notFound = [];

    for (const sku of skus) {
      if (foundMap.has(sku.toLowerCase()) && inScopeSet.has(sku.toLowerCase())) {
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
  }
});


// ── POST /api/bulk-update-pp ──────────────────────────────────
app.post('/api/bulk-update-pp', requireAuth, requireWriteAccess, async (req, res) => {
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
  const sessionId = uuidv4(); // also used as the audit BatchId

  let pool;
  let tx = null;
  try {
    pool = await getSqlPool();

    // Role-based scope: refuse the whole upload if any SKU is outside the user's assignments
    const scope = await getUserScope(req);
    const { denied } = await partitionSkus(pool, scope, rows.map(r => r.skuId));
    if (denied.length) {
      await audit.recordSafe(pool, {
        ...audit.actorFromReq(req), module: MODULES.PURCHASE_PRICE, action: ACTIONS.BULK_UPLOAD, source: SOURCES.CSV_UPLOAD,
        status: STATUS.DENIED, entityType: 'FILE', entityId: fileName || '(unnamed file)', batchId: sessionId,
        summary: `Blocked PP upload "${fileName || 'unnamed'}": ${denied.length} SKU(s) outside the user's assigned categories/brands`,
        details: { deniedCount: denied.length, deniedSample: denied.slice(0, 20) },
      });
      return res.status(403).json({
        success: false,
        error: `${denied.length} SKU(s) are not in your assigned categories/brands: ${denied.slice(0, 10).join(', ')}${denied.length > 10 ? ', …' : ''}. Nothing was updated.`,
      });
    }

    // Everything below (updates + session rows + audit rows) is ONE transaction
    tx = new sql.Transaction(pool);
    await tx.begin();

    // Values BEFORE the upload, for the audit trail
    const meta = await audit.getSkuMeta(tx, rows.map(r => r.skuId));
    const currentPP = new Map([...meta].map(([k, v]) => [k, v.pp])); // running value (handles duplicate SKUs in one CSV)

    const events = [];
    const actor = audit.actorFromReq(req);
    let updated = 0, unchanged = 0, notFound = 0;

    for (const row of rows) {
      const newPP = parseFloat(row.newPP);
      const result = await tx.request()
        .input('SKU_ID',    sql.NVarChar(100),  row.skuId)
        .input('PP',        sql.Decimal(10, 2), newPP)
        .input('UpdatedBy', sql.NVarChar(150),  updatedBy)
        .query(`
          UPDATE InternalProducts
          SET PP = @PP, ManualPP_UpdatedAt = GETDATE(), ManualPP_UpdatedBy = @UpdatedBy
          WHERE SKU_ID = @SKU_ID
        `);
      if (result.rowsAffected[0] === 0) { notFound++; continue; }
      updated++;

      const key = audit.normSku(row.skuId);
      const m = meta.get(key) || {};
      const oldPP = currentPP.get(key);
      currentPP.set(key, newPP);
      if (oldPP !== null && oldPP !== undefined && Number(oldPP) === newPP) { unchanged++; continue; } // no real change → no audit noise

      events.push({
        ...actor, module: MODULES.PURCHASE_PRICE, action: ACTIONS.UPDATE, source: SOURCES.CSV_UPLOAD,
        entityType: 'SKU', entityId: row.skuId, category: m.category, brand: m.brand,
        fieldName: 'PP', oldValue: oldPP, newValue: newPP,
        summary: `PP of ${row.skuId} changed from ${oldPP ?? 'none'} to ${newPP} (CSV upload)`,
        batchId: sessionId, details: { fileName },
      });
    }

    await tx.request()
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
        const req2   = tx.request();
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

    // One summary row for the upload + one row per changed SKU (all share BatchId = sessionId)
    events.unshift({
      ...actor, module: MODULES.PURCHASE_PRICE, action: ACTIONS.BULK_UPLOAD, source: SOURCES.CSV_UPLOAD,
      entityType: 'FILE', entityId: fileName || '(unnamed file)', batchId: sessionId,
      summary: `PP upload "${fileName || 'unnamed'}": ${events.length} changed, ${unchanged} unchanged, ${unidentified.length} unidentified`,
      details: { fileName, totalRows: rows.length + unidentified.length, matched: updated, changed: events.length,
                 unchanged, notFound, unidentified: unidentified.length },
    });
    await audit.recordMany(tx, events);

    await tx.commit(); tx = null;

    console.log(`✅ /api/bulk-update-pp — session=${sessionId} | updated=${updated} | unidentified=${unidentified.length} | by=${updatedBy}`);

    res.json({
      success: true,
      data: { sessionId, updated, unidentifiedCount: unidentified.length, updatedBy, updatedAt },
    });

  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    console.error('❌ /api/bulk-update-pp error:', err.message, err.stack);
    if (pool) {
      await audit.recordSafe(pool, {
        ...audit.actorFromReq(req), module: MODULES.PURCHASE_PRICE, action: ACTIONS.BULK_UPLOAD, source: SOURCES.CSV_UPLOAD,
        status: STATUS.FAILED, entityType: 'FILE', entityId: fileName || '(unnamed file)', batchId: sessionId,
        summary: `PP upload "${fileName || 'unnamed'}" failed, nothing was changed: ${err.message}`,
      });
    }
    res.status(500).json({ success: false, error: err.message });
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
    // Role-based scope: only SKUs the user is assigned to
    const scope = await getUserScope(req);
    if (!scope.unrestricted) {
      const scopePool = await getSqlPool();
      const { denied } = await partitionSkus(scopePool, scope, skus);
      if (denied.length) {
        return res.status(403).json({ success: false, error: `${denied.length} SKU(s) are not in your assigned categories/brands` });
      }
    }
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
app.get('/api/stock-check', requireRole(['admin', 'supervisor']), async (req, res) => {
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
app.post('/api/bulk-update-stock', requireAuth, requireWriteAccess, async (req, res) => {
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

    // Role-based scope: refuse the whole upload if any SKU is outside the user's assignments
    const scope = await getUserScope(req);
    const { denied } = await partitionSkus(pool, scope, rows.map(r => r.skuId));
    if (denied.length) {
      await audit.recordSafe(pool, {
        ...audit.actorFromReq(req), module: MODULES.STOCK, action: ACTIONS.BULK_UPLOAD, source: SOURCES.CSV_UPLOAD,
        status: STATUS.DENIED, entityType: 'FILE', entityId: fileName || '(unnamed file)',
        summary: `Blocked stock upload "${fileName || 'unnamed'}": ${denied.length} SKU(s) outside the user's assigned categories/brands`,
        details: { deniedCount: denied.length, deniedSample: denied.slice(0, 20), ppSessionId },
      });
      return res.status(403).json({
        success: false,
        error: `${denied.length} SKU(s) are not in your assigned categories/brands: ${denied.slice(0, 10).join(', ')}${denied.length > 10 ? ', …' : ''}. Nothing was changed.`,
      });
    }

    const result = await applyStockUpdates(pool, { rows, updatedBy, ppSessionId, fileName });

    // Audit AFTER the Shopify push (an external call can't be rolled back, so we record what actually happened)
    const actor = audit.actorFromReq(req);
    const meta  = await audit.getSkuMeta(pool, (result.changes || []).map(c => c.sku)).catch(() => new Map());
    const events = (result.changes || []).map(c => {
      const m = meta.get(audit.normSku(c.sku)) || {};
      const ok = c.status === 'Pushed';
      return {
        ...actor, module: MODULES.STOCK, action: ACTIONS.UPDATE, source: SOURCES.CSV_UPLOAD,
        status: ok ? STATUS.SUCCESS : STATUS.FAILED,
        entityType: 'SKU', entityId: c.sku, category: m.category, brand: m.brand,
        fieldName: `Stock - ${c.location}`, oldValue: c.oldQty, newValue: c.newQty,
        summary: ok
          ? `Stock of ${c.sku} at ${c.location} changed from ${c.oldQty ?? 'inactive'} to ${c.newQty}`
          : `FAILED to change stock of ${c.sku} at ${c.location} (${c.oldQty ?? 'inactive'} → ${c.newQty})`,
        batchId: result.sessionId, details: { fileName, ppSessionId },
      };
    });
    events.unshift({
      ...actor, module: MODULES.STOCK, action: ACTIONS.BULK_UPLOAD, source: SOURCES.CSV_UPLOAD,
      status: result.failed > 0 ? STATUS.PARTIAL : STATUS.SUCCESS,
      entityType: 'FILE', entityId: fileName || '(unnamed file)', batchId: result.sessionId,
      summary: `Stock upload "${fileName || 'unnamed'}": ${result.pushed} pushed, ${result.failed} failed, ${result.unchanged} unchanged`,
      details: { fileName, ppSessionId, changed: result.changed, pushed: result.pushed, failed: result.failed, unchanged: result.unchanged },
    });
    await audit.recordSafe(pool, events);

    res.json({ success: true, data: { ...result, updatedBy, updatedAt: new Date().toISOString() } });
  } catch (err) {
    console.error('❌ /api/bulk-update-stock error:', err.message, err.stack);
    if (pool) {
      await audit.recordSafe(pool, {
        ...audit.actorFromReq(req), module: MODULES.STOCK, action: ACTIONS.BULK_UPLOAD, source: SOURCES.CSV_UPLOAD,
        status: STATUS.FAILED, entityType: 'FILE', entityId: fileName || '(unnamed file)',
        summary: `Stock upload "${fileName || 'unnamed'}" failed: ${String(err.message).slice(0, 300)}`,
        details: { fileName, ppSessionId },
      });
    }
    const known = (err.status && err.status < 500) || err.status === 502;
    res.status(err.status || 500).json({
      success: false,
      error: known ? err.message : 'Something went wrong while updating stock, so nothing was changed. Please try again. If it keeps happening, contact the tech team.',
      technical: err.technical || (known ? undefined : err.message),
      details: err.details,
    });
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
  }
});





// ── PUT /api/app-settings/:key ──────────────────────────────────
app.put('/api/app-settings/:key', requireAuth, requireRole(['admin', 'supervisor']), async (req, res) => {
  const { value } = req.body;
  if (value == null || value === '') {
    return res.status(400).json({ success: false, error: 'value is required' });
  }

  const updatedBy = req.session?.user?.email || 'unknown';
  let pool;
  let tx = null;
  try {
    pool = await getSqlPool();
    tx = new sql.Transaction(pool);
    await tx.begin();

    const before = await tx.request()
      .input('Key', sql.NVarChar(100), req.params.key)
      .query(`SELECT SettingValue FROM AppSettings WHERE SettingKey = @Key`);

    const result = await tx.request()
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
      await tx.rollback(); tx = null;
      return res.status(404).json({ success: false, error: `Setting not found: ${req.params.key}` });
    }
    const oldValue = before.recordset[0]?.SettingValue;
    await audit.record(tx, {
      ...audit.actorFromReq(req), module: MODULES.BUSINESS_VARS, action: ACTIONS.UPDATE, source: SOURCES.UI,
      entityType: 'SETTING', entityId: req.params.key, fieldName: req.params.key,
      oldValue, newValue: String(value),
      summary: `Setting "${req.params.key}" changed from ${oldValue ?? 'none'} to ${value}`,
    });
    await tx.commit(); tx = null;

    console.log(`✅ /api/app-settings/${req.params.key} updated to ${value} by ${updatedBy}`);
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    console.error('❌ /api/app-settings PUT error:', err.message);
    res.status(500).json({ success: false, error: err.message });
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
    // Restricted salespeople only get the categories they are assigned to.
    const scope = await getUserScope(req);
    const rows = scope.unrestricted
      ? result.recordset
      : result.recordset.filter((r) => scope.allowsCategory(r.CategoryName));
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});








// ── GET /api/internal-categories ──────────────────────────────
// Category NAMES only (no settings). Used by the Category Mapping tab, which
// every role may use, so it must not depend on the per-salesperson filtered
// /api/category-settings response.
app.get('/api/internal-categories', requireAuth, async (req, res) => {
  try {
    const pool = await getSqlPool();
    const result = await pool.request().query(
      `SELECT DISTINCT CategoryName FROM CategorySettings WHERE CategoryName IS NOT NULL ORDER BY CategoryName`);
    res.json({ success: true, data: result.recordset.map((r) => r.CategoryName) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── PUT /api/category-settings/:category ─────────────────────
app.put('/api/category-settings/:category', requireAuth, requireRole(['admin', 'supervisor']), async (req, res) => {
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
  let tx = null;
  try {
    pool = await getSqlPool();
    tx = new sql.Transaction(pool);
    await tx.begin();

    const FIELDS = ['GST', 'CostOfBusiness', 'ProfitMargin', 'PPLookbackDays', 'ScrapFreqDays', 'IsScrapEnabled'];
    const oldRes = await tx.request()
      .input('CategoryName', sql.NVarChar(200), categoryName)
      .query(`SELECT GST, CostOfBusiness, ProfitMargin, PPLookbackDays, ScrapFreqDays, IsScrapEnabled
              FROM CategorySettings WHERE CategoryName = @CategoryName`);
    const oldRow = oldRes.recordset[0] || null;

    const result = await tx.request()
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

    // Field-by-field before/after (one audit row per save; the list goes in Details.changes)
    const norm = (v) => (v === null || v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : Number(v));
    const newRow = result.recordset[0];
    const changes = FIELDS
      .map((f) => ({ field: f, old: oldRow ? norm(oldRow[f]) : null, new: norm(newRow[f]) }))
      .filter((c) => !oldRow || c.old !== c.new);
    const text = changes.map((c) => `${c.field} ${c.old ?? 'none'} → ${c.new ?? 'none'}`).join(', ');

    await audit.record(tx, {
      ...audit.actorFromReq(req), module: MODULES.BUSINESS_VARS, action: oldRow ? ACTIONS.UPDATE : ACTIONS.CREATE, source: SOURCES.UI,
      entityType: 'CATEGORY', entityId: categoryName, category: categoryName,
      summary: oldRow
        ? `Category settings for ${categoryName}: ${text || 'saved, no values changed'}`
        : `Category settings created for ${categoryName}: ${text}`,
      details: { changes },
    });
    await tx.commit(); tx = null;

    res.json({ success: true, data: newRow });
  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    res.status(500).json({ success: false, error: err.message });
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
  let tx = null;
  try {
    pool = await getSqlPool();
    tx = new sql.Transaction(pool);
    await tx.begin();

    const prev = await tx.request()
      .input('Email', sql.NVarChar(255), normalizedEmail)
      .query(`SELECT Role FROM UserRoles WHERE Email = @Email`);
    const oldRole = prev.recordset[0]?.Role ?? null;

    await tx.request()
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

    await audit.record(tx, {
      ...audit.actorFromReq(req), module: MODULES.USERS, action: oldRole ? ACTIONS.UPDATE : ACTIONS.CREATE, source: SOURCES.UI,
      entityType: 'USER', entityId: normalizedEmail, fieldName: 'Role', oldValue: oldRole, newValue: role,
      summary: oldRole
        ? `Role of ${normalizedEmail} changed from ${oldRole} to ${role}`
        : `Added ${normalizedEmail} as ${role}`,
    });
    await tx.commit(); tx = null;

    console.log(`✅ /api/users — upserted: ${normalizedEmail} as ${role} by ${addedBy}`);
    res.json({ success: true, data: { email: normalizedEmail, role } });
  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    console.error('❌ /api/users POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
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
  let tx = null;
  try {
    pool = await getSqlPool();
    tx = new sql.Transaction(pool);
    await tx.begin();

    const prev = await tx.request()
      .input('Email', sql.NVarChar(255), targetEmail)
      .query(`SELECT Role FROM UserRoles WHERE Email = @Email`);
    const result = await tx.request()
      .input('Email', sql.NVarChar(255), targetEmail)
      .query(`DELETE FROM UserRoles WHERE Email = @Email`);

    if (result.rowsAffected[0] === 0) {
      await tx.rollback(); tx = null;
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    const oldRole = prev.recordset[0]?.Role ?? null;
    await audit.record(tx, {
      ...audit.actorFromReq(req), module: MODULES.USERS, action: ACTIONS.DELETE, source: SOURCES.UI,
      entityType: 'USER', entityId: targetEmail, fieldName: 'Role', oldValue: oldRole, newValue: null,
      summary: `Removed access for ${targetEmail} (was ${oldRole ?? 'unknown role'})`,
    });
    await tx.commit(); tx = null;

    console.log(`✅ /api/users DELETE — removed: ${targetEmail} by ${selfEmail}`);
    res.json({ success: true });
  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    console.error(`❌ /api/users DELETE error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});


// ── POST /api/run-recommendation-engine ───────────────────────
const activeJobs = new Map();

app.post('/api/run-recommendation-engine', requireAuth, requireWriteAccess, async (req, res) => {
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

  const engineActor = audit.actorFromReq(req);
  getSqlPool().then(p => audit.recordSafe(p, {
    ...engineActor, module: MODULES.SCRAPER, action: ACTIONS.TRIGGER, source: SOURCES.UI,
    entityType: 'JOB', entityId: id, summary: 'Started the recommendation engine (recalculates recommended prices)',
    details: { jobId: id, job: 'recommendation-engine' },
  })).catch(() => {});

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

      job.status       = 'done';
      job.updatedCount = recommendations.length;
      job.finishedAt   = new Date().toISOString();
      await audit.recordSafe(pool, {
        ...engineActor, module: MODULES.SCRAPER, action: ACTIONS.FINISH, source: SOURCES.SYSTEM,
        entityType: 'JOB', entityId: id, summary: `Recommendation engine finished: ${recommendations.length} recommended prices recalculated`,
        details: { jobId: id, job: 'recommendation-engine', updatedCount: recommendations.length },
      });
      console.log(`✅ Recommendation engine done | job=${id} | updated=${recommendations.length}`);

    } catch (err) {
      job.status     = 'error';
      job.error      = err.message;
      job.finishedAt = new Date().toISOString();
      console.error(`❌ Recommendation engine failed | job=${id}:`, err.message);
      try {
        await audit.recordSafe(await getSqlPool(), {
          ...engineActor, module: MODULES.SCRAPER, action: ACTIONS.FINISH, source: SOURCES.SYSTEM, status: STATUS.FAILED,
          entityType: 'JOB', entityId: id, summary: `Recommendation engine failed: ${String(err.message).slice(0, 300)}`,
          details: { jobId: id, job: 'recommendation-engine' },
        });
      } catch (_) {}
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

  const scraperActor = audit.actorFromReq(req);
  const scraperNote = (e) => getSqlPool().then(p => audit.recordSafe(p, { ...scraperActor, entityType: 'JOB', entityId: id, module: MODULES.SCRAPER, ...e })).catch(() => {});
  scraperNote({
    action: ACTIONS.TRIGGER, source: SOURCES.UI,
    summary: `Started scraper for ${categoryNames.length} categor${categoryNames.length === 1 ? 'y' : 'ies'}: ${categoryNames.join(', ').slice(0, 300)}`,
    details: { jobId: id, categoryNames },
  });

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
      scraperNote({
        action: ACTIONS.FINISH, source: SOURCES.SYSTEM,
        status: job.status === 'done' ? (job.failedCategories.length ? STATUS.PARTIAL : STATUS.SUCCESS)
              : job.status === 'cancelled' ? STATUS.PARTIAL : STATUS.FAILED,
        summary: job.status === 'cancelled' ? 'Scraper was cancelled'
               : job.status === 'done' ? `Scraper finished: ${job.succeededCategories.length} categor${job.succeededCategories.length === 1 ? 'y' : 'ies'} scraped, ${job.failedCategories.length} with no data`
               : `Scraper failed: ${String(job.error || '').slice(0, 300)}`,
        details: { jobId: id, status: job.status, succeeded: job.succeededCategories, failed: job.failedCategories },
      });
    } catch (err) {
      job.status     = 'error';
      job.error      = err.message;
      job.finishedAt = new Date().toISOString();
      jobLog(`❌ Fatal error: ${err.message}`);
      scraperNote({ action: ACTIONS.FINISH, source: SOURCES.SYSTEM, status: STATUS.FAILED,
        summary: `Scraper crashed: ${String(err.message).slice(0, 300)}`, details: { jobId: id } });
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
app.get('/api/store-categories', requireAuth, (req, res) => {
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
app.get('/api/category-mappings', requireAuth, async (req, res) => {
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
  }
});



// ── POST /api/category-mappings ───────────────────────────────
// Open to every authenticated role (admin, supervisor, sales — assigned or not).
// Deliberately NOT behind requireWriteAccess and NOT category/brand scoped.
// Many-to-many: always INSERTs a new row unless the exact triple
// (StoreName + StoreSlug + InternalCategory) already exists.
app.post('/api/category-mappings', requireAuth, async (req, res) => {
  const { internalCategory, storeName, storeSlug } = req.body;

  if (!internalCategory || !storeName || !storeSlug) {
    return res.status(400).json({
      success: false,
      error: 'internalCategory, storeName, and storeSlug are all required',
    });
  }

  const mappedBy = req.session?.user?.email || 'unknown';
  let pool;
  let tx = null;
  try {
    pool = await getSqlPool();
    tx = new sql.Transaction(pool);
    await tx.begin();

    const existed = await tx.request()
      .input('InternalCategory', sql.NVarChar(200), internalCategory)
      .input('StoreName',        sql.NVarChar(100), storeName)
      .input('StoreSlug',        sql.NVarChar(200), storeSlug)
      .query(`SELECT 1 AS x FROM CategoryMappings
              WHERE StoreName = @StoreName AND StoreSlug = @StoreSlug AND InternalCategory = @InternalCategory`);

    const result = await tx.request()
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

    if (!existed.recordset.length) { // only a NEW mapping is a change worth auditing
      await audit.record(tx, {
        ...audit.actorFromReq(req), module: MODULES.CATEGORY_MAP, action: ACTIONS.CREATE, source: SOURCES.UI,
        entityType: 'MAPPING', entityId: `${storeName} / ${storeSlug}`, category: internalCategory,
        summary: `Mapped ${storeName} / ${storeSlug} → ${internalCategory}`,
        details: { mappingId: result.recordset[0]?.ID, storeName, storeSlug, internalCategory },
      });
    }
    await tx.commit(); tx = null;

    console.log(`✅ /api/category-mappings — mapped ${storeName}/${storeSlug} → ${internalCategory} by ${mappedBy}`);
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    console.error('❌ /api/category-mappings POST error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});





// ── DELETE /api/category-mappings/:id ────────────────────────
// Removes a mapping by its ID.
app.delete('/api/category-mappings/:id', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    return res.status(400).json({ success: false, error: 'Invalid ID' });
  }

  let pool;
  let tx = null;
  try {
    pool = await getSqlPool();
    tx = new sql.Transaction(pool);
    await tx.begin();

    const prev = await tx.request().input('ID', sql.Int, id)
      .query(`SELECT InternalCategory, StoreName, StoreSlug FROM CategoryMappings WHERE ID = @ID`);
    const result = await tx.request()
      .input('ID', sql.Int, id)
      .query(`DELETE FROM CategoryMappings WHERE ID = @ID`);

    if (result.rowsAffected[0] === 0) {
      await tx.rollback(); tx = null;
      return res.status(404).json({ success: false, error: 'Mapping not found' });
    }
    const m = prev.recordset[0] || {};
    await audit.record(tx, {
      ...audit.actorFromReq(req), module: MODULES.CATEGORY_MAP, action: ACTIONS.DELETE, source: SOURCES.UI,
      entityType: 'MAPPING', entityId: `${m.StoreName ?? '?'} / ${m.StoreSlug ?? id}`, category: m.InternalCategory,
      summary: `Removed mapping ${m.StoreName ?? '?'} / ${m.StoreSlug ?? id} → ${m.InternalCategory ?? '?'}`,
      details: { mappingId: id, ...m },
    });
    await tx.commit(); tx = null;

    console.log(`✅ /api/category-mappings DELETE — ID=${id}`);
    res.json({ success: true });
  } catch (err) {
    if (tx) { try { await tx.rollback(); } catch (_) {} }
    console.error(`❌ /api/category-mappings DELETE error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});









// ── POST /api/push-to-shopify ─────────────────────────────────
app.post('/api/push-to-shopify', requireAuth, requireWriteAccess, async (req, res) => {
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
      .query(`SELECT RecommendedSP, SP, Category, Brand FROM InternalProducts WHERE SKU_ID = @SKU_ID`); // ← added SP (+ Category/Brand for RBAC)

    if (!checkRow.recordset.length) {
      return res.status(404).json({ success: false, error: `SKU not found: ${skuId}` });
    }

    // Role-based scope: a salesperson can only push prices for their own category/brand
    const scope = await getUserScope(req);
    if (!scope.allows(checkRow.recordset[0].Category, checkRow.recordset[0].Brand)) {
      await audit.recordSafe(pool, {
        ...audit.actorFromReq(req), module: MODULES.SELLING_PRICE, action: ACTIONS.PUSH, source: SOURCES.UI,
        status: STATUS.DENIED, entityType: 'SKU', entityId: skuId,
        category: checkRow.recordset[0].Category, brand: checkRow.recordset[0].Brand,
        fieldName: 'SP', newValue: parsedSP,
        summary: `Blocked: tried to push SP ${parsedSP} for ${skuId} (not assigned to this category/brand)`,
      });
      return res.status(403).json({ success: false, error: 'You are not assigned to this category/brand' });
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

    // Audit (Shopify already changed, so this is recorded after the fact and can't fail the request)
    await audit.recordSafe(pool, {
      ...audit.actorFromReq(req), module: MODULES.SELLING_PRICE, action: ACTIONS.PUSH, source: SOURCES.UI,
      entityType: 'SKU', entityId: skuId,
      category: checkRow.recordset[0].Category, brand: checkRow.recordset[0].Brand,
      fieldName: 'SP', oldValue: currentSP, newValue: parsedSP,
      summary: `Selling price of ${skuId} pushed to Shopify: ${currentSP ?? 'none'} → ${parsedSP}${isManual ? ' (manual price)' : ' (recommended price)'}`,
      details: {
        isManual: !!isManual,
        systemRecommendedSP: systemSP,
        variancePct: systemSP ? Number((variance * 100).toFixed(2)) : null,
        varianceConfirmed: !!(requiresConfirm && confirmVariance),
      },
    });
    res.json({ success: true, data: result.recordset[0] });
  } catch (err) {
    console.error(`❌ /api/push-to-shopify error for ${skuId}:`, err.message);
    try {
      const failPool = await getSqlPool();
      await failPool.request()
        .input('SKU_ID', sql.NVarChar(100), skuId)
        .query(`UPDATE InternalProducts SET ShopifyPushStatus = 'failed' WHERE SKU_ID = @SKU_ID`);
    } catch (_) {}
    try {
      const auditPool = await getSqlPool();
      await audit.recordSafe(auditPool, {
        ...audit.actorFromReq(req), module: MODULES.SELLING_PRICE, action: ACTIONS.PUSH, source: SOURCES.UI,
        status: STATUS.FAILED, entityType: 'SKU', entityId: skuId, fieldName: 'SP', newValue: parsedSP,
        summary: `FAILED to push SP ${parsedSP} for ${skuId}: ${String(err.message).slice(0, 300)}`,
      });
    } catch (_) {}
    res.status(500).json({ success: false, error: err.message });
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