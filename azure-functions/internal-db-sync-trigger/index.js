'use strict';

module.exports = async function (context, myTimer) {
  const timeStamp = new Date().toISOString();
  context.log('⏰ internal-db-sync-trigger fired:', timeStamp, 'pastDue=', !!(myTimer && myTimer.isPastDue));

  let blob = null;
  try {
    blob = require('../blobLogger');
  } catch (e) {
    context.log.error('❌ blobLogger failed to load:', e.stack || e.message);
  }
  const wl = (level, msg) => { if (blob) blob.log(level, 'internal-db-sync-trigger', 'run', msg); };

  try {
    wl('INFO', `fired at ${timeStamp}`);
    const { syncInternalProducts } = require('../src/internal_db_sync');
    const result = await syncInternalProducts();
    wl('INFO', `done — rows touched: ${result.rowsTouched}, total: ${result.totalSec}s`);
    context.log(`✅ InternalProducts sync completed — ${result.rowsTouched} rows touched`);
  } catch (err) {
    wl('ERROR', `failed: ${err.stack || err.message}`);
    context.log.error('❌ InternalProducts sync failed:', err.stack || err.message);
  } finally {
    if (blob) await blob.flush();
  }
};