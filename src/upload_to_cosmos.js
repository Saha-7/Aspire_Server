require('dotenv').config();
const { CosmosClient } = require('@azure/cosmos');
const fs   = require('fs');
const path = require('path');

const client    = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const database  = client.database('ScraperDB');
const container = database.container('scrap_results');

async function pushData() {
  // Find all products_full.json files across all stores and categories
  const outputDir = path.join('output');
  const stores = fs.readdirSync(outputDir);

  let totalPushed = 0;
  let totalFailed = 0;

  for (const store of stores) {
    const storePath = path.join(outputDir, store);
    if (!fs.statSync(storePath).isDirectory()) continue;

    const categories = fs.readdirSync(storePath);

    for (const category of categories) {
      const fullJsonPath = path.join(storePath, category, 'products_full.json');
      if (!fs.existsSync(fullJsonPath)) continue;

      console.log(`\n📂 Pushing: ${store}/${category}`);

      const products = JSON.parse(fs.readFileSync(fullJsonPath, 'utf8'));
      console.log(`   Found ${products.length} products`);

      for (const product of products) {
        try {
          // Cosmos needs an 'id' field — we generate one from store + url
          product.id = Buffer.from(product.url).toString('base64').substring(0, 255);

          await container.items.upsert(product);
          totalPushed++;
          process.stdout.write(`   ✅ ${totalPushed} pushed\r`);
        } catch (err) {
          console.error(`   ❌ Failed: ${product.url} — ${err.message}`);
          totalFailed++;
        }
      }
    }
  }

  console.log(`\n\n🎉 Done!`);
  console.log(`   ✅ Pushed : ${totalPushed}`);
  console.log(`   ❌ Failed : ${totalFailed}`);
}

pushData().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});