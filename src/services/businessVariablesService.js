// src/services/businessVariablesService.js
// ─────────────────────────────────────────────────────────────
// Business variables (GST, cost of business, profit margin, ...) resolved as:
//     brand override -> category value -> definition default
//
// Tables: dbo.BusinessVariables, dbo.BusinessVariableValues
// (see 001_business_variables_migration.sql).
//
// Values are stored in PERCENT (18 = 18%). getBusinessVars() returns fractions
// (0.18) in the same { gst, costOfBusiness, profitMargin } shape the pricing
// engine already uses, so formulas do not change.
// ─────────────────────────────────────────────────────────────
'use strict';

const sql = require('mssql');
const { DEFAULT_GLOBALS } = require('./pricing');

// Which DB variable feeds which property of the pricing formula.
// A brand-new variable that should change the PRICE needs a line here AND a
// change in the formula. A variable that is only stored/shown needs neither.
const KEY_TO_PROP = {
  GST:              'gst',
  COST_OF_BUSINESS: 'costOfBusiness',
  PROFIT_MARGIN:    'profitMargin',
};

// Last-resort fallback if BusinessVariables is empty/unreadable.
const FALLBACK_DEFS = [
  { key: 'GST',              label: 'GST',              default: 18, min: 0, max: 100, sortOrder: 10 },
  { key: 'COST_OF_BUSINESS', label: 'Cost of Business', default: 7,  min: 0, max: 100, sortOrder: 20 },
  { key: 'PROFIT_MARGIN',    label: 'Profit Margin',    default: 5,  min: 0, max: 100, sortOrder: 30 },
];

// ── Global pricing costs (same for every product) ────────────────────────
// Stored in dbo.AppSettings (SettingKey -> property used by pricing.js).
// Percent keys hold whole percents (1 = 1%), money keys hold rupees.
// To add a new global cost: add the AppSettings row, add it here, add it to
// DEFAULT_GLOBALS in pricing.js, and use it in computeFloor().
const GLOBAL_SETTING_KEYS = {
  SHOPIFY_FEE_PCT     : 'shopifyFeePct',
  PAYMENT_GATEWAY_PCT : 'paymentGatewayPct',
  PACKING_COST        : 'packingCost',
  SHIPPING_RATE_PER_KG: 'shippingRatePerKg',
  SHIPPING_MIN_COST   : 'shippingMinCost',
};

// Reads the global costs; any missing / invalid / negative value falls back to
// the default so a bad row can never break price calculation.
async function loadPricingGlobals(pool) {
  const globals = { ...DEFAULT_GLOBALS };
  try {
    const keys = Object.keys(GLOBAL_SETTING_KEYS);
    const req = pool.request();
    keys.forEach((k, i) => req.input(`k${i}`, sql.NVarChar(100), k));
    const r = await req.query(
      `SELECT SettingKey, SettingValue FROM dbo.AppSettings
       WHERE SettingKey IN (${keys.map((_, i) => `@k${i}`).join(', ')})`);
    for (const row of r.recordset) {
      const prop = GLOBAL_SETTING_KEYS[row.SettingKey];
      const num  = parseFloat(row.SettingValue);
      if (prop && Number.isFinite(num) && num >= 0) globals[prop] = num;
      else console.warn(`⚠️  AppSettings ${row.SettingKey} = "${row.SettingValue}" is invalid, using default`);
    }
  } catch (err) {
    console.error('⚠️  Global pricing costs unreadable, using defaults:', err.message);
  }
  if (globals.shopifyFeePct + globals.paymentGatewayPct >= 100) {
    console.error('⚠️  Shopify fee + gateway % must be below 100 — using default fee percentages');
    globals.shopifyFeePct     = DEFAULT_GLOBALS.shopifyFeePct;
    globals.paymentGatewayPct = DEFAULT_GLOBALS.paymentGatewayPct;
  }
  return globals;
}

const SEP = '\u0001';
// SQL Server's default collation is case-insensitive, so "HP" and "Hp" are the
// same row there; normalise the same way in JS so lookups agree.
const norm     = (s) => String(s ?? '').trim();
const scopeKey = (category, brand) => `${norm(category).toLowerCase()}${SEP}${norm(brand).toLowerCase()}`;

class ConflictError extends Error {
  constructor(message, details = null) { super(message); this.name = 'ConflictError'; this.status = 409; this.details = details; }
}

const verToHex = (buf) => (buf ? '0x' + Buffer.from(buf).toString('hex') : null);
const hexToVer = (hex) => Buffer.from(String(hex).replace(/^0x/i, ''), 'hex');

