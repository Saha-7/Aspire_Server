// src/services/shopifyService.js
const axios = require('axios');
const { log } = require('../../blobLogger');

const SHOPIFY_STORE_URL     = process.env.shopify_store_url;
const SHOPIFY_GRAPHQL_URL   = process.env.Shopify_graph_URL;
const SHOPIFY_CLIENT_ID     = process.env.shopify_prod_clientid;
const SHOPIFY_CLIENT_SECRET = process.env.shopify_prod_secret;

// ── Access token (client-credentials) ─────────────────────────
// One app-level token is shared by every request on this server (it has nothing
// to do with which user is logged in). Shopify issues it for ~24 hours
// (`expires_in`). It is kept in memory and renewed lazily: the first request that
// arrives inside the last 5 minutes before expiry (or after expiry) fetches a new
// one. Concurrent requests share a single token call.
const TOKEN_REFRESH_BEFORE_MS = 5 * 60 * 1000;
const DEFAULT_TOKEN_TTL_SEC   = 24 * 60 * 60;

let cachedToken    = null;
let tokenFetchedAt = 0;
let tokenExpiresAt = 0;     // ms since epoch
let tokenPromise   = null;  // in-flight token request, shared by concurrent callers

async function getAccessToken(forceRefresh = false) {
  const margin = Math.min(TOKEN_REFRESH_BEFORE_MS, Math.max(0, (tokenExpiresAt - tokenFetchedAt) * 0.1));
  if (!forceRefresh && cachedToken && Date.now() < tokenExpiresAt - margin) {
    return cachedToken;
  }
  if (tokenPromise) return tokenPromise;

  tokenPromise = (async () => {
    try {
      const params = new URLSearchParams({
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        grant_type: 'client_credentials',
      });

      const response = await axios.post(
        `https://${SHOPIFY_STORE_URL}/admin/oauth/access_token`,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const ttlSec   = Number(response.data.expires_in) || DEFAULT_TOKEN_TTL_SEC;
      cachedToken    = response.data.access_token;
      tokenFetchedAt = Date.now();
      tokenExpiresAt = tokenFetchedAt + ttlSec * 1000;
      log('INFO', 'shopifyService.js', 'getAccessToken',
        `Shopify access token refreshed (valid ~${Math.round(ttlSec / 3600)}h, scopes: ${response.data.scope || 'n/a'})`);
      return cachedToken;
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      log('ERROR', 'shopifyService.js', 'getAccessToken', `Token exchange failed: ${detail}`);
      throw new Error(`Token exchange failed: ${detail}`);
    } finally {
      tokenPromise = null;
    }
  })();
  return tokenPromise;
}

// ── Generic GraphQL call helper ───────────────────────────────
// Retries ONCE with a brand-new token when Shopify answers 401, or ACCESS_DENIED
// on a token older than a minute (e.g. the app was just granted new scopes, or the
// secret was rotated - a cached token would otherwise keep failing until it expires).
async function shopifyGraphQL(query, variables, url = SHOPIFY_GRAPHQL_URL, _retried = false) {
  const accessToken = await getAccessToken();
  try {
    const response = await axios.post(
      url,
      { query, variables },
      { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken } }
    );
    if (response.data.errors) {
      const denied = response.data.errors.some(e => e.extensions?.code === 'ACCESS_DENIED');
      if (denied && !_retried && Date.now() - tokenFetchedAt > 60_000) {
        await getAccessToken(true);
        return shopifyGraphQL(query, variables, url, true);
      }
      log('ERROR', 'shopifyService.js', 'shopifyGraphQL', `GraphQL error: ${JSON.stringify(response.data.errors)}`);
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(response.data.errors)}`);
    }
    return response.data.data;
  } catch (err) {
    if (err.response?.status === 401 && !_retried) {
      await getAccessToken(true);
      return shopifyGraphQL(query, variables, url, true);
    }
    if (err.response?.data) {
      log('ERROR', 'shopifyService.js', 'shopifyGraphQL', `Request failed: ${JSON.stringify(err.response.data)}`);
      throw new Error(`Shopify request failed: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

// ── Step 1: look up variant + product ID by SKU (with duplicate-safety) ──
async function getShopifyVariantBySku(sku) {
  const query = `
    query getVariantBySku($query: String!) {
      productVariants(first: 5, query: $query) {
        edges { node { id price sku product { id } } }
      }
    }
  `;
  const data = await shopifyGraphQL(query, { query: `sku:${sku}` });
  const matches = data.productVariants.edges.filter(e => e.node.sku === sku);

  if (matches.length === 0) {
    log('ERROR', 'shopifyService.js', 'getShopifyVariantBySku', `No Shopify variant found for SKU: ${sku}`);
    throw new Error(`No Shopify variant found for SKU: ${sku}`);
  }
  if (matches.length > 1) {
    log('ERROR', 'shopifyService.js', 'getShopifyVariantBySku', `Ambiguous SKU: ${sku} matched ${matches.length} variants`);
    throw new Error(`Ambiguous SKU: ${sku} matched ${matches.length} variants — refusing to guess`);
  }

  const node = matches[0].node;
  return { variantId: node.id, productId: node.product.id };
}

// ── Step 2: update the price ──────────────────────────────────
async function updateVariantPrice(productId, variantId, price) {
  const mutation = `
    mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price }
        userErrors { field message }
      }
    }
  `;
  const data = await shopifyGraphQL(mutation, {
    productId,
    variants: [{ id: variantId, price: String(price) }],
  });
  const errors = data.productVariantsBulkUpdate.userErrors;
  if (errors?.length) {
    log('ERROR', 'shopifyService.js', 'updateVariantPrice', `userErrors: ${JSON.stringify(errors)}`);
    throw new Error(`Shopify userErrors: ${JSON.stringify(errors)}`);
  }
  return data.productVariantsBulkUpdate.productVariants[0];
}

async function pushPriceToShopify(skuId, price) {
  const { variantId, productId } = await getShopifyVariantBySku(skuId);
  const updated = await updateVariantPrice(productId, variantId, price);
  log('INFO', 'shopifyService.js', 'pushPriceToShopify', `Pushed price ${updated.price} for SKU: ${skuId}`);
  return { variantId, productId, price: updated.price };
}

// ═════════════════════════════════════════════════════════════
// INVENTORY (per-location stock)
// Uses its own pinned API version: inventorySetQuantities does not exist in
// old API versions, and the price code above keeps using Shopify_graph_URL
// untouched. Override with the shopify_inventory_api_version app setting.
// ═════════════════════════════════════════════════════════════
const INVENTORY_API_VERSION = process.env.shopify_inventory_api_version || '2026-07';
const INVENTORY_GRAPHQL_URL = `https://${SHOPIFY_STORE_URL}/admin/api/${INVENTORY_API_VERSION}/graphql.json`;
// Newer API versions require an idempotency key on inventory mutations.
const INVENTORY_NEEDS_IDEMPOTENCY = INVENTORY_API_VERSION >= '2026-04';

const LIVE_READ_BATCH_ITEMS = 20; // keeps each query well under Shopify's 1000-point query cost cap
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// GraphQL call against the inventory-versioned endpoint, retrying on throttling.
async function inventoryGraphQL(query, variables, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await shopifyGraphQL(query, variables, INVENTORY_GRAPHQL_URL);
    } catch (err) {
      const throttled = /THROTTLED|throttled|Too Many Requests|429/.test(err.message);
      if (!throttled || i >= attempts) throw err;
      await sleep(1500 * i);
    }
  }
}

