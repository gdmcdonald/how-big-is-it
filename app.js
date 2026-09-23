/* ------------------------------------------------------------------------
 * Solar System vs. Earth — data loading, thumbnails, table + compare tool.
 *
 * Data lives entirely in solar_system_and_earth_by_area.csv (fetched at
 * load time, not embedded in this file). Thumbnails are resolved lazily,
 * per-row, the first time a row scrolls into view:
 *   - Country / dependency rows with a `shape_code` get a black silhouette
 *     SVG of that country/territory from the "mapsicon" project (via the
 *     jsdelivr CDN mirror of github.com/djaiss/mapsicon).
 *   - Everything else (Solar System objects, oceans, continents, and any
 *     country without mapsicon coverage) gets its page thumbnail from the
 *     Wikipedia REST Summary API, using the title embedded in that row's
 *     `wiki` URL.
 *   - If the primary choice fails to load, we fall back to the Wikipedia
 *     thumbnail; if that also fails, we show a plain "—".
 * All thumbnails are shown at the same fixed box size regardless of the
 * real-world size of the object/country — object-fit: contain preserves
 * each shape's true aspect ratio inside that box.
 * ---------------------------------------------------------------------- */

const CSV_PATH = "solar_system_and_earth_by_area.csv";
const THUMB_BOX = 44; // px, square
const KM_PER_AU = 149597870.7; // IAU-defined astronomical unit, exact

let DATA = [];
let DATA_BY_RANK = new Map();
let EARTH_AREA = 510064470;
let sortKey = "rank";
let sortAsc = true;
let thumbObserver = null;

/* ---------------------------- CSV parsing ----------------------------
 * Parsing itself is delegated to Papa Parse (loaded in index.html) rather
 * than a hand-rolled parser — it's the standard, well-tested choice for
 * this and correctly handles the RFC 4180 edge cases (quoted fields with
 * embedded commas/quotes, CRLF vs LF) that a quick parser easily misses.
 * ---------------------------------------------------------------------- */

function coerceRecord(rec) {
  return {
    rank: parseInt(rec.rank, 10),
    name: rec.name,
    category: rec.category,
    subtype: rec.subtype,
    area_km2: parseFloat(rec.area_km2),
    wiki: rec.wiki,
    note: rec.note || "",
    shape_code: (rec.shape_code || "").trim().toLowerCase(),
    dist_from_sun_au: rec.dist_from_sun_au === "" ? null : parseFloat(rec.dist_from_sun_au),
    // The CSV is the source of truth for images: if this cell is filled in,
    // it is used as-is, no matter what shape_code/category would otherwise
    // suggest. Edit this column directly to override any row's image.
    image_url: (rec.image_url || "").trim(),
  };
}

async function loadData() {
  if (typeof Papa === "undefined") {
    throw new Error("Papa Parse didn't load from the CDN (check your network connection or ad-blocker), so the CSV can't be parsed.");
  }
  const resp = await fetch(CSV_PATH, { cache: "force-cache" });
  if (!resp.ok) throw new Error(`Could not fetch ${CSV_PATH} (HTTP ${resp.status})`);
  const text = await resp.text();

  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });
  if (parsed.errors && parsed.errors.length) {
    // Papa reports row-level issues (e.g. a ragged row) without throwing;
    // surface them in the console rather than silently dropping data.
    console.warn(`${CSV_PATH}: ${parsed.errors.length} row(s) had parse warnings`, parsed.errors);
  }

  DATA = parsed.data.map(coerceRecord).filter(d => d.name && !Number.isNaN(d.rank));
  DATA_BY_RANK = new Map(DATA.map(d => [String(d.rank), d]));
  const earth = DATA.find(d => d.name === "Earth" && d.category === "Solar System object");
  if (earth) EARTH_AREA = earth.area_km2;
}

/* --------------------------- Thumbnail logic -------------------------- */

function wikiTitleFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/^\/wiki\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  } catch (e) {
    return null;
  }
}

function sessionCacheGet(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}
function sessionCacheSet(key, val) {
  try { sessionStorage.setItem(key, val); } catch (e) { /* storage disabled/full: ignore */ }
}

// Returns an image URL (string) or "" if none could be found. Caches
// (including negative results) in sessionStorage so repeat renders in the
// same tab/session don't re-hit the network.
async function fetchWikipediaThumb(title) {
  if (!title) return "";
  const cacheKey = "wpthumb:" + title;
  const cached = sessionCacheGet(cacheKey);
  if (cached !== null) return cached;

  let src = "";
  try {
    const resp = await fetch(
      "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title),
      { headers: { Accept: "application/json" } }
    );
    if (resp.ok) {
      const json = await resp.json();
      src = (json.thumbnail && json.thumbnail.source)
          || (json.originalimage && json.originalimage.source)
          || "";
    }
  } catch (e) {
    // offline, CORS blocked, DNS failure, etc — treat as "no image"
  }
  sessionCacheSet(cacheKey, src);
  return src;
}

