const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS: allow requests from any origin (your FlipRadar app) ─────────────────
app.use(cors());
app.use(express.json());

// ── Your RapidAPI key (set as env var on Render, or paste here for testing) ───
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "95a7aaa1cbmsh8dd155d3f15c9b5p1788e8jsnbe9c38d76c56";

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "FlipRadar Proxy Running", version: "1.0.0" });
});

// ── Helper: call RapidAPI ────────────────────────────────────────────────────
async function rapidFetch(host, path) {
  const url = `https://${host}${path}`;
  const res = await fetch(url, {
    headers: {
      "x-rapidapi-host": host,
      "x-rapidapi-key": RAPIDAPI_KEY,
      "Content-Type": "application/json",
    },
  });
  const body = await res.json();
  return { status: res.status, ok: res.ok, body };
}

// ── Helper: extract listings from any response shape ─────────────────────────
function extractListings(body) {
  if (!body) return [];
  for (const key of ["results","listings","data","homes","props","properties","items","searchResults"]) {
    if (Array.isArray(body[key]) && body[key].length > 0) return body[key];
  }
  if (Array.isArray(body) && body.length > 0) return body;
  if (body.data) {
    for (const key of ["results","listings","homes","props","properties"]) {
      if (Array.isArray(body.data[key]) && body.data[key].length > 0) return body.data[key];
    }
  }
  return [];
}

