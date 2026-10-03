// src/routes/syncRoutes.js
'use strict';

const express = require('express');
const { syncInternalProducts } = require('../internal_db_sync');
const { syncSPOnly } = require('../sp_only_sync');

const router = express.Router();

// In-memory job state. Fine for a single App Service instance.
// If you ever scale out to multiple instances, replace this with a SQL
// applock (sp_getapplock) so two instances can't run a sync at once.
const state = {
  running: false,
  job: null,
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
};

function runJob(name, fn) {
  if (state.running) return false;

  Object.assign(state, {
    running: true,
    job: name,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null,
  });

  // Fire and forget: the HTTP request returns right away, the UI polls /status
  Promise.resolve()
    .then(fn)
    .then((r) => { state.result = r ?? null; })
    .catch((e) => {
      state.error = e.message;
      console.error(`❌ ${name} failed:`, e);
    })
    .finally(() => {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    });

  return true;
}

// ── TODO: use the same auth middleware your other routes use ──
// const { requireAuth } = require('../auth/...');
// router.use(requireAuth);

router.post('/internal', (req, res) => {
  const started = runJob('internal-products-sync', syncInternalProducts);
  res.status(started ? 202 : 409).json({ started, status: state });
});

router.post('/sp-only', (req, res) => {
  const started = runJob('sp-only-sync', syncSPOnly);
  res.status(started ? 202 : 409).json({ started, status: state });
});

// Both, in order: full sync first, then SP-only
router.post('/all', (req, res) => {
  const started = runJob('full-sync', async () => {
    const internal = await syncInternalProducts();
    const sp = await syncSPOnly();
    return { internal, sp };
  });
  res.status(started ? 202 : 409).json({ started, status: state });
});

router.get('/status', (req, res) => res.json(state));

// Reusable from the scraper/scheduler (see section 3)
async function runPostScrapeSync() {
  await syncInternalProducts();
  await syncSPOnly();
}

module.exports = router;
module.exports.runPostScrapeSync = runPostScrapeSync;