// ── Load everything the engine needs (3 small queries, one round trip each) ──
async function loadBusinessVariables(pool) {
  let defs = [];
  try {
    const r = await pool.request().query(`
      SELECT VarKey, Label, Unit, DefaultValue, MinValue, MaxValue, SortOrder
      FROM dbo.BusinessVariables WHERE IsActive = 1 ORDER BY SortOrder, VarKey`);
    defs = r.recordset.map((d) => ({
      key: d.VarKey, label: d.Label, unit: d.Unit,
      default: Number(d.DefaultValue), min: Number(d.MinValue), max: Number(d.MaxValue),
      sortOrder: d.SortOrder,
    }));
  } catch (err) {
    console.error('⚠️  BusinessVariables unreadable, using fallback defaults:', err.message);
  }
  if (defs.length === 0) defs = FALLBACK_DEFS;

  const values = new Map(); // scopeKey -> Map(varKey -> percent)
  const vr = await pool.request().query(
    `SELECT CategoryName, BrandName, VarKey, Value FROM dbo.BusinessVariableValues`);
  for (const row of vr.recordset) {
    const k = scopeKey(row.CategoryName, row.BrandName);
    if (!values.has(k)) values.set(k, new Map());
    values.get(k).set(row.VarKey, Number(row.Value));
  }

  const globals = await loadPricingGlobals(pool);

  return { defs, defsByKey: new Map(defs.map((d) => [d.key, d])), values, globals };
}

// ── Effective variables for one product ──────────────────────────────────
// Same return shape as the old getBusinessVars(), plus `all` for new variables.
function getBusinessVars(bv, category, brand) {
  const brandMap = norm(brand)    ? bv.values.get(scopeKey(category, brand)) : null;
  const catMap   = bv.values.get(scopeKey(category, ''));

  const out = {};
  const all = {};
  for (const def of bv.defs) {
    const pct = brandMap?.get(def.key) ?? catMap?.get(def.key) ?? def.default;
    all[def.key] = def.unit === 'PERCENT' ? pct / 100 : pct;   // PERCENT -> fraction, DAYS etc. -> as is
    const prop = KEY_TO_PROP[def.key];
    if (prop) out[prop] = pct / 100;
  }
  // Guard: formula keys must always exist even if a def was deactivated.
  for (const [key, prop] of Object.entries(KEY_TO_PROP)) {
    if (out[prop] === undefined) {
      const fb = FALLBACK_DEFS.find((d) => d.key === key);
      out[prop] = fb.default / 100;
    }
  }
  out.all = all;
  out.globals = bv.globals || { ...DEFAULT_GLOBALS };   // global costs (Shopify fee, gateway, packing, shipping)
  return out;
}

// ── Settings screen payload: categories -> brands, with where each value comes from ──
async function getSettingsTree(pool, scope) {
  const bv = await loadBusinessVariables(pool);

  const [cats, brands, rows] = await Promise.all([
    pool.request().query(`SELECT CategoryName FROM dbo.CategorySettings ORDER BY CategoryName`),
    pool.request().query(`
      SELECT Category, Brand, COUNT(*) AS ProductCount
      FROM dbo.InternalProducts
      WHERE Category IS NOT NULL AND LTRIM(RTRIM(ISNULL(Brand, ''))) <> ''
      GROUP BY Category, Brand ORDER BY Category, Brand`),
    pool.request().query(`
      SELECT CategoryName, BrandName, VarKey, Value, RowVer, UpdatedAt, UpdatedBy
      FROM dbo.BusinessVariableValues`),
  ]);

  const stored = new Map(); // scopeKey -> { varKey -> {value, version, updatedAt, updatedBy} }
  for (const r of rows.recordset) {
    const k = scopeKey(r.CategoryName, r.BrandName);
    if (!stored.has(k)) stored.set(k, {});
    stored.get(k)[r.VarKey] = {
      value: Number(r.Value), version: verToHex(r.RowVer), updatedAt: r.UpdatedAt, updatedBy: r.UpdatedBy,
    };
  }

  const brandsByCat = new Map();
  for (const b of brands.recordset) {
    const k = norm(b.Category).toLowerCase();
    if (!brandsByCat.has(k)) brandsByCat.set(k, []);
    brandsByCat.get(k).push({ brandName: norm(b.Brand), productCount: b.ProductCount });
  }

  // `own` = explicitly set at this level (null = inherited). `effective` = what the engine will use.
  const describe = (category, brand) => {
    const own = stored.get(scopeKey(category, brand)) || {};
    const eff = {};
    for (const def of bv.defs) {
      const mine = own[def.key];
      if (mine) { eff[def.key] = { value: mine.value, source: brand ? 'BRAND' : 'CATEGORY' }; continue; }
      const parent = brand ? stored.get(scopeKey(category, ''))?.[def.key] : null;
      eff[def.key] = parent
        ? { value: parent.value, source: 'CATEGORY' }
        : { value: def.default,  source: 'DEFAULT' };
    }
    return { own: Object.fromEntries(bv.defs.map((d) => [d.key, own[d.key] ?? null])), effective: eff };
  };

  // Visibility / edit rights (scope comes from accessScope.getUserScope):
  //   admin, supervisor      -> see and edit everything
  //   sales, assigned pairs  -> see only their categories and ONLY their brands;
  //                             may edit only those brand rows (category row is read-only context)
  //   sales, unassigned      -> read-only view of everything (existing RBAC rule)
  const unrestricted = !scope || scope.unrestricted;
  const canEditAll   = !scope || (scope.unrestricted && !scope.readOnly);

  const categories = cats.recordset
    .filter((c) => unrestricted || scope.allowsCategory(c.CategoryName))
    .map((c) => ({
      categoryName: c.CategoryName,
      canEdit: canEditAll,
      ...describe(c.CategoryName, ''),
      brands: (brandsByCat.get(norm(c.CategoryName).toLowerCase()) || [])
        .filter((b) => unrestricted || scope.allows(c.CategoryName, b.brandName))
        .map((b) => ({
          ...b,
          canEdit: canEditAll || (!scope.unrestricted && scope.allows(c.CategoryName, b.brandName)),
          ...describe(c.CategoryName, b.brandName),
        })),
    }));

  return { defs: bv.defs, categories };
}

