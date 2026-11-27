// src/services/pricing.js
// ─────────────────────────────────────────────────────────────
// ONE place that turns (PP + business variables + global costs +
// optional lowest competitor price + optional weight) into a Recommended SP.
//
// Used by:
//   • recommendation_engine.js  (Intelligence table, via calculateRecommendedPrice)
//   • api_server.js             (Basic table rows, row Refresh, Take-Action modal,
//                                Intelligence list "extra profit %")
//
// FORMULA (plain words)
//   1. cost side  = PP × (1 + GST + COB + margin)          ← per category / brand
//   2. add flat costs: packing + shipping                   ← global
//   3. Shopify fee % and payment-gateway % are charged on the SELLING price,
//      so the price must be big enough that after those % are taken off,
//      steps 1 + 2 are still covered:
//          floor = (step 1 + step 2) ÷ (1 − shopifyFee% − gateway%)
//   4. If the lowest IN-STOCK competitor price is above the floor and
//      1% below it is still above the floor → recommend 1% below it,
//      otherwise recommend the floor.
//   5. Result is always rounded UP to a whole rupee.
//
// SHIPPING
//   shipping = weight (kg) × rate per kg, but never below the minimum charge.
//   No weight data yet → shipping is NOT added (null) and the tooltip says so.
//   When the weight view arrives, only getProductWeightKg() below (and the
//   SQL that loads products) needs to change — the formula already handles it.
//
// Global values live in AppSettings (editable from Settings → Global costs).
// They are loaded by businessVariablesService.loadPricingGlobals().
// ─────────────────────────────────────────────────────────────
'use strict';

const UNDERCUT_FACTOR = 0.99; // 1% below the lowest competitor

// Fallbacks used when an AppSettings row is missing or invalid.
// Percent values are whole percents (1 = 1%).
const DEFAULT_GLOBALS = Object.freeze({
  shopifyFeePct     : 1,    // % of selling price
  paymentGatewayPct : 2,    // % of selling price
  packingCost       : 20,   // ₹ per product
  shippingRatePerKg : 100,  // ₹ per kg
  shippingMinCost   : 40,   // ₹ — shipping is never below this
});

const round2 = (n) => parseFloat(Number(n).toFixed(2));

/**
 * Weight of a product in kg, or null when unknown.
 * EXTENSION POINT: once the senior's weight view is joined into the product
 * query, expose it as `product.WeightKg` (or change this one line).
 */
function getProductWeightKg(product) {
  const w = Number(product?.WeightKg);
  return Number.isFinite(w) && w > 0 ? w : null;
}

/**
 * Shipping ₹ for a weight, or null when the weight is unknown.
 * 0.73 kg → ₹73 (no rounding of weight); anything under the minimum → minimum.
 */
function computeShippingCost(weightKg, g) {
  if (weightKg == null) return null;
  return round2(Math.max(g.shippingMinCost, weightKg * g.shippingRatePerKg));
}

/**
 * The floor price (lowest price that still covers every cost + margin).
 * @param {object} p
 * @param {number} p.pp
 * @param {{gst:number,costOfBusiness:number,profitMargin:number,globals?:object}} p.vars  fractions (0.18 = 18%), globals in whole %/₹
 * @param {number|null} [p.weightKg]
 * @returns {{baseFloor:number, breakdown:object}}
 */
function computeFloor({ pp, vars, weightKg = null }) {
  const g = { ...DEFAULT_GLOBALS, ...(vars.globals || {}) };

  const feeFraction = (g.shopifyFeePct + g.paymentGatewayPct) / 100;
  if (!(feeFraction >= 0 && feeFraction < 1)) {
    throw new Error(`Invalid fee percentages: Shopify ${g.shopifyFeePct}% + gateway ${g.paymentGatewayPct}% must be below 100%`);
  }

  const shippingCost = computeShippingCost(weightKg, g);

  const costSide = pp * (1 + vars.gst + vars.costOfBusiness + vars.profitMargin);
  const baseFloor = round2((costSide + g.packingCost + (shippingCost ?? 0)) / (1 - feeFraction));

  return {
    baseFloor,
    breakdown: {
      gstPct           : round2(vars.gst * 100),
      cobPct           : round2(vars.costOfBusiness * 100),
      marginPct        : round2(vars.profitMargin * 100),
      shopifyFeePct    : g.shopifyFeePct,
      paymentGatewayPct: g.paymentGatewayPct,
      packingCost      : g.packingCost,
      shippingCost,                       // null = no weight data yet
      weightKg         : weightKg ?? null,
    },
  };
}

/**
 * @param {object} p
 * @param {number} p.pp                       effective purchase price
 * @param {{gst:number,costOfBusiness:number,profitMargin:number,globals?:object}} p.vars
 * @param {number|null} [p.lowestCompetitorPrice]  lowest in-stock competitor price, or null
 * @param {number|null} [p.weightKg]          product weight in kg, or null
 * @returns {{recommendedSP:number, baseFloor:number, pricingStrategy:'floor'|'optimized', breakdown:object}}
 */
function computeRecommendedSP({ pp, vars, lowestCompetitorPrice = null, weightKg = null }) {
  const { baseFloor, breakdown } = computeFloor({ pp, vars, weightKg });

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
    breakdown,
  };
}

module.exports = {
  computeRecommendedSP,
  computeFloor,
  computeShippingCost,
  getProductWeightKg,
  DEFAULT_GLOBALS,
  UNDERCUT_FACTOR,
};