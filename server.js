const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || "95a7aaa1cbmsh8dd155d3f15c9b5p1788e8jsnbe9c38d76c56";
const ZILLOW_HOST = "unofficial-zillow-api2.p.rapidapi.com";

app.get("/", (req, res) => {
  res.json({ status: "FlipRadar Proxy Running", version: "3.0.0" });
});

// ── POST to Zillow search ─────────────────────────────────────────────────────
async function searchZillow(location, status = "for_sale", page = 0) {
  const url = `https://${ZILLOW_HOST}/search/address`;
  const body = {
    page,
    status,
    location,
    min_price: {},
    max_price: {},
    min_beds: {},
    min_baths: {},
    min_sqft: {},
    max_sqft: {},
    min_lot_size: {},
    year_built_min: {},
    year_built_max: {},
    has_pool: {},
    has_garage: {},
    keywords: {},
    single_story: {},
    has_3d_tour: {},
    has_open_house: {},
    is_coming_soon: {},
    is_foreclosure: {},
    is_fsbo: {},
    is_new_construction: {},
    has_basement: {},
    has_ac: {},
    is_waterfront: {},
    parking_spots: {},
    days_on_zillow: {},
    min_school_rating: {},
    is_55_plus: {},
    max_hoa: {},
    only_price_reduction: {},
  };

  console.log(`[FETCH] POST ${url} | location=${location} status=${status}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-rapidapi-host": ZILLOW_HOST,
      "x-rapidapi-key": RAPIDAPI_KEY,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  console.log(`[STATUS] ${res.status} | [PREVIEW] ${text.slice(0, 400)}`);
  try { return { status: res.status, body: JSON.parse(text) }; }
  catch (e) { return { status: res.status, body: text }; }
}

// ── Extract listings from any response shape ──────────────────────────────────
function extractListings(body) {
  if (!body) return [];
  if (Array.isArray(body)) return body;
  for (const key of ["results","listings","data","homes","props","properties","items","searchResults","list","zpids","result"]) {
    if (Array.isArray(body[key]) && body[key].length > 0) return body[key];
  }
  if (body.data && typeof body.data === "object") {
    for (const key of ["results","listings","homes","props","properties"]) {
      if (Array.isArray(body.data[key]) && body.data[key].length > 0) return body.data[key];
    }
  }
  return [];
}

// ── Normalize to common shape ─────────────────────────────────────────────────
function normalize(raw, source) {
  const hi = raw.hdpData?.homeInfo || {};
  const g = (...keys) => {
    for (const k of keys) {
      const v = raw[k] ?? hi[k];
      if (v !== undefined && v !== null && v !== 0 && v !== "") return v;
    }
    return null;
  };

  const rawPrice = raw.unformattedPrice || raw.price || raw.listPrice ||
    raw.soldPrice || raw.last_sold_price || hi.price || hi.soldPrice || 0;
  const price = typeof rawPrice === "string"
    ? parseInt(rawPrice.replace(/[^0-9]/g, "")) : (rawPrice || 0);

  return {
    source,
    address:      raw.address || raw.streetAddress || raw.street_address || hi.streetAddress || "Unknown",
    city:         g("city") || "",
    state:        g("state") || "",
    zip:          g("zipcode", "zip", "postalCode", "postal_code") || "",
    price,
    sqft:         g("livingArea", "sqft", "living_area", "finishedSqFt") || 0,
    beds:         g("beds", "bedrooms", "bedroom") || 0,
    baths:        g("baths", "bathrooms", "bathroom") || 0,
    yearBuilt:    g("yearBuilt", "year_built") || 0,
    daysOnMarket: g("daysOnMarket", "days_on_market", "timeOnZillow") || 0,
    zestimate:    g("zestimate") || 0,
    imgSrc:       raw.imgSrc || raw.image || raw.img_src || raw.carouselPhotos?.[0]?.url || null,
    detailUrl:    raw.detailUrl || raw.detail_url || raw.hdpUrl || null,
    statusType:   raw.statusType || raw.status || "FOR_SALE",
    zpid:         g("zpid") || null,
  };
}

// ── DEBUG endpoint ────────────────────────────────────────────────────────────
app.get("/debug", async (req, res) => {
  const { location = "Cameron Park CA" } = req.query;
  try {
    const { status, body } = await searchZillow(location, "for_sale", 0);
    res.json({
      status,
      topLevelKeys: typeof body === "object" ? Object.keys(body) : "not-json",
      listingsFound: extractListings(body).length,
      firstListing: extractListings(body)[0] || null,
      preview: JSON.stringify(body).slice(0, 1000),
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// ── MAIN SEARCH ───────────────────────────────────────────────────────────────
app.get("/search", async (req, res) => {
  const { location } = req.query;
  if (!location) return res.status(400).json({ error: "location param required" });

  const errors = [];
  let forSale = [], sold = [];

  // Fetch for-sale listings (pages 0 and 1 for more results)
  try {
    const { status, body } = await searchZillow(location, "for_sale", 0);
    const listings = extractListings(body);
    if (listings.length > 0) {
      forSale = listings.map(r => normalize(r, "zillow"));
      console.log(`[FOR SALE] ✓ ${forSale.length} listings`);

      // Try page 1 for more
      try {
        const { body: body2 } = await searchZillow(location, "for_sale", 1);
        const more = extractListings(body2);
        if (more.length > 0) {
          forSale = [...forSale, ...more.map(r => normalize(r, "zillow"))];
          console.log(`[FOR SALE page 2] +${more.length} more`);
        }
      } catch (e2) { /* page 2 optional */ }
    } else {
      errors.push(`for_sale status=${status}, keys=${typeof body==="object"?Object.keys(body).join(","):"raw"}, preview=${JSON.stringify(body).slice(0,200)}`);
    }
  } catch (e) {
    errors.push(`for_sale error: ${e.message}`);
  }

  // Fetch recently sold for comps
  try {
    const { status, body } = await searchZillow(location, "recently_sold", 0);
    const listings = extractListings(body);
    if (listings.length > 0) {
      sold = listings.map(r => normalize(r, "zillow-sold"));
      console.log(`[SOLD] ✓ ${sold.length} comps`);
    }
  } catch (e) {
    errors.push(`sold error: ${e.message}`);
  }

  // Avg $/sqft from comps
  const psfs = sold.filter(s => s.price && s.sqft).map(s => s.price / s.sqft);
  const avgPsf = psfs.length ? Math.round(psfs.reduce((a, b) => a + b, 0) / psfs.length) : 0;

  // Deduplicate
  const seen = new Set();
  const deduped = forSale.filter(p => {
    const key = `${p.address}${p.price}`.toLowerCase().replace(/\s/g, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[RESULT] ${deduped.length} for-sale, ${sold.length} comps, $${avgPsf}/sqft`);

  res.json({
    location,
    forSale: deduped,
    sold,
    avgPsf,
    sources: { zillow: deduped.length, soldComps: sold.length },
    errors,
  });
});

app.listen(PORT, () => console.log(`FlipRadar proxy v3 on port ${PORT}`));