// ── Save one (category, brand) row group atomically ──────────────────────
// changes: [{ varKey, value: number|null, version: '0x..'|null }]
//   value null  -> remove the override (inherit from parent)
//   version     -> the RowVer the client last saw; null if there was no row.
// Any mismatch rolls back the WHOLE group and throws ConflictError (HTTP 409).
async function saveVariables(tx, { category, brand, changes, updatedBy, defsByKey }) {
  const cat = norm(category);
  const brd = norm(brand);
  const applied = [];

  for (const ch of changes) {
    const def = defsByKey.get(ch.varKey);
    if (!def) throw Object.assign(new Error(`Unknown variable ${ch.varKey}`), { status: 400 });

    const req = () => tx.request()
      .input('Cat', sql.NVarChar(200), cat)
      .input('Brand', sql.NVarChar(200), brd)
      .input('Key', sql.VarChar(50), ch.varKey);

    // current state (UPDLOCK: nobody else can change this row until we commit)
    const cur = await req().query(`
      SELECT Value, RowVer, UpdatedBy, UpdatedAt FROM dbo.BusinessVariableValues WITH (UPDLOCK, HOLDLOCK)
      WHERE CategoryName=@Cat AND BrandName=@Brand AND VarKey=@Key`);
    const row = cur.recordset[0] || null;

    const sameVersion = row
      ? ch.version && Buffer.compare(Buffer.from(row.RowVer), hexToVer(ch.version)) === 0
      : !ch.version;
    if (!sameVersion) {
      const where = `${def.label} for ${cat}${brd ? ' / ' + brd : ''}`;
      throw new ConflictError(
        row
          ? `${where} was just changed by ${row.UpdatedBy || 'someone else'} to ${Number(row.Value)}%. Your change was not saved. Reload and try again.`
          : `${where} was just reset by someone else. Your change was not saved. Reload and try again.`,
        row ? { varKey: ch.varKey, currentValue: Number(row.Value), updatedBy: row.UpdatedBy, updatedAt: row.UpdatedAt } : { varKey: ch.varKey });
    }

    const oldValue = row ? Number(row.Value) : null;

    if (ch.value === null) {                     // reset to inherit
      if (row) {
        await req().query(`DELETE FROM dbo.BusinessVariableValues
          WHERE CategoryName=@Cat AND BrandName=@Brand AND VarKey=@Key`);
      }
    } else if (row) {
      await req().input('Val', sql.Decimal(9, 4), ch.value).input('By', sql.NVarChar(150), updatedBy)
        .query(`UPDATE dbo.BusinessVariableValues
                SET Value=@Val, UpdatedAt=SYSUTCDATETIME(), UpdatedBy=@By
                WHERE CategoryName=@Cat AND BrandName=@Brand AND VarKey=@Key`);
    } else {
      await req().input('Val', sql.Decimal(9, 4), ch.value).input('By', sql.NVarChar(150), updatedBy)
        .query(`INSERT INTO dbo.BusinessVariableValues (CategoryName, BrandName, VarKey, Value, UpdatedBy)
                VALUES (@Cat, @Brand, @Key, @Val, @By)`);
    }

    if (oldValue !== ch.value) applied.push({ field: ch.varKey, old: oldValue, new: ch.value });
  }
  return applied;
}

module.exports = {
  loadBusinessVariables, loadPricingGlobals, getBusinessVars, getSettingsTree, saveVariables,
  ConflictError, KEY_TO_PROP, norm,
};