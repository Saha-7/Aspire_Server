// src/services/inventoryService.js
// ─────────────────────────────────────────────────────────────
// Per-location stock handling for the PP update sheet.
//
//   getStockSnapshot(skus)  → current stock per SKU x location, read LIVE
//                             from Shopify (falls back to the view for
//                             downloads only).
//   applyStockUpdates(...)  → diff sheet vs live stock, push changes to
//                             Shopify, write every change to
//                             InventoryUpdateLog (audit trail).
//
// How locations are modelled (from the Shopify inventory table/view):
//   - one row per SKU x location, ONLY where the SKU is active at that location
//   - a missing row = location inactive for that SKU  → shown as "NA" in the sheet
//   - quantity 0     = active, no stock
//   - quantity < 0   = overbooked (order dispatched from another location) - valid
//
// Sheet cell rules (per location column):
//   location ACTIVE   + number n      → set quantity to n (skip if unchanged)
//   location ACTIVE   + blank         → set quantity to 0 (unless ALL location cells of the row are blank → row's stock untouched)
//   location ACTIVE   + NA            → rejected (deactivating is not supported)
//   location INACTIVE + number n >= 0 → ACTIVATE the location, then set n
//   location INACTIVE + NA or blank   → nothing (stays inactive)
//   negative numbers can only stay as they are (unchanged); new negatives are rejected
// ─────────────────────────────────────────────────────────────
const sql = require('mssql');
const { v4: uuidv4 } = require('uuid');
const { fetchInventoryViewRows } = require('./azureSqlService');
const {
  fetchLiveInventoryLevels, fetchShopifyLocations, setInventoryQuantities,
  activateInventoryLevel, lookupInventoryItemIdBySku,
} = require('./shopifyService');
const { log } = require('../../blobLogger');

const PUSH_BATCH_SIZE = 100;
const LOG_BATCH_SIZE  = 50;

const clean = (v) => String(v ?? '').replace(/[^\x20-\x7E]/g, '').trim();
const key   = (v) => clean(v).toLowerCase();

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