// ── Helper: normalize a listing to a common shape ─────────────────────────────
function normalize(raw, source) {
  const hi = raw.hdpData?.homeInfo || {};
  const get = (...keys) => {
    for (const k of keys) {
      const v = raw[k] ?? hi[k];
      if (v !== undefined && v !== null) return v;
    }
    return null;
  };

  return {
    source,
    address:      get("address","streetAddress") || "Unknown Address",
    city:         get("city") || "",
    state:        get("state") || "",
    zip:          get("zipcode","zip") || "",
    price:        get("price","listPrice","unformattedPrice","soldPrice") || 0,
    sqft:         get("livingArea","sqft","lotArea") || 0,
    beds:         get("beds","bedrooms") || 0,
    baths:        get("baths","bathrooms") || 0,
    yearBuilt:    get("yearBuilt") || 0,
    daysOnMarket: get("daysOnMarket","timeOnZillow") || 0,
    zestimate:    get("zestimate") || 0,
    imgSrc:       raw.imgSrc || raw.image || raw.carouselPhotos?.[0]?.url || null,
    detailUrl:    raw.detailUrl || raw.hdpUrl || null,
    statusType:   raw.statusType || raw.homeStatus || "FOR_SALE",
    lat:          get("latitude","lat") || null,
    lng:          get("longitude","lng","lon") || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: GET /search?location=Cameron+Park+CA
// Calls Zillow + Realtor.com in parallel, merges, deduplicates
// ─────────────────────────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  const { location } = req.query;
  if (!location) return res.status(400).json({ error: "location param required" });

  const loc = encodeURIComponent(location);
  const results = { forSale: [], sold: [], errors: [] };

  // ── Source 1: Zillow (real-estate-zillow-com) ─────────────────────────────
  const zillowEndpoints = [
    `/v1/search/for_sale?location_or_rid=${loc}&property_types=house&sort=relevant&page=1`,
    `/v2/search/for_sale?location=${loc}&home_type=Houses&page=1`,
    `/search/for_sale?location=${loc}&home_type=Houses`,
    `/propertyExtendedSearch?location=${loc}&status_type=ForSale&home_type=Houses`,
  ];

  let zillowForSale = [];
  for (const ep of zillowEndpoints) {
    try {
      const { ok, status, body } = await rapidFetch("real-estate-zillow-com.p.rapidapi.com", ep);
      const listings = extractListings(body);
      if (listings.length > 0) {
        zillowForSale = listings.map(r => normalize(r, "zillow"));
        console.log(`[Zillow] ${zillowForSale.length} for-sale listings via ${ep}`);
        break;
      }
    } catch (e) {
      results.errors.push(`Zillow for_sale: ${e.message}`);
    }
  }

  // ── Source 2: Zillow sold comps ───────────────────────────────────────────
  let zillowSold = [];
  try {
    const soldEps = [
      `/v1/search/sold?location_or_rid=${loc}&property_types=house&sort=relevant&page=1&doz=90`,
      `/v2/search/sold?location=${loc}&home_type=Houses`,
    ];
    for (const ep of soldEps) {
      const { ok, body } = await rapidFetch("real-estate-zillow-com.p.rapidapi.com", ep);
      const listings = extractListings(body);
      if (listings.length > 0) {
        zillowSold = listings.map(r => normalize(r, "zillow-sold"));
        console.log(`[Zillow Sold] ${zillowSold.length} comps`);
        break;
      }
    }
  } catch (e) {
    results.errors.push(`Zillow sold: ${e.message}`);
  }

  // ── Source 3: Realtor.com via RapidAPI ────────────────────────────────────
  let realtorListings = [];
  const realtorEndpoints = [
    `/properties/v3/list?location=${loc}&status[]=for_sale&type[]=single_family&limit=20`,
    `/properties/list?location=${loc}&status_type=ForSale&prop_type=single_family&limit=20`,
    `/v1/properties/list?location=${loc}&status=ForSale&prop_type=house&limit=20`,
  ];
  for (const ep of realtorEndpoints) {
    try {
      const { ok, body } = await rapidFetch("realtor16.p.rapidapi.com", ep);
      const listings = extractListings(body);
      if (listings.length > 0) {
        realtorListings = listings.map(r => normalize(r, "realtor"));
        console.log(`[Realtor] ${realtorListings.length} listings`);
        break;
      }
    } catch (e) {
      results.errors.push(`Realtor: ${e.message}`);
    }
  }

  // ── Source 4: Zillow56 (alternate Zillow API) ─────────────────────────────
  let zillow56Listings = [];
  try {
    const ep56 = `/search?location=${loc}&status_type=ForSale&home_type=Houses&page=1`;
    const { ok, body } = await rapidFetch("zillow56.p.rapidapi.com", ep56);
    const listings = extractListings(body);
    if (listings.length > 0) {
      zillow56Listings = listings.map(r => normalize(r, "zillow56"));
      console.log(`[Zillow56] ${zillow56Listings.length} listings`);
    }
  } catch (e) {
    results.errors.push(`Zillow56: ${e.message}`);
  }

  // ── Merge + deduplicate by address ────────────────────────────────────────
  const allForSale = [...zillowForSale, ...realtorListings, ...zillow56Listings];
  const seen = new Set();
  const deduped = allForSale.filter(p => {
    const key = `${p.address}-${p.price}`.toLowerCase().replace(/\s/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // ── Calculate avg $/sqft from sold comps ──────────────────────────────────
  const psfs = zillowSold
    .filter(s => s.price && s.sqft)
    .map(s => s.price / s.sqft);
  const avgPsf = psfs.length
    ? Math.round(psfs.reduce((a, b) => a + b, 0) / psfs.length)
    : 0;

  console.log(`[Result] ${deduped.length} total listings, ${zillowSold.length} comps, avgPsf=$${avgPsf}`);

  res.json({
    location,
    forSale: deduped,
    sold: zillowSold,
    avgPsf,
    sources: {
      zillow: zillowForSale.length,
      realtor: realtorListings.length,
      zillow56: zillow56Listings.length,
      soldComps: zillowSold.length,
    },
    errors: results.errors,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE: GET /property?zpid=12345  — single property detail
// ─────────────────────────────────────────────────────────────────────────────
app.get("/property", async (req, res) => {
  const { zpid } = req.query;
  if (!zpid) return res.status(400).json({ error: "zpid param required" });
  try {
    const { body } = await rapidFetch(
      "real-estate-zillow-com.p.rapidapi.com",
      `/v1/property?zpid=${zpid}`
    );
    res.json(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`FlipRadar proxy running on port ${PORT}`);
});
