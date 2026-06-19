// src/utils/connectWithRetry.js
const sql = require('mssql');

const DEFAULT_MAX_ATTEMPTS  = 3;
const DEFAULT_BASE_DELAY_MS = 2000;

async function connectWithRetry(config, options = {}) {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const label        = options.label || config.database || 'SQL Server';

  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const pool = new sql.ConnectionPool(config); // fresh instance every attempt — no shared global state
    try {
      await pool.connect();
      if (attempt > 1) {
        console.log(`   ✅ Connected to ${label} on attempt ${attempt}/${maxAttempts}`);
      }
      return pool;
    } catch (err) {
      lastErr = err;
      try { await pool.close(); } catch (_) {} // don't leave a half-open socket behind

      const isLastAttempt = attempt === maxAttempts;
      console.log(`   ⚠️  Connection to ${label} failed (attempt ${attempt}/${maxAttempts}): ${err.message}`);
      if (isLastAttempt) break;

      const wait = baseDelayMs * attempt; // 2s, 4s, 6s...
      console.log(`   ⏳ Retrying in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  throw lastErr;
}

module.exports = { connectWithRetry };