// ── Snapshot ──────────────────────────────────────────────────
// Which locations are ACTIVE for which SKU is read as follows:
//   1. the Shopify inventory view gives SKU → item id and a first picture of
//      the active locations (it only lags by the last sync);
//   2. the live Shopify read then replaces quantity AND active/inactive status
//      for every item it returns (so a location activated/deactivated since the
//      last sync is picked up);
//   3. columns (locations) = Shopify's ACTIVE locations when the app can read
//      them (read_locations), otherwise the locations found in the view.
//
// Returns {
//   source: 'shopify-live' | 'view-fallback',
//   locations: ['Ahmedabad','BLR-T','BLR-V',...]  (sorted)
//   locationIds: Map<locKey, { name, id }>
//   items: Map<skuKey, { sku, itemId, levels: Map<locKey, { locationName, locationId, itemId, qty }> }>
// }
// Every requested SKU gets an item entry, even if it has no active location.
async function getStockSnapshot(skus = null, { requireLive = false } = {}) {
  const viewRows = await fetchInventoryViewRows();
  const wanted   = skus ? new Set(skus.map(key)) : null;

  let locationIds = new Map();   // locKey -> { name, id }
  const viewNameById = new Map();
  const items = new Map();

  if (skus) for (const s of skus) if (clean(s)) items.set(key(s), { sku: clean(s), itemId: null, levels: new Map() });

  for (const r of viewRows) {
    const sku  = clean(r.sku);
    const name = clean(r.location_name);
    const locId = clean(r.location_id);
    if (!sku || !name) continue;

    if (!locationIds.has(key(name))) locationIds.set(key(name), { name, id: locId });
    viewNameById.set(locId, name);
    if (wanted && !wanted.has(key(sku))) continue;

    if (!items.has(key(sku))) items.set(key(sku), { sku, itemId: null, levels: new Map() });
    const it = items.get(key(sku));
    it.itemId = clean(r.item_id) || it.itemId;
    it.levels.set(key(name), {
      locationName: name,
      locationId:   locId,
      itemId:       clean(r.item_id),
      qty:          Number(r.quantity) || 0,
    });
  }

  // Shopify's active locations (columns). Optional: needs read_locations.
  let nameById = viewNameById;
  try {
    const shopLocs = await fetchShopifyLocations();
    if (shopLocs.length > 0) {
      nameById    = new Map(shopLocs.map(l => [l.id, l.name]));
      locationIds = new Map(shopLocs.map(l => [key(l.name), { name: l.name, id: l.id }]));
      for (const it of items.values()) {            // drop levels at locations that are no longer active
        const kept = new Map();
        for (const lv of it.levels.values()) {
          const name = nameById.get(lv.locationId);
          if (name) { lv.locationName = name; kept.set(key(name), lv); }
        }
        it.levels = kept;
      }
    }
  } catch (err) {
    log('WARN', 'inventoryService.js', 'getStockSnapshot', `Shopify locations unavailable, using view locations: ${err.message}`);
  }

  // Live overlay: quantity + active/inactive status straight from Shopify.
  let source = 'shopify-live';
  try {
    const itemIds = [...new Set([...items.values()].map(it => it.itemId).filter(Boolean))];
    const live = await fetchLiveInventoryLevels(itemIds);
    for (const it of items.values()) {
      if (!it.itemId || !live.has(it.itemId)) continue;
      const levels = new Map();
      for (const { locationId, qty } of live.get(it.itemId)) {
        const name = nameById.get(locationId);
        if (!name) continue; // location not active / not known
        levels.set(key(name), { locationName: name, locationId, itemId: it.itemId, qty });
      }
      it.levels = levels;
    }
  } catch (err) {
    log('ERROR', 'inventoryService.js', 'getStockSnapshot', `Live Shopify read failed: ${err.message}`);
    if (requireLive) throw httpError(502, `Could not read live stock from Shopify: ${err.message}`);
    source = 'view-fallback';
  }

  const locations = [...locationIds.values()].map(l => l.name).sort((a, b) => a.localeCompare(b));
  return { source, locations, locationIds, items };
}

// Plain-JSON version for the API. stock[skuLower][location] exists ONLY for
// active locations; a missing location means NA (inactive).
function snapshotToJson(snapshot) {
  const stock = {};
  for (const [skuKey, it] of snapshot.items) {
    stock[skuKey] = {};
    for (const lv of it.levels.values()) stock[skuKey][lv.locationName] = lv.qty;
  }
  return { source: snapshot.source, locations: snapshot.locations, stock };
}

// Location names only - for the blank template header.
async function getLocationNames() {
  try {
    const shopLocs = await fetchShopifyLocations();
    if (shopLocs.length > 0) return shopLocs.map(l => l.name).sort((a, b) => a.localeCompare(b));
  } catch (err) { /* fall back to the view */ }
  const viewRows = await fetchInventoryViewRows();
  const names = new Map();
  for (const r of viewRows) {
    const name = clean(r.location_name);
    if (name && !names.has(key(name))) names.set(key(name), name);
  }
  return [...names.values()].sort((a, b) => a.localeCompare(b));
}

// ── Cell parsing / decision ───────────────────────────────────
function parseCell(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { kind: 'blank' };
  if (/^(na|n\/a)$/i.test(s)) return { kind: 'na' };
  if (/^-?\d+$/.test(s)) return { kind: 'qty', qty: parseInt(s, 10) };
  return { error: `"${s}" must be a whole number, 0, or NA` };
}