function mapsiconUrl(code) {
  return `https://cdn.jsdelivr.net/gh/djaiss/mapsicon@master/all/${code}/vector.svg`;
}

function thumbPlaceholderHTML(d) {
  const extra = d.category === "Ocean" ? " thumb-ocean" : "";
  return `<span class="thumb${extra}" data-rank="${d.rank}"></span>`;
}

function setupThumbObserver() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        thumbObserver.unobserve(entry.target);
        resolveThumb(entry.target);
      }
    }
  }, { rootMargin: "300px 0px", threshold: 0.01 });

  document.querySelectorAll("#tbody .thumb:not([data-observed])").forEach(el => {
    el.setAttribute("data-observed", "1");
    thumbObserver.observe(el);
  });
}

function showEmptyThumb(el) {
  el.classList.add("thumb-empty");
  el.textContent = "\u2014"; // em dash
}

// Resolution order, each step falling through to the next on failure:
//   1. d.image_url from the CSV — the source of truth. Edit this cell to
//      pin/override any row's image; nothing here will second-guess it.
//   2. d.shape_code — construct the mapsicon country-shape URL. This is
//      just a convenience for rows where image_url hasn't been filled in
//      yet; once you edit image_url for a row, this step is skipped.
//   3. Live Wikipedia thumbnail lookup (cached in sessionStorage).
//   4. A plain "—".
async function resolveThumb(el) {
  const d = DATA_BY_RANK.get(el.getAttribute("data-rank"));
  if (!d) return showEmptyThumb(el);

  const title = wikiTitleFromUrl(d.wiki);
  const isShapeUrl = (url) => url.includes("mapsicon");

  const candidates = [];
  if (d.image_url) candidates.push({ src: d.image_url, cls: isShapeUrl(d.image_url) ? "thumb-shape" : "thumb-photo" });
  if (d.category === "Country / dependency" && d.shape_code) candidates.push({ src: mapsiconUrl(d.shape_code), cls: "thumb-shape" });

  function tryNext(i) {
    if (i >= candidates.length) {
      // final fallback: live Wikipedia lookup
      fetchWikipediaThumb(title).then(src => {
        if (!src) return showEmptyThumb(el);
        const img = document.createElement("img");
        img.className = "thumb-photo";
        img.loading = "lazy";
        img.alt = "";
        img.src = src;
        img.onerror = () => { img.remove(); showEmptyThumb(el); };
        el.appendChild(img);
      });
      return;
    }
    const { src, cls } = candidates[i];
    const img = document.createElement("img");
    img.className = cls;
    img.loading = "lazy";
    img.alt = "";
    img.src = src;
    img.onerror = () => { img.remove(); tryNext(i + 1); };
    el.appendChild(img);
  }
  tryNext(0);
}

/* ------------------------------ Formatting ----------------------------- */

function formatArea(area) {
  if (area >= 1) return Math.round(area).toLocaleString("en-US") + " km\u00B2";
  return area.toPrecision(3) + " km\u00B2";
}

function formatDistance(au) {
  if (au === null || Number.isNaN(au)) return "\u2014";
  if (au === 0) return "\u2014"; // the Sun itself
  const km = au * KM_PER_AU;
  const auText = au < 1000
    ? au.toLocaleString("en-US", { maximumSignificantDigits: 4 }) + " AU"
    : au.toExponential(2).replace("e", " \u00D7 10^") + " AU";
  const kmText = km >= 1e9
    ? (km / 1e9).toLocaleString("en-US", { maximumSignificantDigits: 4 }) + " billion km"
    : Math.round(km).toLocaleString("en-US") + " km";
  return `${auText} (${kmText})`;
}

/* -------------------------------- Table -------------------------------- */

function currentRows() {
  const q = document.getElementById("q").value.trim().toLowerCase();
  const cat = document.getElementById("cat").value;
  let rows = DATA.filter(d => {
    if (cat && d.category !== cat) return false;
    if (q && !d.name.toLowerCase().includes(q)) return false;
    return true;
  });
  rows.sort((a, b) => {
    let av = a[sortKey];
    let bv = b[sortKey];
    if (typeof av === "string") { av = av.toLowerCase(); bv = bv.toLowerCase(); }
    if (av < bv) return sortAsc ? -1 : 1;
    if (av > bv) return sortAsc ? 1 : -1;
    return 0;
  });
  return rows;
}

