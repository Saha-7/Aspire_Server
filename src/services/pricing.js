// src/services/pricing.js
// ─────────────────────────────────────────────────────────────
// ONE place that turns (PP + business variables + optional lowest
// competitor price) into a Recommended SP.
//
// Used by:
//   • recommendation_engine.js  (Intelligence table, via calculateRecommendedPrice)
//   • api_server.js             (Basic table rows + the row Refresh helper)
//
// Rule (unchanged from before):
//   floor  = PP × (1 + GST + COB + margin)
//   if the lowest IN-STOCK competitor price is above the floor and
//   1% below it is still above the floor → recommend 1% below it
//   otherwise → recommend the floor.
//   Result is always rounded UP to a whole rupee.
//
// FUTURE (not built yet): payment gateway / Shopify fee (% of SP) and
// shipping (weight based) will be added HERE, and only here.
// ─────────────────────────────────────────────────────────────
'use strict';

const UNDERCUT_FACTOR = 0.99; // 1% below the lowest competitor

const round2 = (n) => parseFloat(Number(n).toFixed(2));

/**
 * @param {object} p
 * @param {number} p.pp                       effective purchase price
 * @param {{gst:number,costOfBusiness:number,profitMargin:number}} p.vars  fractions (0.18 = 18%)
 * @param {number|null} [p.lowestCompetitorPrice]  lowest in-stock competitor price, or null
 * @returns {{recommendedSP:number, baseFloor:number, pricingStrategy:'floor'|'optimized'}}
 */
function computeRecommendedSP({ pp, vars, lowestCompetitorPrice = null }) {
  const multiplier = 1 + vars.gst + vars.costOfBusiness + vars.profitMargin;
  const baseFloor  = round2(pp * multiplier);

  let target   = baseFloor;
  let strategy = 'floor';

  if (lowestCompetitorPrice != null && Number.isFinite(Number(lowestCompetitorPrice))) {
    const undercut = round2(Number(lowestCompetitorPrice) * UNDERCUT_FACTOR);
    if (undercut > baseFloor) {
      target   = undercut;
      strategy = 'optimized';
    }
  }

  return {
    recommendedSP  : Math.ceil(target),
    baseFloor,
    pricingStrategy: strategy,
  };
}

module.exports = { computeRecommendedSP, UNDERCUT_FACTOR };