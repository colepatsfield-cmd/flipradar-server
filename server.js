const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "95a7aaa1cbmsh8dd155d3f15c9b5p1788e8jsnbe9c38d76c56";
const ZILLOW_HOST = "real-estate-zillow-com.p.rapidapi.com";

app.get("/", (req, res) => {
  res.json({ status: "FlipRadar Proxy Running", version: "2.0.0" });
});

async function zillowFetch(path) {
  const url = `https://${ZILLOW_HOST}${path}`;
  console.log(`[FETCH] ${url}`);
  const res = await fetch(url, {
    headers: {
      "x-rapidapi-host": ZILLOW_HOST,
      "x-rapidapi-key": RAPIDAPI_KEY,
    },
  });
  const text = await res.text();
  console.log(`[STATUS] ${res.status} | [PREVIEW] ${text.slice(0, 300)}`);
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch (e) { return { status: res.status, body: text }; }
}

function extractListings(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  for (const key of ["results","listings","data","homes","props","properties","items","searchResults","list"]) {
    if (Array.isArray(body[key]) && body[key].length > 0) return body[key];
  }
  if (body.data && typeof body.data === "object") {
    for (const key of ["results","listings","homes","props","properties"]) {
      if (Array.isArray(body.data[key]) && body.data[key].length > 0) return body.data[key];
    }
  }
  return [];
}

function normalize(raw, source) {
  const hi = raw.hdpData?.homeInfo || {};
  const g = (...keys) => {
    for (const k of keys) {
      const v = raw[k] ?? hi[k];
      if (v !== undefined && v !== null && v !== 0 && v !== "") return v;
    }
    return null;
  };
  const rawPrice = raw.unformattedPrice || raw.price || raw.listPrice || raw.soldPrice || hi.price || hi.soldPrice || 0;
  const price = typeof rawPrice === "string" ? parseInt(rawPrice.replace(/[^0-9]/g,"")) : rawPrice;

  return {
    source,
    address:      raw.address || raw.streetAddress || hi.streetAddress || "Unknown",
    city:         g("city") || "",
    state:        g("state") || "",
    zip:          g("zipcode","zip","postalCode") || "",
    price,
    sqft:         g("livingArea","sqft","finishedSqFt") || 0,
    beds:         g("beds","bedrooms") || 0,
    baths:        g("baths","bathrooms") || 0,
    yearBuilt:    g("yearBuilt") || 0,
    daysOnMarket: g("daysOnMarket","timeOnZillow") || 0,
    zestimate:    g("zestimate") || 0,
    imgSrc:       raw.imgSrc || raw.image || raw.carouselPhotos?.[0]?.url || null,
    detailUrl:    raw.detailUrl || raw.hdpUrl || null,
    statusType:   raw.statusType || "FOR_SALE",
    zpid:         g("zpid") || null,
  };
}

// ── DEBUG: visit /debug?location=Cameron+Park+CA in browser to see raw API response
app.get("/debug", async (req, res) => {
  const { location = "Cameron Park CA" } = req.query;
  const loc = encodeURIComponent(location);
  const debug = {};

  const endpoints = [
    `/v1/search/for_sale?location_or_rid=${loc}&property_types=house&sort=relevant&page=1`,
    `/v1/search/sold?location_or_rid=${loc}&property_types=house&sort=relevant&page=1&doz=90`,
    `/propertyExtendedSearch?location=${loc}&status_type=ForSale&home_type=Houses`,
  ];

  for (const ep of endpoints) {
    try {
      const { status, body } = await zillowFetch(ep);
      debug[ep] = {
        status,
        topLevelKeys: typeof body === "object" ? Object.keys(body) : "not-json",
        listingsFound: extractListings(body).length,
        preview: JSON.stringify(body).slice(0, 600),
      };
    } catch(e) {
      debug[ep] = { error: e.message };
    }
  }
  res.json(debug);
});

// ── MAIN SEARCH
app.get("/search", async (req, res) => {
  const { location } = req.query;
  if (!location) return res.status(400).json({ error: "location param required" });

  const loc = encodeURIComponent(location);
  const errors = [];
  let forSale = [], sold = [];

  const saleEndpoints = [
    `/v1/search/for_sale?location_or_rid=${loc}&property_types=house&sort=relevant&page=1`,
    `/propertyExtendedSearch?location=${loc}&status_type=ForSale&home_type=Houses`,
    `/v1/search/for_sale?location_or_rid=${loc}&sort=days&page=1`,
  ];

  for (const ep of saleEndpoints) {
    try {
      const { status, body } = await zillowFetch(ep);
      const listings = extractListings(body);
      if (listings.length > 0) {
        forSale = listings.map(r => normalize(r, "zillow"));
        console.log(`[FOR SALE] ✓ ${forSale.length} from ${ep}`);
        break;
      }
      errors.push(`${ep} → ${status}, keys: ${typeof body==="object"?Object.keys(body).join(","):"raw"}`);
    } catch (e) { errors.push(`${ep} → ${e.message}`); }
  }

  const soldEndpoints = [
    `/v1/search/sold?location_or_rid=${loc}&property_types=house&sort=relevant&page=1&doz=90`,
    `/propertyExtendedSearch?location=${loc}&status_type=RecentlySold&home_type=Houses`,
  ];

  for (const ep of soldEndpoints) {
    try {
      const { status, body } = await zillowFetch(ep);
      const listings = extractListings(body);
      if (listings.length > 0) {
        sold = listings.map(r => normalize(r, "zillow-sold"));
        console.log(`[SOLD] ✓ ${sold.length} comps`);
        break;
      }
    } catch (e) { errors.push(`Sold: ${e.message}`); }
  }

  const psfs = sold.filter(s => s.price && s.sqft).map(s => s.price / s.sqft);
  const avgPsf = psfs.length ? Math.round(psfs.reduce((a,b)=>a+b,0)/psfs.length) : 0;

  const seen = new Set();
  const deduped = forSale.filter(p => {
    const key = `${p.address}${p.price}`.toLowerCase().replace(/\s/g,"");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[RESULT] ${deduped.length} for-sale, ${sold.length} comps, $${avgPsf}/sqft, errors: ${errors.length}`);

  res.json({ location, forSale: deduped, sold, avgPsf, sources: { zillow: deduped.length, soldComps: sold.length }, errors });
});

app.listen(PORT, () => console.log(`FlipRadar proxy v2 on port ${PORT}`));
