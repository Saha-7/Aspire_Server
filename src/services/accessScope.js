// src/services/accessScope.js
// ─────────────────────────────────────────────────────────────
// Role-based data scoping (RBAC) for category + brand.
//
//   admin, supervisor → unrestricted (see and change everything)
//   assigned sales     → restricted to the (category, brand) pairs mapped to
//                        their email in vw_Shopify_Product_SKUs_With_SalesPerson
//   unassigned sales   → READ-ONLY: can see everything, can change nothing
//                        (no assignments yet, e.g. a new joiner)
//
// Rules:
//   • Only pairs where BOTH category and brand are filled count as a grant.
//   • If the mapping cannot be loaded, the request FAILS (never "show all").
//   • Every write route must use requireWriteAccess (below) — it blocks the
//     read-only role before the handler runs.
//
// Usage in a route:
//   const scope = await getUserScope(req);
//   const visible = scope.filterRows(rows);                 // rows have Category + Brand
//   const { allowed, denied } = await partitionSkus(pool, scope, skus);
// ─────────────────────────────────────────────────────────────

const { getAssignedPairsForEmail } = require('./salespersonMappingService');

const UNRESTRICTED_ROLES = new Set(['admin', 'supervisor']);

const norm = (v) => String(v ?? '').trim().toLowerCase();
const pairKey = (category, brand) => `${norm(category)}\u0001${norm(brand)}`;

function buildScope(pairs) {
  const keys = new Set(pairs.map((p) => pairKey(p.category, p.brand)));
  const categories = new Set(pairs.map((p) => norm(p.category)));

  return {
    unrestricted: false,
    readOnly: false,
    pairs,

    /** Is this exact category + brand assigned to the user? */
    allows(category, brand) {
      return keys.has(pairKey(category, brand));
    },

    /** Is the user assigned anything at all in this category? (used for alerts that have no brand) */
    allowsCategory(category) {
      return categories.has(norm(category));
    },

    /** Keep only rows the user may see. Rows must carry Category and Brand. */
    filterRows(rows, { category = 'Category', brand = 'Brand' } = {}) {
      return rows.filter((r) => keys.has(pairKey(r[category], r[brand])));
    },
  };
}

const UNRESTRICTED = {
  unrestricted: true,
  readOnly: false,
  pairs: null,
  allows: () => true,
  allowsCategory: () => true,
  filterRows: (rows) => rows,
};

// Sales user with no category/brand assigned yet: sees everything, changes nothing.
const READ_ONLY = {
  unrestricted: true,   // reads are not filtered
  readOnly: true,       // writes are blocked by requireWriteAccess
  pairs: [],
  allows: () => true,
  allowsCategory: () => true,
  filterRows: (rows) => rows,
};

const READ_ONLY_MESSAGE =
  'Your account is read-only until categories are assigned to you. Please contact your manager.';

/** Build the access scope for the logged-in user (reads the session). */
async function getUserScope(req) {
  const user = req.session?.user;
  if (!user) {
    const err = new Error('Not authenticated');
    err.status = 401;
    throw err;
  }
  if (UNRESTRICTED_ROLES.has(user.role)) return UNRESTRICTED;

  const pairs = await getAssignedPairsForEmail(user.email); // throws if db_returns is unreachable → fail closed
  if (pairs.length === 0) return READ_ONLY;
  return buildScope(pairs);
}

/**
 * Express middleware for every route that CHANGES data (use after requireAuth).
 * Read-only users get a 403 before the handler runs; everyone else continues.
 * Fails closed: if the user's access can't be determined, the request is refused.
 */
function requireWriteAccess(req, res, next) {
  getUserScope(req)
    .then((scope) => {
      if (scope.readOnly) {
        return res.status(403).json({ success: false, error: READ_ONLY_MESSAGE, readOnly: true });
      }
      next();
    })
    .catch((err) => {
      res.status(err.status || 500).json({ success: false, error: err.message });
    });
}

/**
 * Split SKUs into the ones the user may touch and the ones they may not.
 * SKUs that don't exist in InternalProducts are returned in `denied` for a
 * restricted user (they could not be verified as theirs).
 */
async function partitionSkus(pool, scope, skus) {
  const list = (skus || []).map((s) => String(s ?? ''));
  if (scope.unrestricted) return { allowed: list, denied: [] };
  if (list.length === 0 || scope.pairs.length === 0) return { allowed: [], denied: list };

  const result = await pool.request().query(
    'SELECT SKU_ID, Category, Brand FROM InternalProducts'
  );
  const ok = new Set(
    result.recordset
      .filter((r) => scope.allows(r.Category, r.Brand))
      .map((r) => norm(r.SKU_ID))
  );

  const allowed = [];
  const denied = [];
  for (const sku of list) (ok.has(norm(sku)) ? allowed : denied).push(sku);
  return { allowed, denied };
}

/** Convenience for a single SKU. */
async function isSkuAllowed(pool, scope, skuId) {
  if (scope.unrestricted) return true;
  const { allowed } = await partitionSkus(pool, scope, [skuId]);
  return allowed.length === 1;
}

module.exports = { getUserScope, partitionSkus, isSkuAllowed, requireWriteAccess };