// level = current active level for this SKU/location, or undefined (inactive).
// → { action: 'none' } | { action: 'set'|'activate', newQty } | { error }
function decideCell(parsed, level) {
  if (parsed.error) return { error: parsed.error };

  if (level) {
    if (parsed.kind === 'na') return { error: 'Location is active - NA cannot be used to deactivate it (use 0 for no stock)' };
    const newQty = parsed.kind === 'blank' ? 0 : parsed.qty;
    if (newQty === level.qty) return { action: 'none' };
    if (newQty < 0)           return { error: 'Negative stock cannot be entered' };
    return { action: 'set', newQty };
  }

  // inactive location
  if (parsed.kind === 'na' || parsed.kind === 'blank') return { action: 'none' };
  if (parsed.qty < 0) return { error: 'Cannot activate a location with negative stock' };
  return { action: 'activate', newQty: parsed.qty };
}

// ── Apply an upload ───────────────────────────────────────────
// rows: [{ skuId, stock: { '<Location header>': '<cell text>' } }]
async function applyStockUpdates(pool, { rows, updatedBy, ppSessionId = null, fileName = '' }) {
  const sessionId = uuidv4();
  const snapshot  = await getStockSnapshot(rows.map(r => r.skuId), { requireLive: true });

  // 1) Validate location headers against Shopify locations.
  const headerSet = new Set();
  for (const r of rows) for (const h of Object.keys(r.stock || {})) headerSet.add(h);
  const unknown = [...headerSet].filter(h => !snapshot.locationIds.has(key(h)));
  if (unknown.length) {
    throw httpError(400, `Unknown location column(s): ${unknown.join(', ')}. Valid locations: ${snapshot.locations.join(', ')}`);
  }

  // 2) Decide every cell. Validate EVERYTHING before pushing anything.
  const changes = [];
  const invalid = [];
  let unchanged = 0;

  for (const r of rows) {
    const item = snapshot.items.get(key(r.skuId));
    // Every location cell blank = this row's stock was not touched (nothing is zeroed).
    const cells = Object.values(r.stock || {});
    if (cells.every(v => String(v ?? '').trim() === '')) continue;
    for (const [header, raw] of Object.entries(r.stock || {})) {
      const loc     = snapshot.locationIds.get(key(header));
      const level   = item.levels.get(key(header));
      const decided = decideCell(parseCell(raw), level);

      if (decided.error) { invalid.push({ sku: r.skuId, location: header, error: decided.error }); continue; }
      if (decided.action === 'none') { if (level) unchanged++; continue; }

      changes.push({
        sku: item.sku, item,
        action:       decided.action,
        locationName: loc.name,
        locationId:   loc.id,
        itemId:       level ? level.itemId : null, // resolved below for activations
        oldQty:       level ? level.qty : null,
        newQty:       decided.newQty,
        status:       'Pending',
        error:        null,
      });
    }
  }

  if (invalid.length) {
    throw httpError(400, `${invalid.length} invalid stock cell(s). Nothing was pushed.`, { details: invalid.slice(0, 50) });
  }

  // 3a) Quantity changes at active locations - batched; if a batch is rejected,
  //     retry its entries one by one so only the genuinely bad ones fail.
  const toQty = (c) => ({ inventoryItemId: c.itemId, locationId: c.locationId, quantity: c.newQty });
  const sets  = changes.filter(c => c.action === 'set');
  for (let i = 0; i < sets.length; i += PUSH_BATCH_SIZE) {
    const batch = sets.slice(i, i + PUSH_BATCH_SIZE);
    try {
      await setInventoryQuantities(batch.map(toQty), sessionId);
      batch.forEach(c => { c.status = 'Pushed'; });
    } catch (batchErr) {
      for (const c of batch) {
        try {
          await setInventoryQuantities([toQty(c)], sessionId);
          c.status = 'Pushed';
        } catch (e) {
          c.status = 'Failed';
          c.error  = String(e.message).slice(0, 1000);
        }
      }
    }
  }

  // 3b) Activations (NA → active), one at a time: activate, then set quantity.
  for (const c of changes.filter(x => x.action === 'activate')) {
    try {
      c.itemId = c.itemId
        || c.item.itemId                                  // item id known from the view / live read
        || await lookupInventoryItemIdBySku(c.sku);      // SKU not active anywhere yet
      if (!c.itemId) throw new Error('SKU not found in Shopify inventory');

      await activateInventoryLevel(c.itemId, c.locationId);
      if (c.newQty !== 0) {
        try {
          await setInventoryQuantities([toQty(c)], sessionId);
        } catch (e) {
          throw new Error(`Location activated but quantity not set: ${e.message}`);
        }
      }
      c.status = 'Pushed';
    } catch (e) {
      c.status = 'Failed';
      c.error  = String(e.message).slice(0, 1000);
    }
  }

  // 4) Audit log - one row per changed cell. A logging failure must not hide
  //    the push result, so it is reported as a warning instead of thrown.
  let logWarning = null;
  try {
    await writeInventoryLog(pool, { sessionId, ppSessionId, fileName, updatedBy, changes });
  } catch (err) {
    logWarning = `Stock was updated but the audit log could not be written: ${err.message}`;
    log('ERROR', 'inventoryService.js', 'applyStockUpdates', logWarning);
  }

  const pushed    = changes.filter(c => c.status === 'Pushed').length;
  const activated = changes.filter(c => c.status === 'Pushed' && c.action === 'activate').length;
  const failures  = changes.filter(c => c.status === 'Failed')
    .map(c => ({ sku: c.sku, location: c.locationName, error: c.error }));

  log('INFO', 'inventoryService.js', 'applyStockUpdates',
    `session=${sessionId} | changed=${changes.length} pushed=${pushed} activated=${activated} failed=${failures.length} unchanged=${unchanged} | by=${updatedBy}`);

  return {
    sessionId,
    changed: changes.length,
    pushed,
    activated,
    failed: failures.length,
    unchanged,
    failures,
    changes: changes.map(c => ({
      sku: c.sku, location: c.locationName, action: c.action,
      oldQty: c.oldQty, newQty: c.newQty, status: c.status,
    })),
    logWarning,
  };
}

