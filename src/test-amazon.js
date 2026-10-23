// src/test-amazon.js  (Node 18+)
require("dotenv").config();
const fs = require("fs");

const TOKEN = (process.env.BRIGHT_DATA_API_KEY || "").trim();
const ZONE = (process.env.BRIGHT_DATA_ZONE || "").trim();

const NODE = "1375419031";
const URLS = {
  search_node: `https://www.amazon.in/s?node=${NODE}&page=1`,
  search_rh: `https://www.amazon.in/s?rh=n%3A${NODE}&page=1`,
  landing_b: `https://www.amazon.in/b?node=${NODE}`,
  keyword: `https://www.amazon.in/s?k=keyboard&page=1`,
};

async function fetchPage(url) {
  const res = await fetch("https://api.brightdata.com/request", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ zone: ZONE, url, format: "raw" }),
  });
  const html = await res.text();
  return { status: res.status, html, brdError: res.headers.get("x-brd-error") };
}

function analyze(html) {
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
  const dataAsin = (html.match(/data-asin="[A-Z0-9]{10}"/g) || []).length;
  const dpLinks = new Set(
    [...html.matchAll(/\/dp\/([A-Z0-9]{10})/g)].map((m) => m[1])
  );
  const resultItems = (html.match(/s-result-item/g) || []).length;
  const prices = (html.match(/a-price-whole/g) || []).length;
  const captcha = /captcha|robot check|automated access|api-services-support/i.test(html);
  return {
    title: title.trim().slice(0, 100),
    dataAsin,
    uniqueDpAsins: dpLinks.size,
    resultItems,
    priceNodes: prices,
    captcha,
  };
}

async function main() {
  if (!TOKEN || !ZONE) {
    console.log("Missing BRIGHT_DATA_API_KEY or BRIGHT_DATA_ZONE in .env");
    return;
  }

  for (const [name, url] of Object.entries(URLS)) {
    console.log(`\n=== ${name} ===\n${url}`);
    try {
      const { status, html, brdError } = await fetchPage(url);
      console.log("status:", status, "| length:", html.length, "| x-brd-error:", brdError);
      console.log(analyze(html));
      fs.writeFileSync(`amazon-${name}.html`, html);
    } catch (e) {
      console.log("failed:", e.message);
    }
  }
}

main().catch(console.error);