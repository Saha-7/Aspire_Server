// src/routes/auditRoutes.js
// ─────────────────────────────────────────────────────────────
// Admin-only READ API for the audit log. Mounted in api_server.js as:
//   app.use('/api/audit', requireRole('admin'), require('./routes/auditRoutes')(getSqlPool));
//
//   GET /api/audit/events   filters + keyset paging (the filterable table)
//   GET /api/audit/recent   latest top-level activity (the Azure-style feed)
//   GET /api/audit/filters  values for the filter dropdowns
// ─────────────────────────────────────────────────────────────
'use strict';

const express = require('express');
const sql = require('mssql');

const escapeLike = (s) => String(s).replace(/[\\%_\[]/g, (m) => `\\${m}`);

module.exports = function auditRoutes(getSqlPool) {
  const router = express.Router();

  // GET /api/audit/events?last=1h|3h|6h|24h|7d&module=&action=&status=&source=&actor=&entityId=&category=&brand=&batchId=&from=&to=&limit=&beforeId=
  router.get('/events', async (req, res) => {
    try {
      const q = req.query;
      const limit = Math.min(Math.max(parseInt(q.limit, 10) || 50, 1), 200);
      const pool = await getSqlPool();
      const r = pool.request().input('Limit', sql.Int, limit);
      const where = [];

      const eq = (col, name, type, val) => { r.input(name, type, val); where.push(`${col} = @${name}`); };
      if (q.module)   eq('Module',     'Module',   sql.VarChar(40),      q.module);
      if (q.action)   eq('Action',     'Action',   sql.VarChar(40),      q.action);
      if (q.status)   eq('Status',     'Status',   sql.VarChar(10),      q.status);
      if (q.source)   eq('Source',     'Source',   sql.VarChar(20),      q.source);
      if (q.actor)    eq('ActorEmail', 'Actor',    sql.NVarChar(256),    String(q.actor).toLowerCase());
      if (q.category) eq('Category',   'Category', sql.NVarChar(200),    q.category);
      if (q.brand)    eq('Brand',      'Brand',    sql.NVarChar(200),    q.brand);
      if (q.batchId) {
        if (!/^[0-9a-f-]{36}$/i.test(q.batchId)) return res.status(400).json({ success: false, error: 'Invalid batchId' });
        eq('BatchId', 'BatchId', sql.UniqueIdentifier, q.batchId);
      }
      if (q.entityId) { // prefix match so "ABC" finds "ABC-123"
        r.input('EntityId', sql.NVarChar(200), `${escapeLike(q.entityId)}%`);
        where.push(`EntityId LIKE @EntityId ESCAPE '\\'`);
      }
      // Quick windows (computed on the server in UTC, so browser time zones can't skew it)
      const WINDOWS = { '15m': 15, '1h': 60, '3h': 180, '6h': 360, '12h': 720, '24h': 1440, '1d': 1440, '7d': 10080, '15d': 21600, '30d': 43200, '45d': 64800 };
      if (q.last) {
        const mins = WINDOWS[String(q.last).toLowerCase()];
        if (!mins) return res.status(400).json({ success: false, error: `last must be one of: ${Object.keys(WINDOWS).join(', ')}` });
        r.input('LastMins', sql.Int, mins);
        where.push('OccurredAt >= DATEADD(MINUTE, -@LastMins, SYSUTCDATETIME())');
      }
      for (const [key, col, op] of [['from', 'From', '>='], ['to', 'To', '<']]) {
        if (q[key] && !(key === 'from' && q.last)) {
          const d = new Date(q[key]);
          if (isNaN(d)) return res.status(400).json({ success: false, error: `Invalid ${key} date` });
          r.input(col, sql.DateTime2, d);
          where.push(`OccurredAt ${op} @${col}`);
        }
      }
      if (q.beforeId) {
        if (!/^\d+$/.test(String(q.beforeId))) return res.status(400).json({ success: false, error: 'Invalid beforeId' });
        r.input('BeforeId', sql.BigInt, q.beforeId);
        where.push('EventId < @BeforeId');
      }

      const result = await r.query(`
        SELECT TOP (@Limit)
               EventId, OccurredAt, ActorEmail, ActorName, ActorRole, Module, Action, Source, Status,
               EntityType, EntityId, Category, Brand, FieldName, OldValue, NewValue, Summary, Details, BatchId
        FROM dbo.AuditEvents
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY EventId DESC
      `);
      const rows = result.recordset;
      res.json({ success: true, data: { rows, nextBeforeId: rows.length === limit ? String(rows[rows.length - 1].EventId) : null } });
    } catch (err) {
      console.error('❌ /api/audit/events error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/audit/recent?limit=20  → batch children are hidden; only each upload/bulk action's summary row shows
  router.get('/recent', async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
      const pool = await getSqlPool();
      const result = await pool.request().input('Limit', sql.Int, limit).query(`
        SELECT TOP (@Limit) EventId, OccurredAt, ActorEmail, ActorName, Module, Action, Status, Summary, BatchId
        FROM dbo.AuditEvents
        WHERE BatchId IS NULL OR EntityType IN ('FILE', 'BATCH')
        ORDER BY EventId DESC
      `);
      res.json({ success: true, data: result.recordset });
    } catch (err) {
      console.error('❌ /api/audit/recent error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/audit/filters
  router.get('/filters', async (req, res) => {
    try {
      const pool = await getSqlPool();
      const result = await pool.request().query(`
        SELECT DISTINCT Module FROM dbo.AuditEvents ORDER BY Module;
        SELECT DISTINCT Action FROM dbo.AuditEvents ORDER BY Action;
        SELECT DISTINCT ActorEmail FROM dbo.AuditEvents ORDER BY ActorEmail;
        SELECT DISTINCT Category FROM dbo.AuditEvents WHERE Category IS NOT NULL ORDER BY Category;
        SELECT DISTINCT Brand FROM dbo.AuditEvents WHERE Brand IS NOT NULL ORDER BY Brand;
      `);
      const [mods, acts, actors, cats, brands] = result.recordsets;
      res.json({
        success: true,
        data: {
          modules: mods.map((x) => x.Module),
          actions: acts.map((x) => x.Action),
          actors:  actors.map((x) => x.ActorEmail),
          categories: cats.map((x) => x.Category),
          brands:     brands.map((x) => x.Brand),
          statuses: ['SUCCESS', 'FAILED', 'DENIED', 'PARTIAL'],
          sources:  ['UI', 'CSV_UPLOAD', 'SYSTEM'],
        },
      });
    } catch (err) {
      console.error('❌ /api/audit/filters error:', err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};