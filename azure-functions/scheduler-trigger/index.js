'use strict';
 
require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
 
const { runScheduler } = require('../../src/scheduler/index');
 
module.exports = async function (context, myTimer) {
  const timeStamp = new Date().toISOString();
 
  if (myTimer.isPastDue) {
    context.log('⚠️  Timer is past due — running scheduler anyway:', timeStamp);
  } else {
    context.log('⏰ Timer triggered at:', timeStamp);
  }
 
  try {
    await runScheduler();
    context.log('✅ Scheduler completed successfully');
  } catch (err) {
    // Log the error but do NOT rethrow — Azure Functions retries on
    // uncaught errors which would cause the scraper to run again
    // immediately and burn Bright Data API credits unnecessarily.
    context.log.error('❌ Scheduler failed:', err.message);
  }
};