// Live "available" quantity per active location for each inventory item.
// Returns Map<itemId, Array<{ locationId, qty }>>. An item that Shopify returned
// has an entry (empty array = inactive at every location); an item that is
// missing from the map was not returned at all.
async function fetchLiveInventoryLevels(itemIds) {
  const query = `
    query liveStock($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on InventoryItem {
          id
          inventoryLevels(first: 12) {
            edges { node { location { id } quantities(names: ["available"]) { name quantity } } }
          }
        }
      }
    }
  `;
  const result = new Map();
  for (let i = 0; i < itemIds.length; i += LIVE_READ_BATCH_ITEMS) {
    const ids  = itemIds.slice(i, i + LIVE_READ_BATCH_ITEMS);
    const data = await inventoryGraphQL(query, { ids });
    for (const node of data.nodes || []) {
      if (!node?.id) continue;
      const levels = [];
      for (const edge of node.inventoryLevels?.edges || []) {
        const lvl   = edge.node;
        const avail = lvl.quantities?.find(q => q.name === 'available');
        if (lvl.location?.id && avail) levels.push({ locationId: lvl.location.id, qty: avail.quantity });
      }
      result.set(node.id, levels);
    }
  }
  return result;
}

// Active Shopify locations: [{ id, name }]. Needs the read_locations scope.
async function fetchShopifyLocations() {
  const data = await inventoryGraphQL(`query { locations(first: 50) { nodes { id name isActive } } }`, {});
  return data.locations.nodes.filter(l => l.isActive).map(l => ({ id: l.id, name: l.name }));
}

