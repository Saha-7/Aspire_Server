// src/scraper/concurrency.js
//
// Minimal concurrency limiter — no external dependency needed.
// Caps how many Bright Data requests are in flight at once, instead
// of the old one-at-a-time-with-a-sleep approach.
//
// Usage:
//   const limit = createLimiter(8);
//   await Promise.all(urls.map(url => limit(() => fetchPage(url))));

function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();

    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        runNext();
      });
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

// CHANGE (multi-user scraping): concurrency must be capped GLOBALLY across
// the whole Node process, not per manual-scraper invocation. Bright Data's
// zone concurrency cap is shared — if two people each get their own
// createLimiter(5), the real simultaneous load on the zone is 10, which
// exceeds the cap and Bright Data starts returning HTTP 200 with tiny/empty
// bodies (see fetchPage.js). That gets treated as "0 products found" and,
// upstream, silently marks the run 'done' and locks the category.
// getGlobalScrapeLimiter() returns ONE limiter shared by every concurrent
// job (manual or scheduled) in this process, so SCRAPE_CONCURRENCY really
// is the total cap, no matter how many people click "Run Scraper" at once.
let globalLimiter = null;
function getGlobalScrapeLimiter(concurrency) {
  if (!globalLimiter) {
    globalLimiter = createLimiter(concurrency);
  }
  return globalLimiter;
}

module.exports = { createLimiter, getGlobalScrapeLimiter };