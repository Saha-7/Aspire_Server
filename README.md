## Deploying Azure Functions

**Prerequisites:** Azure Functions Core Tools installed, logged into the correct Azure account/subscription.

**Deploy steps (run from `aspire_backend/azure-functions`):**
```powershell
cd azure-functions
npm install
func azure functionapp publish tpsazurefx-node --javascript
```

**After deploy, verify:**
- Upload size should be ~21MB (not 40MB+ — if it's larger, check for a stray nested `azure-functions/azure-functions` folder before deploying)
- Terminal output should list both functions after `Functions in tpsazurefx-node:`:
  - `internal-db-sync-trigger - [timerTrigger]`
  - `scheduler-trigger - [timerTrigger]`
- Confirm in Azure Portal → Function App → Functions blade that both show as Enabled

**Note on `src/`:** `azure-functions/src` is a manual copy of the root `src` folder, kept only for what `internal-db-sync-trigger` and `scheduler-trigger` actually import. If you change anything those two functions depend on (currently just `internal_db_sync.js` and its dependencies), re-copy `src` into `azure-functions/src` before redeploying. Unrelated changes elsewhere in root `src` don't require redeploying this.

**Known issue:** Disabling `scheduler-trigger` via the Azure Portal "Disable" button fails — functions with hyphens in their name can't have their `AzureWebJobs.<name>.Disabled` app setting set through the portal (Azure platform bug). Use Azure CLI instead, or rename the function to use an underscore if disabling is ever needed.



---


| Column | What it tracks |
|---|---|
| `ManualPP_UpdatedAt` / `ManualPP_UpdatedBy` | Last manual edit to **PP** (bill price) — from the older Bulk PP Update feature, unrelated to Shopify pushes |
| `ManualRecommendedSP` | The overridden SP value someone typed via **Modify & Push** |
| `ManualRecommendedSP_UpdatedAt` / `_UpdatedBy` | When/who made that override |
| `ShopifyPushedSP` | The **last price value actually sent to Shopify successfully** (could be the system's `RecommendedSP` or the manual override — whichever was pushed) |
| `ShopifyPushedAt` / `ShopifyPushedBy` | When/who triggered that last successful push |
| `ShopifyPushStatus` | `success` or `failed` for the most recent push attempt |







---

#### Competitor Based Recommendation should show only products when SkU matches with scrape data + in Compete store product is not out of stock + In our store that matched product should have PP available + also active +also have to be inStock. For the Basic Recommendations table eligibility  product PP have to be there+ isInStock+ isActive for our internal products only.  Now tell me do i needs to have a separate table for basic recommendation or any extra column Because It shouldn't overlap any product which is eligible for Competitor Based Recommendation table that should never came into inside Basic Recommendations table.  Competitor Based Recommendation table have the higher priority here.

- Since Basic Recommendations now never touches a SKU that the competitor engine owns, the two writers can no longer collide on the same RecommendedSP value for the same SKU. Competitor Based keeps its column value intact (only recommendation_engine.js writes it), and Basic Recommendations only ever writes for the SKUs that are exclusively its own. No new column needed — the exclusion query does the whole job.








---


### Verifying Recommendation Engine Matches via SSMS

#### Purpose

`recommendation_engine.js` decides which internal SKUs get a recommended
selling price by matching them against scraped competitor prices in SQL.
This query is a standalone SQL equivalent of that matching logic, so
anyone with SSMS access can verify the count independently of the app.

Use this whenever the "Total Products" count on the Price Intelligence
dashboard looks off, or after a fresh scrape/sync run.

## The matching rules (mirrors `recommendation_engine.js` exactly)

| Rule | Detail |
|---|---|
| Internal product eligibility | `PP IS NOT NULL AND isActive = 1 AND isInStock = 1` |
| Competitor row eligibility | `CompetitorPrice IS NOT NULL`, and `StockStatus` must not equal `'out of stock'` (case-insensitive, trimmed) |
| NULL stock status | Treated as **not in stock** — excluded |
| Match key | `TRIM(UPPER(InternalProducts.SKU_ID))` = `TRIM(UPPER(CompetitorPrices.SKU))` |
| Category | **Not part of the match.** The engine only ever joins on SKU — `CompetitorPrices.Category` has no effect on matching, even if it's wrong for a given row (see Known Issues below). |
| Multiple stores match one SKU | The **lowest** in-stock competitor price wins |

#### Verification query

Run as a single statement:

```sql
;WITH EligibleInternal AS (
    SELECT SKU_ID, Category, PP,
           UPPER(LTRIM(RTRIM(SKU_ID))) AS MatchKey
    FROM InternalProducts
    WHERE PP IS NOT NULL
      AND isActive = 1
      AND isInStock = 1
),
InStockCompetitor AS (
    SELECT
        UPPER(LTRIM(RTRIM(SKU))) AS MatchKey,
        SKU, StoreName, CompetitorPrice, StockStatus
    FROM CompetitorPrices
    WHERE CompetitorPrice IS NOT NULL
      AND ISNULL(LTRIM(RTRIM(LOWER(StockStatus))), '') <> 'out of stock'
),
BestMatch AS (
    SELECT
        ei.SKU_ID, ei.Category, ei.PP,
        c.StoreName, c.CompetitorPrice,
        ROW_NUMBER() OVER (
            PARTITION BY ei.SKU_ID
            ORDER BY c.CompetitorPrice ASC
        ) AS rn
    FROM EligibleInternal ei
    INNER JOIN InStockCompetitor c ON c.MatchKey = ei.MatchKey
)
SELECT COUNT(*) AS MatchedSkuCount FROM BestMatch WHERE rn = 1;
```

`MatchedSkuCount` should equal the "Total Products" count shown on the
dashboard with the Basic Recommendations toggle **off**. If it doesn't,
something has diverged between this query and the live app data —
worth investigating before trusting either number.

> **Note:** a `WITH` block only applies to the one `SELECT` immediately
> after it. To drill into per-category breakdowns or list unmatched
> SKUs, re-paste the full `WITH ... AS (...)` block above each new
> query, or ask for the extended version with temp tables.

## Known issue: `CompetitorPrices.Category` can be wrong

Some scraped rows carry an incorrect `Category` (e.g. a monitor scraped
from `vishal` tagged `'Processor'`). This does **not** affect
recommendation matching (matching is SKU-only, see table above), but it
does affect anything that filters or displays `CompetitorPrices` by
category — e.g. the Scrape Stats "TPS Categories" column. Root cause is
in the store's category derivation (parser config / `CategoryMappings`),
tracked separately from the matching logic documented here.



---