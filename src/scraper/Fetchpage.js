// // src/scraper/fetchPage.js
// // Web Unlocker REST API fetch — replaces all Playwright browser management.
// // Single responsibility: take a URL, return HTML. Retry on failure.

// const https = require('https');
// const { log } = require('../../blobLogger');

// const API_KEY = process.env.BRIGHT_DATA_API_KEY;
// const ZONE    = process.env.BRIGHT_DATA_ZONE;

// if (!API_KEY) throw new Error('Missing BRIGHT_DATA_API_KEY in .env');
// if (!ZONE)    throw new Error('Missing BRIGHT_DATA_ZONE in .env');

// /**
//  * Fetches a URL via Bright Data Web Unlocker API.
//  * Returns raw HTML string.
//  *
//  * @param {string} targetUrl  - The page to fetch
//  * @param {number} retries    - Max attempts (default 3)
//  * @returns {Promise<string>} - HTML content
//  */
// function fetchPage(targetUrl, retries = 3) {
//   const attempt = (n) => new Promise((resolve, reject) => {
//     const body = JSON.stringify({
//       url   : targetUrl,
//       zone  : ZONE,
//       format: 'raw',
//     });

//     const options = {
//       hostname: 'api.brightdata.com',
//       path    : '/request',
//       method  : 'POST',
//       headers : {
//         'Content-Type'  : 'application/json',
//         'Authorization' : `Bearer ${API_KEY}`,
//         'Content-Length': Buffer.byteLength(body),
//       },
//     };

//     const req = https.request(options, (res) => {
//       let data = '';

//       res.on('data', chunk => {
//         data += chunk;
//       });

//       res.on('end', () => {
//         if (res.statusCode === 200) {
//           console.log(`[DEBUG] ${targetUrl.substring(0, 60)} →`, data.substring(0, 300));
//           resolve(data);
//         } else {
//           log('ERROR', 'fetchPage.js', 'fetchPage', `HTTP ${res.statusCode} for ${targetUrl}: ${data.substring(0, 200)}`);
//           reject(
//             new Error(
//               `HTTP ${res.statusCode}: ${data.substring(0, 200)}`
//             )
//           );
//         }
//       });
//     });

//     req.setTimeout(120_000, () => {
//       req.destroy(new Error('Request timeout after 120s'));
//     });

//     req.on('error', reject);

//     req.write(body);
//     req.end();
//   });

//   // Retry with exponential backoff
//   const run = async (n) => {
//     try {
//       return await attempt(n);
//     } catch (err) {
//       if (n < retries) {
//         const wait = n * 4000;

//         console.log(
//           `  ⏳ Attempt ${n} failed (${err.message.substring(0, 60)}) — retrying in ${wait / 1000}s`
//         );
//         log('WARN', 'fetchPage.js', 'fetchPage', `Attempt ${n} failed for ${targetUrl} (${err.message.substring(0, 100)}) — retrying in ${wait / 1000}s`);

//         await new Promise(r => setTimeout(r, wait));

//         return run(n + 1);
//       }

//       log('ERROR', 'fetchPage.js', 'fetchPage', `All ${retries} attempts failed for ${targetUrl}: ${err.message}`);
//       throw err;
//     }
//   };

//   return run(1);
// }

// module.exports = { fetchPage };




















// src/scraper/fetchPage.js
// Web Unlocker REST API fetch — replaces all Playwright browser management.
// Single responsibility: take a URL, return HTML. Retry on failure.

const https = require('https');
const { log } = require('../../blobLogger');

const API_KEY = process.env.BRIGHT_DATA_API_KEY;
const ZONE    = process.env.BRIGHT_DATA_ZONE;

if (!API_KEY) throw new Error('Missing BRIGHT_DATA_API_KEY in .env');
if (!ZONE)    throw new Error('Missing BRIGHT_DATA_ZONE in .env');

// Absolute cap for one Bright Data request (all attempts are separate requests).
const TOTAL_TIMEOUT_MS = Number(process.env.FETCH_TOTAL_TIMEOUT_MS) || 180_000;

/**
 * Fetches a URL via Bright Data Web Unlocker API.
 * Returns raw HTML string.
 *
 * @param {string} targetUrl  - The page to fetch
 * @param {number} retries    - Max attempts (default 3)
 * @returns {Promise<string>} - HTML content
 */
function fetchPage(targetUrl, retries = 3) {
  const attempt = (n) => new Promise((resolve, reject) => {
    // Settle exactly once, and ALWAYS settle. Before this, a response that
    // started (headers received) and then stalled was destroyed by the idle
    // timeout below, but neither 'end' nor req 'error' fired — so the promise
    // never settled, the retry loop never ran, the global concurrency slot was
    // never released and the whole manual run hung forever.
    let settled = false;
    let deadline;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      fn(value);
    };

    const body = JSON.stringify({
      url   : targetUrl,
      zone  : ZONE,
      format: 'raw',
    });

    const options = {
      hostname: 'api.brightdata.com',
      path    : '/request',
      method  : 'POST',
      headers : {
        'Content-Type'  : 'application/json',
        'Authorization' : `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', chunk => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode === 200) {
          // A real listing/product page is always at least a few KB.
          // A blocked, rate-limited, or "zone concurrency exceeded"
          // response often comes back as 200 with a tiny/empty body —
          // treat it as a failure so it goes through the retry below.
          if (data.length < 500) {
            const preview = data.substring(0, 150).replace(/\s+/g, ' ');
            log('WARN', 'fetchPage.js', 'fetchPage', `Suspiciously short 200 response (${data.length} bytes) for ${targetUrl}: "${preview}"`);
            finish(reject, new Error(`Suspiciously short response (${data.length} bytes) — likely blocked/throttled, not a real page`));
            return;
          }
          finish(resolve, data);
        } else {
          log('ERROR', 'fetchPage.js', 'fetchPage', `HTTP ${res.statusCode} for ${targetUrl}: ${data.substring(0, 200)}`);
          finish(reject, new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });

      // Connection dropped / destroyed mid-response: 'end' never fires.
      res.on('error', (err) => finish(reject, err));
      res.on('close', () => {
        if (!res.complete) finish(reject, new Error('Response closed before it completed'));
      });
    });

    // Idle timeout: no bytes for 120s.
    req.setTimeout(120_000, () => {
      finish(reject, new Error('Request timeout after 120s'));
      req.destroy();
    });

    // Hard ceiling for the WHOLE request, even if bytes keep trickling in.
    deadline = setTimeout(() => {
      finish(reject, new Error(`Request exceeded ${TOTAL_TIMEOUT_MS / 1000}s total deadline`));
      req.destroy();
    }, TOTAL_TIMEOUT_MS);

    req.on('error', (err) => finish(reject, err));

    req.write(body);
    req.end();
  });

  // Retry with exponential backoff
  const run = async (n) => {
    try {
      return await attempt(n);
    } catch (err) {
      if (n < retries) {
        const wait = n * 4000;

        console.log(
          `  ⏳ Attempt ${n} failed (${err.message.substring(0, 60)}) — retrying in ${wait / 1000}s`
        );
        log('WARN', 'fetchPage.js', 'fetchPage', `Attempt ${n} failed for ${targetUrl} (${err.message.substring(0, 100)}) — retrying in ${wait / 1000}s`);

        await new Promise(r => setTimeout(r, wait));

        return run(n + 1);
      }

      log('ERROR', 'fetchPage.js', 'fetchPage', `All ${retries} attempts failed for ${targetUrl}: ${err.message}`);
      throw err;
    }
  };

  return run(1);
}

module.exports = { fetchPage };