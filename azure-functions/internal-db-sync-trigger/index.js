'use strict';

const { syncInternalProducts } = require('../src/internal_db_sync');

module.exports = async function (context, myTimer) {
  const timeStamp = new Date().toISOString();

  if (myTimer.isPastDue) {
    context.log('⚠️  Timer is past due — running InternalProducts sync anyway:', timeStamp);
  } else {
    context.log('⏰ InternalProducts sync timer triggered at:', timeStamp);
  }

  try {
    const result = await syncInternalProducts();
    context.log(`✅ InternalProducts sync completed — ${result.rowsTouched} rows touched`);
  } catch (err) {
    // Don't rethrow — Azure Functions retries on uncaught errors,
    // same reasoning as the scraper trigger.
    context.log.error('❌ InternalProducts sync failed:', err.message);
  }
};