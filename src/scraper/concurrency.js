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

module.exports = { createLimiter };