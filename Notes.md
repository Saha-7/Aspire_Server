Scheduler fires
  → Clear stale cache files from disk
  → Scrape pages → products[] in memory (disk write is just a backup)
  → Push products[] directly to Cosmos  ← no disk read
  → Cosmos → SQL CompetitorPrices
  → Recommendation engine (separate trigger)