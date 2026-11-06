// src/routes/salespersonMappingRoutes.js
// ─────────────────────────────────────────────────────────────
// Admin-only, read-only routes for the Category/Brand -> Salesperson panel.
//
// Mounted in api_server.js (already done):
//   app.use('/api/salesperson-mapping', requireRole('admin'),
//           require('./routes/salespersonMappingRoutes')(getSqlPool));
//
// The factory still accepts getSqlPool so that line needs no change, but it
// is no longer used: the mapping view lives in db_returns and is read through
// azureSqlService, not through the db_tpstechautomata pool.
// ─────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const { getMapping, getFilterOptions } = require('../services/salespersonMappingService');

module.exports = function salespersonMappingRoutes(/* getSqlPool — unused */) {
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