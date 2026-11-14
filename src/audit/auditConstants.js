// src/audit/auditConstants.js
// Adding a new module later = add ONE line here. No schema change.
const MODULES = Object.freeze({
  SELLING_PRICE:  'SELLING_PRICE',
  PURCHASE_PRICE: 'PURCHASE_PRICE',
  STOCK:          'STOCK',
  INSIGHTS:       'INSIGHTS',
  BUSINESS_VARS:  'BUSINESS_VARS',
  CATEGORY_MAP:   'CATEGORY_MAP',
  USERS:          'USERS',
  SCRAPER:        'SCRAPER',
  AUTH:           'AUTH',
});

const ACTIONS = Object.freeze({
  CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE', DISMISS: 'DISMISS',
  PUSH: 'PUSH', BULK_UPLOAD: 'BULK_UPLOAD', BULK_DISMISS: 'BULK_DISMISS',
  TRIGGER: 'TRIGGER', FINISH: 'FINISH', REFRESH: 'REFRESH',
  LOGIN: 'LOGIN', LOGOUT: 'LOGOUT', LOGIN_DENIED: 'LOGIN_DENIED',
});

const SOURCES = Object.freeze({ UI: 'UI', CSV_UPLOAD: 'CSV_UPLOAD', SYSTEM: 'SYSTEM' });

const STATUS = Object.freeze({ SUCCESS: 'SUCCESS', FAILED: 'FAILED', DENIED: 'DENIED', PARTIAL: 'PARTIAL' });

module.exports = { MODULES, ACTIONS, SOURCES, STATUS };