async function writeInventoryLog(pool, { sessionId, ppSessionId, fileName, updatedBy, changes }) {
  for (let i = 0; i < changes.length; i += LOG_BATCH_SIZE) {
    const batch = changes.slice(i, i + LOG_BATCH_SIZE);
    const req   = pool.request();
    const values = batch.map((c, idx) => {
      const n = i + idx;
      req.input(`sid${n}`,  sql.NVarChar(36),   sessionId);
      req.input(`pps${n}`,  sql.NVarChar(36),   ppSessionId || null);
      req.input(`sku${n}`,  sql.NVarChar(100),  c.sku);
      req.input(`ln${n}`,   sql.NVarChar(100),  c.locationName);
      req.input(`lid${n}`,  sql.NVarChar(100),  c.locationId);
      req.input(`iid${n}`,  sql.NVarChar(100),  c.itemId || '');
      req.input(`act${n}`,  sql.NVarChar(10),   c.action === 'activate' ? 'Activate' : 'Set');
      req.input(`old${n}`,  sql.Int,            c.oldQty);
      req.input(`new${n}`,  sql.Int,            c.newQty);
      req.input(`st${n}`,   sql.NVarChar(20),   c.status);
      req.input(`err${n}`,  sql.NVarChar(1000), c.error || null);
      req.input(`fn${n}`,   sql.NVarChar(500),  fileName || '');
      req.input(`by${n}`,   sql.NVarChar(150),  updatedBy);
      return `(@sid${n},@pps${n},@sku${n},@ln${n},@lid${n},@iid${n},@act${n},@old${n},@new${n},@st${n},@err${n},@fn${n},@by${n})`;
    });
    await req.query(`
      INSERT INTO InventoryUpdateLog
        (SessionID, PPSessionID, SKU, LocationName, LocationId, InventoryItemId,
         Action, OldQty, NewQty, PushStatus, ErrorMessage, FileName, UpdatedBy)
      VALUES ${values.join(',')}
    `);
  }
}

module.exports = { getStockSnapshot, getLocationNames, snapshotToJson, applyStockUpdates, parseCell, decideCell };