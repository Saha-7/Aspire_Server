'use strict';


const { syncSPOnly } = require('../src/sp_only_sync');

module.exports = async function (context, myTimer) {
  const timeStamp = new Date().toISOString();
  console.log("Function Running");
  context.log('⏰ SP-only sync timer triggered at:', timeStamp);
  try {
    const result = await syncSPOnly();
    context.log(`✅ SP-only sync completed — ${result.rowsChanged} rows changed`);
  } catch (err) {
    context.log.error('❌ SP-only sync failed:', err.message);
  }
};