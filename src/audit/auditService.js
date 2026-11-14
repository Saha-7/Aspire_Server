// src/audit/auditService.js
// ─────────────────────────────────────────────────────────────
// Single write path for the audit log (dbo.AuditEvents).
//
//   record(target, event)        one row; THROWS on failure
//   recordMany(target, events)   many rows, ONE round trip (JSON + OPENJSON)
//   recordSafe(target, event|[]) never throws; failures go to the blob log.
//                                Use AFTER an external side effect (Shopify)
//                                has already happened, and for login/logout.
//   actorFromReq(req)            who + IP from the session
//   getSkuMeta(target, skus)     Category/Brand/PP/SP per SKU (current values)
//
// `target` = a connection pool OR an mssql Transaction. Pass the transaction
// of the business change so the change and its audit row commit together.
// This module never closes the pool.
// ─────────────────────────────────────────────────────────────

'use strict';

const sql = require('mssql');
const { log } = require('../../blobLogger');
const { MODULES, ACTIONS, SOURCES, STATUS } = require('./auditConstants');

const str = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
const normSku = (s) => String(s ?? '').trim().toLowerCase();

// Azure App Service sends "1.2.3.4:5678" in x-forwarded-for; keep only the address.
function clientIp(req) {
  const raw = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  const v6 = raw.match(/^\[([^\]]+)\](?::\d+)?$/);          // [::1]:1234
  if (v6) return v6[1];
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(raw)) return raw.replace(/:\d+$/, ''); // 1.2.3.4:1234
  return raw || null;
}

function actorFromReq(req) {
  const u = req.session?.user || {};
  return {
    actorEmail: u.email || 'unknown',
    actorName:  u.name  || null,
    actorRole:  u.role  || null,
    ipAddress:  clientIp(req),
  };
}

function normalize(e) {
  if (!e || !e.module || !e.action || !e.summary || !e.actorEmail) {
    throw new Error('Audit event needs module, action, summary and actorEmail');
  }
  return {
    actorEmail: str(e.actorEmail, 256),
    actorName:  str(e.actorName, 200),
    actorRole:  str(e.actorRole, 30),
    module:     str(e.module, 40),
    action:     str(e.action, 40),
    source:     str(e.source || SOURCES.UI, 20),
    status:     str(e.status || STATUS.SUCCESS, 10),
    entityType: str(e.entityType, 40),
    entityId:   str(e.entityId, 200),
    category:   str(e.category, 200),
    brand:      str(e.brand, 200),
    fieldName:  str(e.fieldName, 100),
    oldValue:   str(e.oldValue, 500),
    newValue:   str(e.newValue, 500),
    summary:    str(e.summary, 500),
    details:    e.details ? JSON.stringify(e.details) : null,
    batchId:    e.batchId || null,
    ipAddress:  str(e.ipAddress, 64),
  };
}

async function recordMany(target, events) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  const payload = JSON.stringify(events.map(normalize));
  await target.request()
    .input('Events', sql.NVarChar(sql.MAX), payload)
    .query(`
      INSERT INTO dbo.AuditEvents
        (ActorEmail, ActorName, ActorRole, Module, Action, Source, Status, EntityType, EntityId,
         Category, Brand, FieldName, OldValue, NewValue, Summary, Details, BatchId, IpAddress)
      SELECT ActorEmail, ActorName, ActorRole, Module, Action, Source, Status, EntityType, EntityId,
             Category, Brand, FieldName, OldValue, NewValue, Summary, Details, BatchId, IpAddress
      FROM OPENJSON(@Events) WITH (
        ActorEmail NVARCHAR(256) '$.actorEmail',
        ActorName  NVARCHAR(200) '$.actorName',
        ActorRole  VARCHAR(30)   '$.actorRole',
        Module     VARCHAR(40)   '$.module',
        Action     VARCHAR(40)   '$.action',
        Source     VARCHAR(20)   '$.source',
        Status     VARCHAR(10)   '$.status',
        EntityType VARCHAR(40)   '$.entityType',
        EntityId   NVARCHAR(200) '$.entityId',
        Category   NVARCHAR(200) '$.category',
        Brand      NVARCHAR(200) '$.brand',
        FieldName  NVARCHAR(100) '$.fieldName',
        OldValue   NVARCHAR(500) '$.oldValue',
        NewValue   NVARCHAR(500) '$.newValue',
        Summary    NVARCHAR(500) '$.summary',
        Details    NVARCHAR(MAX) '$.details',
        BatchId    UNIQUEIDENTIFIER '$.batchId',
        IpAddress  VARCHAR(64)   '$.ipAddress'
      )
    `);
  return events.length;
}

const record = (target, event) => recordMany(target, [event]);

async function recordSafe(target, eventOrEvents) {
  try {
    await recordMany(target, Array.isArray(eventOrEvents) ? eventOrEvents : [eventOrEvents]);
    return true;
  } catch (err) {
    const first = Array.isArray(eventOrEvents) ? eventOrEvents[0] : eventOrEvents;
    console.error('❌ [audit] write failed:', err.message);
    try { log('ERROR', 'auditService.js', 'recordSafe', `Audit write failed (${first?.module}/${first?.action}): ${err.message}`); } catch (_) {}
    return false;
  }
}

/** Current Category/Brand/PP/SP for a list of SKUs → Map keyed by trimmed lower-case SKU. */
async function getSkuMeta(target, skus) {
  const list = [...new Set((skus || []).map((s) => String(s ?? '')).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const r = await target.request()
    .input('Skus', sql.NVarChar(sql.MAX), JSON.stringify(list))
    .query(`
      SELECT SKU_ID, PP, SP, Category, Brand
      FROM dbo.InternalProducts
      WHERE SKU_ID IN (SELECT value FROM OPENJSON(@Skus))
    `);
  for (const row of r.recordset) {
    map.set(normSku(row.SKU_ID), { sku: row.SKU_ID, pp: row.PP, sp: row.SP, category: row.Category, brand: row.Brand });
  }
  return map;
}

module.exports = {
  record, recordMany, recordSafe, actorFromReq, clientIp, getSkuMeta, normSku,
  MODULES, ACTIONS, SOURCES, STATUS,
};