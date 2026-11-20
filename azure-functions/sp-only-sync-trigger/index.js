'use strict';

module.exports = async function (context, myTimer) {
  const timeStamp = new Date().toISOString();
  context.log('⏰ sp-only-sync-trigger fired:', timeStamp);

  let blob = null;
  try {
    blob = require('../blobLogger');
  } catch (e) {
    context.log.error('❌ blobLogger failed to load:', e.stack || e.message);
  }
  const wl = (level, msg) => { if (blob) blob.log(level, 'sp-only-sync-trigger', 'run', msg); };

  try {
    wl('INFO', `fired at ${timeStamp}`);
    const { syncSPOnly } = require('../src/sp_only_sync');
    const result = await syncSPOnly();
    wl('INFO', `done — rows changed: ${result.rowsChanged}, total: ${result.totalSec}s`);
    context.log(`✅ SP-only sync completed — ${result.rowsChanged} rows changed`);
  } catch (err) {
    wl('ERROR', `failed: ${err.stack || err.message}`);
    context.log.error('❌ SP-only sync failed:', err.stack || err.message);
  } finally {
    if (blob) await blob.flush();
  }
};