// Set absolute "available" quantities. quantities: [{ inventoryItemId, locationId, quantity }]
// Throws if Shopify returns userErrors (the whole batch is rejected in that case).
async function setInventoryQuantities(quantities, sessionId) {
  const mutation = INVENTORY_NEEDS_IDEMPOTENCY
    ? `mutation setQty($input: InventorySetQuantitiesInput!, $key: String!) @idempotent(key: $key) {
         inventorySetQuantities(input: $input) { userErrors { field message code } }
       }`
    : `mutation setQty($input: InventorySetQuantitiesInput!) {
         inventorySetQuantities(input: $input) { userErrors { field message code } }
       }`;
  const variables = {
    input: {
      name: 'available',
      reason: 'correction',
      ignoreCompareQuantity: true,
      referenceDocumentUri: `gid://aspire/BulkStockUpload/${sessionId}`,
      quantities,
    },
  };
  if (INVENTORY_NEEDS_IDEMPOTENCY) variables.key = require('crypto').randomUUID();

  const data   = await inventoryGraphQL(mutation, variables);
  const errors = data.inventorySetQuantities.userErrors;
  if (errors?.length) {
    const msg = errors.map(e => e.message).join('; ');
    log('ERROR', 'shopifyService.js', 'setInventoryQuantities', `userErrors: ${JSON.stringify(errors)}`);
    throw new Error(msg);
  }
}

// Diagnostic: which API version / scopes does the app actually have?
async function checkShopifyAccess() {
  const out = { apiVersion: INVENTORY_API_VERSION, scopes: [], tokenOk: false, locations: [], notes: [] };
  try {
    const data = await inventoryGraphQL(`query { currentAppInstallation { accessScopes { handle } } }`, {});
    out.tokenOk = true;
    out.scopes  = (data.currentAppInstallation?.accessScopes || []).map(x => x.handle).sort();
  } catch (err) {
    out.notes.push(`Could not read app scopes: ${err.message}`);
    return out;
  }
  try {
    const data = await inventoryGraphQL(`query { locations(first: 50) { nodes { id name isActive } } }`, {});
    out.locations = data.locations.nodes;
  } catch (err) {
    out.notes.push(`Could not list locations (needs read_locations): ${err.message}`);
  }
  out.canSetQuantity      = out.scopes.includes('write_inventory');
  out.canReadLocations    = out.scopes.includes('read_locations') || out.locations.length > 0;
  return out;
}

module.exports = {
  pushPriceToShopify, fetchLiveInventoryLevels, fetchShopifyLocations, setInventoryQuantities,
  checkShopifyAccess,
};































// src/services/shopifyService.js
// const axios = require('axios');

// const SHOPIFY_STORE_URL     = process.env.shopify_store_url;      // e.g. tpstech.myshopify.com — used for OAuth token exchange
// const SHOPIFY_GRAPHQL_URL   = process.env.Shopify_graph_URL;      // full graphql.json endpoint
// const SHOPIFY_CLIENT_ID     = process.env.shopify_prod_clientid;
// const SHOPIFY_CLIENT_SECRET = process.env.shopify_prod_secret;

// const TOKEN_MAX_AGE_MS = 20 * 60 * 60 * 1000; // hard refresh every 20h regardless of Shopify's expires_in (UTC vs IST safety)

// let cachedToken = null;
// let tokenFetchedAt = 0;

