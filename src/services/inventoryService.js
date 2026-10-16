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
//   ANY location      + blank         → no action (active or inactive)
//   location ACTIVE   + 0             → stock set to 0 (this is the only way to zero a location)
//   location ACTIVE   + NA            → rejected (deactivating is not supported)
//   location INACTIVE + number        → rejected: locations are activated in Shopify only, never from the sheet
//   location INACTIVE + NA            → nothing (stays inactive)
//   negative numbers can only stay as they are (unchanged); new negatives are rejected
// ─────────────────────────────────────────────────────────────
const sql = require('mssql');
const { v4: uuidv4 } = require('uuid');
const { fetchInventoryViewRows } = require('./azureSqlService');
const { fetchLiveInventoryLevels, fetchShopifyLocations, setInventoryQuantities } = require('./shopifyService');
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
// skipLive: a reason string → don't call Shopify per item, use the view's quantities (large exports).
async function getStockSnapshot(skus = null, { requireLive = false, skipLive = null } = {}) {
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
  let liveError = null;
  if (skipLive) {
    source = 'view-fallback';
    liveError = skipLive;
  } else try {
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
    if (requireLive) {
      throw httpError(502, 'Current stock could not be read from Shopify right now, so nothing was changed. Please try again in a few minutes. If it keeps happening, contact the tech team.', { technical: err.message });
    }
    source = 'view-fallback';
    liveError = err.message;
  }

  const locations = [...locationIds.values()].map(l => l.name).sort((a, b) => a.localeCompare(b));
  return { source, liveError, locations, locationIds, items };
}

// Plain-JSON version for the API. stock[skuLower][location] exists ONLY for
// active locations; a missing location means NA (inactive).
function snapshotToJson(snapshot) {
  const stock = {};
  for (const [skuKey, it] of snapshot.items) {
    stock[skuKey] = {};
    for (const lv of it.levels.values()) stock[skuKey][lv.locationName] = lv.qty;
  }
  return { source: snapshot.source, liveError: snapshot.liveError || null, locations: snapshot.locations, stock };
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
  return { error: `"${s}" is not valid. Use a whole number like 0, 5 or 12, or leave the cell blank.` };
}

// level = current active level for this SKU/location, or undefined (inactive).
// → { action: 'none' } | { action: 'set'|'activate', newQty } | { error }
function decideCell(parsed, level) {
  if (parsed.error) return { error: parsed.error };
  if (parsed.kind === 'blank') return { action: 'none' };   // blank = no action, active or inactive

  if (level) {
    if (parsed.kind === 'na') return { error: 'This SKU is active at this location, so NA cannot be used. NA would mean switching the location off, which cannot be done from this sheet. Type 0 if there is no stock, or leave the cell blank for no change.' };
    if (parsed.qty === level.qty) return { action: 'none' };
    if (parsed.qty < 0)           return { error: 'Stock cannot be set to a negative number. Use 0 or a positive number.' };
    return { action: 'set', newQty: parsed.qty };
  }

  // inactive location - locations are activated in Shopify only, never from the sheet
  if (parsed.kind === 'na') return { action: 'none' };
  return { error: 'This SKU is not active at this location in Shopify, so stock cannot be added here. Ask the Shopify team to activate the location for this SKU first, then upload again. Or leave the cell blank or NA.' };
}

// Plain-language version of a Shopify/technical error for the people using the sheet.
// The raw text is still returned separately as "technical" for the tech team.
function friendlyShopifyMessage(raw) {
  const m = String(raw || '');
  // Problems in our own request (software side) - checked first so they are never mistaken for data problems
  if (/INVALID_VARIABLE|directiveCannotBeApplied|undefinedField|argumentLiteralsIncompatible|Field is not defined|doesn't exist on type|Variable \$/i.test(m))
    return 'The app sent Shopify a request that Shopify did not accept. This is a software problem, not a problem with your file or your data. Please contact the tech team and share the technical details.';
  if (/ACCESS_DENIED|access denied/i.test(m))
    return 'The app does not have permission to change stock in Shopify. Please contact the tech team.';
  if (/THROTTLED|throttle|too many requests|429/i.test(m))
    return 'Shopify is busy right now. Please wait a minute and upload the same file again.';
  if (/CHANGE_FROM_QUANTITY_STALE|stale/i.test(m))
    return 'The stock changed in Shopify while you were uploading (for example a sale). Please download a fresh file and try again.';
  if (/not stocked|is not stocked/i.test(m))
    return 'Shopify says this SKU is not stocked at this location. Check that the location is active for this SKU in Shopify.';
  if (/timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|socket/i.test(m))
    return 'Could not reach Shopify. Please try again in a few minutes.';
  return 'Shopify could not update this stock. Please try again. If it keeps failing, send the technical details to the tech team.';
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
        itemId:       level.itemId,
        oldQty:       level.qty,
        newQty:       decided.newQty,
        status:       'Pending',
        error:        null,
      });
    }
  }

  if (invalid.length) {
    throw httpError(400, `${invalid.length} invalid stock cell(s). Nothing was pushed.`, { details: invalid.slice(0, 50) });
  }

  // 3) Quantity changes at active locations - batched; if a batch is rejected,
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
  const failures  = changes.filter(c => c.status === 'Failed')
    .map(c => ({ sku: c.sku, location: c.locationName, error: friendlyShopifyMessage(c.error), technical: c.error }));

  log('INFO', 'inventoryService.js', 'applyStockUpdates',
    `session=${sessionId} | changed=${changes.length} pushed=${pushed} failed=${failures.length} unchanged=${unchanged} | by=${updatedBy}`);

  return {
    sessionId,
    changed: changes.length,
    pushed,
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
      req.input(`act${n}`,  sql.NVarChar(10),   'Set');
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