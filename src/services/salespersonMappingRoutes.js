// src/routes/salespersonMappingRoutes.js
// ─────────────────────────────────────────────────────────────
// Admin-only, read-only routes for the Category/Brand -> Salesperson panel.
//
// Mounted in api_server.js:
//   app.use('/api/salesperson-mapping', requireRole('admin'),
//           require('./routes/salespersonMappingRoutes')(getSqlPool));
//
// The mapping view lives in db_returns (read via azureSqlService). The
// main pool (getSqlPool) is only used to read UserRoles, so that sales users
// who have NO assignment yet still appear in the list as "Unassigned"
// (the view itself is product-driven and never lists them).
// ─────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const { getMapping, getFilterOptions } = require('../services/salespersonMappingService');

module.exports = function salespersonMappingRoutes(getSqlPool) {
  const router = express.Router();

  // GET /api/salesperson-mapping?search=&category=&brand=
  router.get('/', async (req, res) => {
    try {
      const { search, category, brand } = req.query;
      const salespeople = await getMapping({
        search:   search   || null,
        category: category || null,
        brand:    brand    || null,
      });

      // Add `sales` users that have no assignment at all.
      // Skipped when a category/brand filter is active (they match neither).
      if (!category && !brand) {
        try {
          const pool = await getSqlPool(); // shared pool — never close it here
          const result = await pool.request().query(
            `SELECT Email FROM UserRoles WHERE Role = 'sales'`
          );
          const known = new Set(salespeople.map((s) => s.email.toLowerCase()));
          const q = (search || '').trim().toLowerCase();

          for (const { Email } of result.recordset) {
            const email = String(Email || '').trim();
            if (!email || known.has(email.toLowerCase())) continue;
            if (q && !email.toLowerCase().includes(q)) continue;
            salespeople.push({
              firstName: email.split('@')[0], // UserRoles has no display name
              lastName: '',
              email,
              assignments: [],
            });
          }
          salespeople.sort((a, b) =>
            `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`)
          );
        } catch (mergeErr) {
          // Non-fatal: the mapping itself is still correct without the extras
          console.error('⚠️ salesperson-mapping: could not add unassigned sales users:', mergeErr.message);
        }
      }

      res.json({ success: true, data: salespeople });
    } catch (err) {
      console.error('❌ /api/salesperson-mapping error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/salesperson-mapping/filters
  router.get('/filters', async (req, res) => {
    try {
      const data = await getFilterOptions();
      res.json({ success: true, data });
    } catch (err) {
      console.error('❌ /api/salesperson-mapping/filters error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};