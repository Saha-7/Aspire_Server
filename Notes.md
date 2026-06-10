### Scheduler Fires
```
  → Clear stale cache files from disk
  → Scrape pages → products[] in memory (disk write is just a backup)
  → Push products[] directly to Cosmos  ← no disk read
  → Cosmos → SQL CompetitorPrices
  → Recommendation engine (separate trigger)
```





# Azure Function Deploy command (After inside the BackEnd folder):
 ```
cp -r src azure-functions/src
cp package.json azure-functions/package.json
cd azure-functions

npm install

func azure functionapp publish tpsazurefx-node --javascript   # Main Deployment

```

 ```
 Timer fires daily at 2 AM UTC

         ↓
Scheduler loads CategorySettings from SQL
         ↓
Checks NextScrapDueAt for each category
         ↓
Is it due? (current date >= NextScrapDueAt)
    YES → scrape it, set NextScrapDueAt = today + 7 days
    NO  → skip it, do nothing
```