// src/services/salespersonMappingService.js
// ─────────────────────────────────────────────────────────────
// Read-only service for the Category/Brand -> Salesperson admin panel.
//
// Source of truth: [dbo].[vw_Shopify_Product_SKUs_With_SalesPerson] in the
// db_returns database (same place as vw_Shopify_Product_SKUs). It is read
// through azureSqlService.fetchSalespersonMappingRows(), NOT through the
// main db_tpstechautomata pool.
//
// The view only has a few hundred distinct (category, brand, salesperson)
// combinations, so we fetch them once, cache for a short time, and do the
// search / category / brand filtering in memory.
// ─────────────────────────────────────────────────────────────

const { fetchSalespersonMappingRows } = require('./azureSqlService');

const CACHE_TTL_MS = 60 * 1000;
let cache    = { rows: null, loadedAt: 0 };
let inFlight = null; // shared promise so parallel requests make ONE db_returns query

const clean = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

async function fetchAndCache() {
  try {
    const raw = await fetchSalespersonMappingRows();
    const rows = raw.map((r) => ({
      category:  clean(r.shopify_type_name),
      brand:     clean(r.brand_name),
      firstName: clean(r.first_name) || '',
      lastName:  clean(r.last_name)  || '',
      email:     clean(r.email_id),
    }));
    cache = { rows, loadedAt: Date.now() };
    return rows;
  } catch (err) {
    // Log the underlying cause — messages like "aborted" are too vague on their own
    console.error('❌ salespersonMapping load failed:',
      '| name:', err.name,
      '| code:', err.code,
      '| message:', err.message,
      '| original:', err.originalError?.message);
    throw err;
  } finally {
    inFlight = null;
  }
}

async function loadRows() {
  const fresh = cache.rows && Date.now() - cache.loadedAt < CACHE_TTL_MS;
  if (fresh) return cache.rows;
  if (!inFlight) inFlight = fetchAndCache();
  return inFlight;
}

/**
 * One entry per salesperson, each with an `assignments` array of
 * { category, brand }. No assignments => the UI shows "Unassigned".
 *
 * @param {{ search?: string, category?: string, brand?: string }} filters
 */
async function getMapping(filters = {}) {
  const rows = await loadRows();
  const q = (filters.search || '').trim().toLowerCase();

  const matches = rows.filter((r) => {
    if (filters.category && r.category !== filters.category) return false;
    if (filters.brand    && r.brand    !== filters.brand)    return false;
    if (q) {
      const haystack = [
        r.firstName,
        r.lastName,
        `${r.firstName} ${r.lastName}`,
        r.email || '',
      ].join('\n').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  return groupBySalesperson(matches);
}

/**
 * The (category, brand) pairs assigned to one salesperson — used by the
 * role-based access scope. Only pairs where BOTH values are present count.
 * Throws if the mapping can't be loaded (callers must fail closed).
 */
async function getAssignedPairsForEmail(email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return [];
  const rows = await loadRows();
  const seen = new Set();
  const pairs = [];
  for (const r of rows) {
    if (!r.email || r.email.toLowerCase() !== target) continue;
    if (!r.category || !r.brand) continue;
    const key = `${r.category}\u0001${r.brand}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ category: r.category, brand: r.brand });
  }
  return pairs;
}

/** Distinct categories and brands for the two filter dropdowns. */
async function getFilterOptions() {
  const rows = await loadRows();
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return {
    categories: uniq(rows.map((r) => r.category)),
    brands:     uniq(rows.map((r) => r.brand)),
  };
}

function groupBySalesperson(rows) {
  const byEmail = new Map();

  for (const row of rows) {
    if (!row.email) continue; // row has no salesperson identity

    const key = row.email.toLowerCase();
    if (!byEmail.has(key)) {
      byEmail.set(key, {
        firstName:   row.firstName,
        lastName:    row.lastName,
        email:       row.email,
        assignments: [],
      });
    }

    // Both category and brand NULL = "not assigned yet" -> no chip
    if (row.category || row.brand) {
      const entry = byEmail.get(key);
      const exists = entry.assignments.some(
        (a) => a.category === row.category && a.brand === row.brand
      );
      if (!exists) entry.assignments.push({ category: row.category, brand: row.brand });
    }
  }

  const list = Array.from(byEmail.values());
  for (const sp of list) {
    sp.assignments.sort((a, b) =>
      `${a.category || ''} ${a.brand || ''}`.localeCompare(`${b.category || ''} ${b.brand || ''}`)
    );
  }
  return list.sort((a, b) =>
    `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
  );
}

module.exports = { getMapping, getFilterOptions, getAssignedPairsForEmail };