function render() {
  const rows = currentRows();
  const tbody = document.getElementById("tbody");
  const frag = document.createDocumentFragment();
  for (const d of rows) {
    const tr = document.createElement("tr");
    const noteAttr = d.note ? ` title="${d.note.replace(/"/g, "&quot;")}"` : "";
    tr.innerHTML = `
      <td>${d.rank}</td>
      <td>${thumbPlaceholderHTML(d)}</td>
      <td${noteAttr}><a href="${d.wiki}" target="_blank" rel="noopener">${d.name}</a>${d.note ? " *" : ""}</td>
      <td>${d.subtype || d.category}</td>
      <td>${formatArea(d.area_km2)}</td>
      <td>${formatDistance(d.dist_from_sun_au)}</td>
    `;
    frag.appendChild(tr);
  }
  tbody.innerHTML = "";
  tbody.appendChild(frag);
  document.getElementById("count-label").textContent = `Showing ${rows.length} of ${DATA.length} entries.`;
  setupThumbObserver();
}

/* ------------------------------ Compare tool ---------------------------- */

function findByName(name) {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  return DATA.find(d => d.name.toLowerCase() === n)
      || DATA.find(d => d.name.toLowerCase().includes(n));
}

function updateCompare() {
  const a = findByName(document.getElementById("item-a").value);
  const b = findByName(document.getElementById("item-b").value);
  const out = document.getElementById("compare-result");
  if (!a || !b) {
    out.innerHTML = "<small>Type two names above (countries, moons, oceans, asteroids&hellip;) to compare their surface areas.</small>";
    return;
  }
  const bigger = a.area_km2 >= b.area_km2 ? a : b;
  const smaller = a.area_km2 >= b.area_km2 ? b : a;
  const ratio = bigger.area_km2 / smaller.area_km2;

  out.innerHTML = `
    <div class="grid">
      <div class="compare-card">
        ${thumbPlaceholderHTML(bigger)}
        <p><strong>${bigger.name}</strong><br><small>${formatArea(bigger.area_km2)}</small></p>
      </div>
      <div class="compare-card">
        ${thumbPlaceholderHTML(smaller)}
        <p><strong>${smaller.name}</strong><br><small>${formatArea(smaller.area_km2)}</small></p>
      </div>
    </div>
    <p><strong>${bigger.name}</strong> is `
    + `<strong>${ratio.toLocaleString("en-US", { maximumSignificantDigits: 3 })}&times;</strong> the surface area of `
    + `<strong>${smaller.name}</strong>.</p>`;

  // Only ever two of these on screen at once, so resolve them directly
  // rather than routing through the table's lazy-load IntersectionObserver
  // (which also wouldn't fire anyway while this panel is hidden).
  out.querySelectorAll(".thumb").forEach(resolveThumb);
}

/* --------------------------------- Tabs --------------------------------- */
// Pure DOM wiring, independent of the CSV data, so tabs work immediately
// even while the data is still loading.
function setupTabs() {
  const tabs = [
    { btn: document.getElementById("tab-list"), panel: document.getElementById("panel-list") },
    { btn: document.getElementById("tab-compare"), panel: document.getElementById("panel-compare") },
  ];
  function activate(activeBtn) {
    for (const { btn, panel } of tabs) {
      const isActive = btn === activeBtn;
      btn.setAttribute("aria-selected", String(isActive));
      btn.classList.toggle("secondary", !isActive);
      panel.hidden = !isActive;
    }
  }
  for (const { btn } of tabs) {
    btn.addEventListener("click", () => activate(btn));
  }
}
setupTabs();

/* --------------------------------- Init --------------------------------- */

function populateDatalist() {
  const datalist = document.getElementById("all-names");
  const frag = document.createDocumentFragment();
  for (const d of DATA) {
    const opt = document.createElement("option");
    opt.value = d.name;
    frag.appendChild(opt);
  }
  datalist.appendChild(frag);
}

function wireUpEvents() {
  document.getElementById("q").addEventListener("input", render);
  document.getElementById("cat").addEventListener("change", render);

  document.querySelectorAll("thead th[data-key]").forEach(th => {
    th.style.cursor = "pointer";
    th.addEventListener("click", () => {
      const key = th.getAttribute("data-key");
      if (sortKey === key) { sortAsc = !sortAsc; } else { sortKey = key; sortAsc = true; }
      render();
    });
  });

  document.getElementById("item-a").addEventListener("input", updateCompare);
  document.getElementById("item-b").addEventListener("input", updateCompare);
}

async function init() {
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = `<tr><td colspan="6"><small>Loading data from ${CSV_PATH}&hellip;</small></td></tr>`;
  try {
    await loadData();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6">
      <strong>Couldn't load ${CSV_PATH}.</strong>
      <p><small>If you opened this file directly (a <code>file://</code> URL), most browsers block
      the fetch this page needs to read the CSV. Serve the folder over HTTP instead, e.g. run
      <code>python3 -m http.server</code> in the folder and open
      <code>http://localhost:8000/</code>, or host both files on GitHub Pages or similar.</small></p>
      <p><small>Error detail: ${(err && err.message) || err}</small></p>
    </td></tr>`;
    return;
  }
  wireUpEvents();
  populateDatalist();
  render();
}

init();