// // ── Get (or refresh) the OAuth access token ───────────────────
// async function getAccessToken() {
//   if (cachedToken && (Date.now() - tokenFetchedAt) < TOKEN_MAX_AGE_MS) {
//     return cachedToken;
//   }

//   try {
//     const params = new URLSearchParams({
//       client_id: SHOPIFY_CLIENT_ID,
//       client_secret: SHOPIFY_CLIENT_SECRET,
//       grant_type: 'client_credentials',
//     });

//     const response = await axios.post(
//       `https://${SHOPIFY_STORE_URL}/admin/oauth/access_token`,
//       params.toString(),
//       { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
//     );
//     cachedToken = response.data.access_token;
//     tokenFetchedAt = Date.now();
//     return cachedToken;
//   } catch (err) {
//     const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
//     throw new Error(`Token exchange failed: ${detail}`);
//   }
// }

// // ── Generic GraphQL call helper ───────────────────────────────
// async function shopifyGraphQL(query, variables) {
//   const accessToken = await getAccessToken();
//   try {
//     const response = await axios.post(
//       SHOPIFY_GRAPHQL_URL,
//       { query, variables },
//       { headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken } }
//     );
//     if (response.data.errors) {
//       throw new Error(`Shopify GraphQL error: ${JSON.stringify(response.data.errors)}`);
//     }
//     return response.data.data;
//   } catch (err) {
//     if (err.response?.data) {
//       throw new Error(`Shopify request failed: ${JSON.stringify(err.response.data)}`);
//     }
//     throw err;
//   }
// }

// // ── Step 1: look up variant + product ID by SKU (with duplicate-safety) ──
// async function getShopifyVariantBySku(sku) {
//   const query = `
//     query getVariantBySku($query: String!) {
//       productVariants(first: 5, query: $query) {
//         edges { node { id price sku product { id } } }
//       }
//     }
//   `;
//   const data = await shopifyGraphQL(query, { query: `sku:${sku}` });
//   const matches = data.productVariants.edges.filter(e => e.node.sku === sku); // exact match only

//   if (matches.length === 0) throw new Error(`No Shopify variant found for SKU: ${sku}`);
//   if (matches.length > 1) throw new Error(`Ambiguous SKU: ${sku} matched ${matches.length} variants — refusing to guess`);

//   const node = matches[0].node;
//   return { variantId: node.id, productId: node.product.id };
// }

// // ── Step 2: update the price ──────────────────────────────────
// async function updateVariantPrice(productId, variantId, price) {
//   const mutation = `
//     mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
//       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
//         productVariants { id price }
//         userErrors { field message }
//       }
//     }
//   `;
//   const data = await shopifyGraphQL(mutation, {
//     productId,
//     variants: [{ id: variantId, price: String(price) }],
//   });
//   const errors = data.productVariantsBulkUpdate.userErrors;
//   if (errors?.length) throw new Error(`Shopify userErrors: ${JSON.stringify(errors)}`);
//   return data.productVariantsBulkUpdate.productVariants[0];
// }

// async function pushPriceToShopify(skuId, price) {
//   const { variantId, productId } = await getShopifyVariantBySku(skuId);
//   const updated = await updateVariantPrice(productId, variantId, price);
//   return { variantId, productId, price: updated.price };
// }

// module.exports = { pushPriceToShopify };















/*

Did we already do the "2 API calls" thing?
Yes — you already built exactly what Krishna described. Look at the code from before:

Call 1 = getShopifyVariantBySku(sku) — looks up the product by SKU, gets back the variantId + productId.
Call 2 = updateVariantPrice(productId, variantId, price) — the actual productVariantsBulkUpdate mutation that changes the price.

That matches his "first API retrieves product details via SKU, second API updates the price" description exactly.
The variance check is a different thing entirely — that's not a Shopify API call at all. It's your own SQL check (comparing the entered price against RecommendedSP in your own database) that happens before you even talk to Shopify.
"2 API calls" comment was purely about the Shopify integration; the variance check is a safety feature you added on your side, unrelated to that count.
So you're not missing a call — you just have three separate steps total: 
  (1) variance check against your DB, 
  (2) SKU lookup on Shopify, 
  (3) price mutation on Shopify.

*/