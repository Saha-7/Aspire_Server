// src/routes/businessVariablesRoutes.js
// Mount in api_server.js (after the other routers):
//   app.use('/api/business-variables', requireAuth,
//           require('./routes/businessVariablesRoutes')(getSqlPool));
'use strict';

const express = require('express');
const sql = require('mssql');
const audit = require('../audit/auditService');
const { MODULES, ACTIONS, SOURCES } = require('../audit/auditConstants');
const { getUserScope, requireWriteAccess } = require('../services/accessScope');
const {
  getSettingsTree, loadBusinessVariables, saveVariables, ConflictError, norm,
} = require('../services/businessVariablesService');

module.exports = function businessVariablesRoutes(getSqlPool) {
  const router = express.Router();

  // GET /api/business-variables  -> { defs, categories:[{ own, effective, brands:[...] }] }
  router.get('/', async (req, res) => {
    try {
      const pool  = await getSqlPool();
      const scope = await getUserScope(req);   // fails closed if the mapping can't be loaded
      res.json({ success: true, data: await getSettingsTree(pool, scope) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // PUT /api/business-variables
  // body: { categoryName, brandName: '' | 'Dell', changes: [{ varKey, value, version }] }
  router.put('/', requireWriteAccess, async (req, res) => {
    const categoryName = norm(req.body?.categoryName);
    const brandName    = norm(req.body?.brandName);
    const changes      = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (!categoryName || changes.length === 0) {
      return res.status(400).json({ success: false, error: 'categoryName and changes are required' });
    }

    let tx = null;
    try {
      const pool  = await getSqlPool();
      const scope = await getUserScope(req);
      // Policy (confirmed): restricted salespeople may only edit brand rows of their own
      // category+brand pairs; category-level (parent) rows need admin/supervisor.
      if (!scope.unrestricted && (!brandName || !scope.allows(categoryName, brandName))) {
        return res.status(403).json({ success: false, error: 'You can only change variables for your assigned category/brand.' });
      }

      const bv = await loadBusinessVariables(pool);
      const clean = [];
      for (const c of changes) {
        const def = bv.defsByKey.get(c.varKey);
        if (!def) return res.status(400).json({ success: false, error: `Unknown variable ${c.varKey}` });
        let value = null;
        if (c.value !== null && c.value !== undefined && c.value !== '') {
          value = Number(c.value);
          if (!Number.isFinite(value) || value < def.min || value > def.max) {
            return res.status(400).json({ success: false, error: `${def.label} must be between ${def.min} and ${def.max}` });
          }
        }
        clean.push({ varKey: c.varKey, value, version: c.version || null });
      }

      tx = new sql.Transaction(pool);
      await tx.begin();                                   // READ COMMITTED (Azure SQL: row-versioned reads)
      const applied = await saveVariables(tx, {
        category: categoryName, brand: brandName, changes: clean,
        updatedBy: req.session?.user?.email || 'unknown', defsByKey: bv.defsByKey,
      });

      if (applied.length) {
        const text = applied.map((c) => `${c.field} ${c.old ?? 'inherit'} → ${c.new ?? 'inherit'}`).join(', ');
        await audit.record(tx, {
          ...audit.actorFromReq(req), module: MODULES.BUSINESS_VARS, action: ACTIONS.UPDATE, source: SOURCES.UI,
          entityType: brandName ? 'CATEGORY_BRAND' : 'CATEGORY',
          entityId: brandName ? `${categoryName} / ${brandName}` : categoryName,
          category: categoryName, brand: brandName || null,
          summary: `Business variables for ${categoryName}${brandName ? ' / ' + brandName : ''}: ${text}`,
          details: { changes: applied },
        });
      }
      await tx.commit(); tx = null;

      const tree = await getSettingsTree(pool, scope);        // fresh versions for the client
      res.json({ success: true, data: tree.categories.find((c) => norm(c.categoryName).toLowerCase() === categoryName.toLowerCase()) || null });
    } catch (err) {
      if (tx) { try { await tx.rollback(); } catch (_) { /* already aborted */ } }
      const status = err instanceof ConflictError ? 409 : (err.status || 500);
      res.status(status).json({ success: false, error: err.message, conflict: status === 409, details: err.details || null });
    }
  });

  return router;
};