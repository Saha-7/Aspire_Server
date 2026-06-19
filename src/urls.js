// ─────────────────────────────────────────────────────────────
//  urls.js  —  Master store + category config
//
//  To add a new store:
//    1. Add a new entry to STORES array below
//    2. Create src/parsers/<storename>.js with 3 exports:
//         parseProductLinks(html)            → string[]
//         getNextPageUrl(html, currentUrl)   → string | null
//         parseProductDetails(html, url)     → object
//    3. No freeScrapable flag needed — Web Unlocker handles everything
// ─────────────────────────────────────────────────────────────

const STORES = [
  // {
  //   name: "primeabgb",
  //   parser: require("./parsers/primeabgb"),
  //   categories: [
  //     { slug: "cpu-processor", url: "https://www.primeabgb.com/buy-online-price-india/cpu-processor/"},
  //     { slug: "ram-memory", url: "https://www.primeabgb.com/buy-online-price-india/ram-memory/"},
  //     { slug: 'motherboards',  url: 'https://www.primeabgb.com/buy-online-price-india/motherboards/' },
  //     { slug: 'graphic-cards', url: 'https://www.primeabgb.com/buy-online-price-india/graphic-cards-gpu/' },
  //     { slug: 'monitors', url: 'https://www.primeabgb.com/buy-online-price-india/led-monitors/'},
  //     { slug: 'hdd', url: 'https://www.primeabgb.com/buy-online-price-india/internal-hard-drive/' },
  //     { slug: 'ssd', url: 'https://www.primeabgb.com/buy-online-price-india/ssd/' },
  //     { slug: 'smps', url: 'https://www.primeabgb.com/buy-online-price-india/power-supplies-smps/'},
  //     { slug: 'gaming-routers', url: 'https://www.primeabgb.com/buy-online-price-india/gaming-wireless-routers/'},
  //     { slug: 'gaming-headset', url: 'https://www.primeabgb.com/buy-online-price-india/gaming-headset/'},

  //     { slug: 'cpu-cooler', url: 'https://www.primeabgb.com/buy-online-price-india/cpu-cooler/'},
  //     { slug: 'pc-case-cabinets', url: 'https://www.primeabgb.com/buy-online-price-india/pc-cases-cabinet/'},
  //     { slug: 'nas', url: 'https://www.primeabgb.com/buy-online-price-india/network-attached-storage-nas/'},
      
  //   ],
  // },

  // {
  //   name: "mdcomputers",
  //   parser: require("./parsers/mdcomputers"),
  //   categories: [
  //     { slug: "cpu-processor",   url: "https://mdcomputers.in/catalog/processor"},
  //     { slug: "ram-memory",      url: "https://mdcomputers.in/catalog/ram" },
  //     { slug: "graphic-cards",   url: "https://mdcomputers.in/catalog/graphics-card"},
  //     { slug: 'monitors',        url: 'https://mdcomputers.in/catalog/monitor'},
  //     { slug: 'external-hdd',    url: 'https://mdcomputers.in/catalog/storage/hard-drive/external-hdd'},
  //     { slug: 'internal-hdd',    url: 'https://mdcomputers.in/catalog/storage/hard-drive/internal-hdd'},
  //     { slug: 'ssd-sata',        url: 'https://mdcomputers.in/catalog/storage/ssd-drive/sata-ssd' },
  //     { slug: 'ssd-gen3',        url: 'https://mdcomputers.in/catalog/storage/ssd-drive/gen3-ssd' },
  //     { slug: 'ssd-gen4',        url: 'https://mdcomputers.in/catalog/storage/ssd-drive/gen4-ssd' },
  //     { slug: 'ssd-gen5',        url: 'https://mdcomputers.in/catalog/storage/ssd-drive/gen5-ssd' },
  //     { slug: 'external-ssd',    url: 'https://mdcomputers.in/catalog/storage/ssd-drive/external-ssd'},
  //     { slug: 'pen-drives',      url: 'https://mdcomputers.in/catalog/storage/pen-drive'},
  //     { slug: 'motherboards',    url: 'https://mdcomputers.in/catalog/motherboard' },

  //   {slug: 'cabinet', url: 'https://mdcomputers.in/catalog/cabinet'},
  //   ],
  // },


  // {
  //   name: "vedant",
  //   parser: require("./parsers/vedant"),
  //   categories: [
  //     { slug: "cpu-processor", url: "https://www.vedantcomputers.com/pc-components/processor",},
  //     { slug: "ram-memory", url: "https://www.vedantcomputers.com/pc-components/memory",},
  //     { slug: "graphic-cards", url:"https://www.vedantcomputers.com/pc-components/gpu"},
  //     { slug: "ssd", url: "https://www.vedantcomputers.com/pc-components/storage/solid-state-drive"},
  //     { slug: "hdd", url: "https://www.vedantcomputers.com/pc-components/storage/hard-disk-drive"},
  //     { slug: "motherboards", url: "https://www.vedantcomputers.com/pc-components/motherboard"},
  //     { slug: "power-supply", url: "https://www.vedantcomputers.com/pc-components/smps"},
  //     { slug: "ssd", url: "https://www.vedantcomputers.com/pc-components/storage/solid-state-drive"},
  //     { slug: "hdd", url: "https://www.vedantcomputers.com/pc-components/storage/hard-disk-drive"},
  //     { slug: "cpu-cooler", url: "https://www.vedantcomputers.com/pc-components/cpu-cooler"},

  //     { slug: "cabinet", url: "https://www.vedantcomputers.com/pc-components/cabinet"},
  //     { slug: "case-fan", url: "https://www.vedantcomputers.com/pc-components/cooling-accessories/case-fan"},
  //     { slug: "thermal-paste", url: "https://www.vedantcomputers.com/pc-components/cooling-accessories/thermal-paste"},
  //     { slug: "cooling-brackets", url: "https://www.vedantcomputers.com/pc-components/cooling-accessories/cooler-brackets"},
  //      { slug: "laptop-cooler", url: "https://www.vedantcomputers.com/pc-components/cooling-accessories/laptop-cooler"},

  //   ],
  // },

  // {
  //   name: "vishal",
  //   parser: require("./parsers/vishal"),
  //   categories: [
  //     { slug: "cpu-processor", url: "https://vishalperipherals.com/collections/processors" },
  //     { slug: "ram-memory", url: "https://vishalperipherals.com/collections/ram" },
  //     { slug: "graphic-cards", url: "https://vishalperipherals.com/collections/graphic-cards"},
  //     { slug: "cabinet", url: "https://vishalperipherals.com/collections/cabinets"},
  //     { slug: "motherboards", url: "https://vishalperipherals.com/collections/motherboards"},
  //     { slug: "ssd", url: "https://vishalperipherals.com/collections/solid-state-drive-ssd"},
  //     { slug: "hdd", url: "https://vishalperipherals.com/collections/hard-disk"},
  //     { slug: "power-supply", url: "https://vishalperipherals.com/collections/power-supply" },
  //     { slug: "coolers", url: "https://vishalperipherals.com/collections/gaming-coolers"},
  //     { slug: "monitors", url: "https://vishalperipherals.com/collections/monitors"},
  //   ],
  // },

  
  // {
  //   name: "pcstudio",
  //   parser: require("./parsers/pcstudio"),
  //   categories: [
  //     { slug: "cpu-processor", url: "https://www.pcstudio.in/product-category/processor/",},
  //     { slug: "ram-memory", url: "https://www.pcstudio.in/product-category/ram/",},
  //     {slug: "monitors", url: "https://www.pcstudio.in/product-category/monitor/"},
  //     { slug: "storage", url: "https://www.pcstudio.in/product-category/storage/" },
  //     { slug: "graphics-card", url: "https://www.pcstudio.in/product-category/graphics-card/"},
  //     {slug: "motherboard", url: "https://www.pcstudio.in/product-category/motherboard/"},
  //     { slug: "cabinets", url: "https://www.pcstudio.in/product-category/cabinets/"},

  //     { slug: "power-supply", url: "https://www.pcstudio.in/product-category/power-supply/" },
  //     { slug: "cpu-cooler", url: "https://www.pcstudio.in/product-category/cpu-cooler/" },
  //     {slug: "cabinet-fans", url: "https://www.pcstudio.in/product-category/cabinet-fan/"}
  //   ],
  // },


  {
  name: 'fgtech',
  parser: require('./parsers/fgtech'),
  categories: [
    {slug: 'ram-memory', url: 'https://fgtechstore.com/product-category/memory-and-storage-solutions/desktop-and-laptop-ram/'},
  ]
}

  // {
  //   name  : 'elitehubs',
  //   parser: require('./parsers/elitehubs'),
  //   categories: [
  //     {
  //       slug: 'cpu-processor',
  //       url : 'https://elitehubs.com/collections/processor'
  //     },
  //   ],
  // },
];

module.exports = { STORES };
