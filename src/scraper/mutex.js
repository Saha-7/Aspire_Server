// src/scraper/mutex.js
//
// Minimal async mutex. Serializes the disk-write section of
// scrapeAndSave() — appendProduct() does read-file -> modify -> write-file,
// which loses data if two products finish around the same time and both
// read the file before either writes back. The network fetch still runs
// concurrently; only the file write itself is queued.

function createMutex() {
  let chain = Promise.resolve();

  return function runExclusive(fn) {
    const result = chain.then(fn, fn); // run fn even after a prior failure
    chain = result.catch(() => {});    // never let one rejection break the queue
    return result;
  };
}

module.exports = { createMutex };