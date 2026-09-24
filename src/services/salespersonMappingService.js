// salespersonMappingService.js
//
// Read-only service for the Category/Brand -> Salesperson admin panel.
// Source of truth: dbo.vw_Shopify_Product_SKUs_With_SalesPerson
//   (columns used: shopify_type_name, brand_name, first_name, last_name, email_id)
// SKU/title/price/etc columns from that view are intentionally ignored here —
// this feature only cares about the category/brand -> person mapping.
//
// Assumes an existing getSqlPool() singleton helper (same pattern used
// elsewhere in Aspire_Server) and the `mssql` package for parameterized queries.

const sql = require('mssql');
const { getSqlPool } = require('../api_server'); // adjust path to your existing pool helper

/**
 * Returns the distinct (category, brand, salesperson) combinations,
 * optionally filtered, grouped into one row per salesperson.
 *
 * @param {Object} filters
 * @param {string} [filters.search]   - matches first name, last name, or email (contains, case-insensitive)
 * @param {string} [filters.category] - exact match on shopify_type_name
 * @param {string} [filters.brand]    - exact match on brand_name
 */
async function getMapping(filters = {}) {
  const pool = await getSqlPool();
  const request = pool.request();

  const whereClauses = [];

  if (filters.search) {
    request.input('search', sql.NVarChar, `%${filters.search}%`);
    whereClauses.push(
      `(first_name LIKE @search OR last_name LIKE @search OR email_id LIKE @search)`
    );
  }
  if (filters.category) {
    request.input('category', sql.NVarChar, filters.category);
    whereClauses.push(`shopify_type_name = @category`);
  }
  if (filters.brand) {
    request.input('brand', sql.NVarChar, filters.brand);
    whereClauses.push(`brand_name = @brand`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  // DISTINCT collapses the SKU-level view down to one row per
  // (category, brand, salesperson) combination.
  const result = await request.query(`
    SELECT DISTINCT
      shopify_type_name AS category,
      brand_name        AS brand,
      first_name        AS firstName,
      last_name         AS lastName,
      email_id          AS email
    FROM dbo.vw_Shopify_Product_SKUs_With_SalesPerson
    ${whereSql}
  `);

  return groupBySalesperson(result.recordset);
}

/**
 * Returns distinct category and brand values for the two filter dropdowns.
 * Excludes nulls — the dropdowns only list real values, not "Unassigned".
 */
async function getFilterOptions() {
  const pool = await getSqlPool();

  const [categoriesResult, brandsResult] = await Promise.all([
    pool.request().query(`
      SELECT DISTINCT shopify_type_name AS category
      FROM dbo.vw_Shopify_Product_SKUs_With_SalesPerson
      WHERE shopify_type_name IS NOT NULL
      ORDER BY shopify_type_name
    `),
    pool.request().query(`
      SELECT DISTINCT brand_name AS brand
      FROM dbo.vw_Shopify_Product_SKUs_With_SalesPerson
      WHERE brand_name IS NOT NULL
      ORDER BY brand_name
    `),
  ]);

  return {
    categories: categoriesResult.recordset.map((r) => r.category),
    brands: brandsResult.recordset.map((r) => r.brand),
  };
}

/**
 * Groups flat (category, brand, salesperson) rows into one entry per
 * salesperson, with an `assignments` array. A row where both category and
 * brand are null contributes no assignment (that salesperson is unassigned
 * unless another row for them has real values).
 */
function groupBySalesperson(rows) {
  const byEmail = new Map();

  for (const row of rows) {
    if (!row.email) continue; // no salesperson identity on this row at all — skip

    if (!byEmail.has(row.email)) {
      byEmail.set(row.email, {
        firstName: row.firstName || '',
        lastName: row.lastName || '',
        email: row.email,
        assignments: [],
      });
    }

    if (row.category || row.brand) {
      const entry = byEmail.get(row.email);
      const alreadyPresent = entry.assignments.some(
        (a) => a.category === row.category && a.brand === row.brand
      );
      if (!alreadyPresent) {
        entry.assignments.push({ category: row.category, brand: row.brand });
      }
    }
  }

  return Array.from(byEmail.values()).sort((a, b) =>
    `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
  );
}

module.exports = { getMapping, getFilterOptions };