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
let RANK_SORTED = []; // DATA sorted by rank asc — lets the Game tab sample pairs by "distance" in the size ordering, independent of row insertion order in the CSV
let CATEGORY_INDEX = new Map(); // category -> indices into RANK_SORTED — lets the Game tab weight pair sampling by category instead of by raw row count (countries are ~80% of all rows)
let CATEGORY_WEIGHTS = []; // [{category, weight}], derived from CATEGORY_INDEX — see CATEGORY_BALANCE

// Tunable knob, 0 to 1, for how much the Game tab's category mix departs
// from the dataset's raw row counts (countries are ~80% of all 344 rows,
// so at 0 almost every round involves one; at 1 every category — Solar
// System object, Ocean, Continent, Country/dependency — is equally likely
// regardless of how many rows it actually has). Per-category weight is
// count^(1 - CATEGORY_BALANCE): 0 -> count^1, exactly proportional to raw
// count (equivalent to a plain uniform pick over all rows); 1 -> count^0
// = 1 for every category, completely flat; 0.5 -> sqrt(count), a
// middle ground that softens the extremes at both ends.
const CATEGORY_BALANCE = 0.7;
let EARTH_AREA = 510064470;
let sortKey = "rank";
let sortAsc = true;
let thumbObserver = null;
let gameState = { difficulty: null, rounds: [], index: 0, score: 0 };

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
  RANK_SORTED = DATA.slice().sort((a, b) => a.rank - b.rank);
  CATEGORY_INDEX = new Map();
  RANK_SORTED.forEach((d, idx) => {
    if (!CATEGORY_INDEX.has(d.category)) CATEGORY_INDEX.set(d.category, []);
    CATEGORY_INDEX.get(d.category).push(idx);
  });
  CATEGORY_WEIGHTS = Array.from(CATEGORY_INDEX.entries()).map(([category, indices]) => ({
    category,
    weight: Math.pow(indices.length, 1 - CATEGORY_BALANCE),
  }));
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
      <td>${thumbPlaceholderHTML(d)}</td>
      <td${noteAttr}><a href="${d.wiki}" target="_blank" rel="noopener">${d.name}</a>${d.note ? " *" : ""}</td>
      <td>${formatArea(d.area_km2)}</td>
      <td>${formatDistance(d.dist_from_sun_au)}</td>
      <td>${d.subtype || d.category}</td>
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

/* -------------------------------- Game tool ------------------------------
 * Guess-which-is-bigger, 10 fixed rounds, +1 per correct guess, 0 per miss.
 * All 20 row-slots across those 10 rounds are drawn without replacement —
 * generateGameRounds threads one `used` Set through every pick for the
 * whole game, so no row appears twice in the same 10-question game.
 *
 * Pair sampling varies by difficulty, all drawn from RANK_SORTED (DATA in
 * size order) so "distance between two objects" just means "gap between
 * their indices in that array" — nothing to do with the CSV's row order.
 * The anchor pick (see pickCategoryWeightedIndex) is always category-
 * weighted per CATEGORY_BALANCE — countries are ~80% of all 344 rows by
 * count alone, so leaving this to a plain per-row random pick would make
 * almost every round involve one:
 *   - easy:   two fully random (category-weighted) picks, independent of
 *              each other — sometimes a landslide, sometimes a coin flip,
 *              and that unpredictability is the point.
 *   - medium: one category-weighted anchor, the other offset by a *skewed*
 *              random gap (small gaps much likelier than big ones, no hard
 *              cutoff) in a random direction — "usually similar-ish,
 *              occasionally not" rather than strict neighbours. This
 *              second pick is NOT category-weighted — it has to stay
 *              purely distance-based, or "similar size" stops meaning
 *              anything.
 *   - hard:   same anchor + skewed-gap sampling as medium, but no name
 *              shown (image only) until the reveal. Draws from the same
 *              full pool as the other tiers — every row resolves an image
 *              the same way the table itself does (image_url/shape_code,
 *              falling back to a live Wikipedia lookup), so there's no
 *              separate image-availability filter here either.
 * -------------------------------------------------------------------- */

// Exponential-ish skew: most gaps land small (mean ~8), tapering off with
// a long tail rather than a hard cutoff. Capped only to avoid a pathological
// jump bigger than the dataset itself.
function skewedGap() {
  const gap = Math.floor(-Math.log(Math.random()) * 8) + 1;
  return Math.min(gap, 150);
}

// Picks a row with each *category* weighted by CATEGORY_WEIGHTS (see that
// constant's comment), rather than each row weighted equally — a plain
// per-row pick would be proportional to raw count, and countries are
// ~80% of all 344 rows, so almost every round would involve one.
// Picks a row with each *category* weighted by CATEGORY_WEIGHTS (see that
// constant's comment), rather than each row weighted equally — a plain
// per-row pick would be proportional to raw count, and countries are
// ~80% of all 344 rows, so almost every round would involve one.
// `used` (a Set of RANK_SORTED indices already dealt out this game) is
// excluded row-by-row; a category left with zero remaining members drops
// out of the weighting entirely for this pick rather than ever being
// selected and failing.
function pickCategoryWeightedIndex(used) {
  const available = CATEGORY_WEIGHTS
    .map(entry => ({
      weight: entry.weight,
      members: CATEGORY_INDEX.get(entry.category).filter(idx => !used.has(idx)),
    }))
    .filter(entry => entry.members.length > 0);
  const totalWeight = available.reduce((sum, e) => sum + e.weight, 0);
  let r = Math.random() * totalWeight;
  let chosen = available[available.length - 1];
  for (const entry of available) {
    r -= entry.weight;
    if (r <= 0) { chosen = entry; break; }
  }
  return chosen.members[Math.floor(Math.random() * chosen.members.length)];
}

// Medium/hard's partner pick: starts at the intended skewed gap and
// direction, then widens outward (alternating direction each step) until
// landing on an index that's in range and not already used this game.
// Only ever has to widen when the initial offset collides with a row from
// an earlier round — rare, since at most 18 other rows are excluded out of
// 344 — so this stays close to the original distance almost every time.
function pickNearbyUnusedIndex(i, used) {
  const startGap = skewedGap();
  const startDir = Math.random() < 0.5 ? -1 : 1;
  for (let radius = startGap; radius < RANK_SORTED.length; radius++) {
    for (const dir of [startDir, -startDir]) {
      const j = i + dir * radius;
      if (j >= 0 && j < RANK_SORTED.length && j !== i && !used.has(j)) return j;
    }
  }
  // Unreachable in practice (a full game only ever uses 20 of 344 rows),
  // but a defensive fallback rather than returning undefined.
  for (let k = 0; k < RANK_SORTED.length; k++) {
    if (k !== i && !used.has(k)) return k;
  }
  return i === 0 ? 1 : 0;
}

function pickIndexPair(weighted, used) {
  const i = pickCategoryWeightedIndex(used);
  let j;
  if (!weighted) {
    // Easy: the second pick is just as independent as the first, so it
    // gets the same category-balancing rather than reverting to raw
    // counts — excluding i too, since it isn't in `used` yet at this point.
    const excludeForJ = new Set(used);
    excludeForJ.add(i);
    j = pickCategoryWeightedIndex(excludeForJ);
  } else {
    // Medium/hard: the second pick has to stay purely distance-based from
    // the anchor — that's the entire "similar size" mechanic — so only the
    // anchor itself is category-weighted, not this one.
    j = pickNearbyUnusedIndex(i, used);
  }
  return [i, j];
}

function generateGameRounds(difficulty) {
  const weighted = difficulty !== "easy";
  const used = new Set(); // shared across all 10 rounds, so nothing repeats within one game
  const rounds = [];
  for (let n = 0; n < 10; n++) {
    const [i, j] = pickIndexPair(weighted, used);
    used.add(i);
    used.add(j);
    rounds.push({ a: RANK_SORTED[i], b: RANK_SORTED[j], guess: null, correct: null });
  }
  return rounds;
}

function gameCardHTML(d, hideName) {
  return `
    ${thumbPlaceholderHTML(d)}
    <p class="game-name"${hideName ? " hidden" : ""}><strong>${d.name}</strong></p>
    <p class="game-area" hidden></p>
  `;
}

function renderGameRound() {
  const round = gameState.rounds[gameState.index];
  const hideName = gameState.difficulty === "hard";
  document.getElementById("game-progress").textContent =
    `Round ${gameState.index + 1} of 10 \u2014 Score: ${gameState.score}`;

  const cardA = document.getElementById("game-card-a");
  const cardB = document.getElementById("game-card-b");
  cardA.innerHTML = gameCardHTML(round.a, hideName);
  cardB.innerHTML = gameCardHTML(round.b, hideName);
  cardA.disabled = false;
  cardB.disabled = false;

  document.getElementById("game-reveal").innerHTML = "";
  document.getElementById("game-result-badge").innerHTML = "";
  document.getElementById("game-next").hidden = true;

  // Same reasoning as Compare: only two on screen, resolve directly.
  resolveThumb(cardA.querySelector(".thumb"));
  resolveThumb(cardB.querySelector(".thumb"));

  // Advancing to a new round happens from wherever the Next button
  // scrolled to (bottom of the previous reveal) — bring the fresh round
  // back into view at the top rather than leaving the player scrolled
  // past it.
  document.getElementById("game-progress").scrollIntoView({ behavior: "smooth", block: "start" });
}

function handleGameGuess(side) {
  const round = gameState.rounds[gameState.index];
  if (round.guess) return; // already answered this round

  const chosen = side === "a" ? round.a : round.b;
  const other = side === "a" ? round.b : round.a;
  round.guess = side;
  round.correct = chosen.area_km2 >= other.area_km2; // ties (none in practice) count as correct

  if (round.correct) gameState.score += 1;
  renderGameReveal(round);
}

function renderGameReveal(round) {
  const { a, b, correct } = round;
  const cardA = document.getElementById("game-card-a");
  const cardB = document.getElementById("game-card-b");
  cardA.disabled = true;
  cardB.disabled = true;

  [cardA, cardB].forEach(card => {
    card.querySelector(".game-name").hidden = false;
  });
  cardA.querySelector(".game-area").hidden = false;
  cardA.querySelector(".game-area").textContent = formatArea(a.area_km2);
  cardB.querySelector(".game-area").hidden = false;
  cardB.querySelector(".game-area").textContent = formatArea(b.area_km2);

  const symbol = a.area_km2 === b.area_km2 ? "=" : (a.area_km2 > b.area_km2 ? "&gt;" : "&lt;");
  const resultTag = correct ? "ins" : "del";
  document.getElementById("game-reveal").innerHTML = `<p><strong>${a.name} ${symbol} ${b.name}</strong></p>`;
  document.getElementById("game-result-badge").innerHTML =
    `<${resultTag}>${correct ? "Correct" : "Incorrect"}</${resultTag}>`;

  const nextBtn = document.getElementById("game-next");
  nextBtn.hidden = false;
  // The reveal (comparison line + result) pushes the button below the
  // fold on mobile — scroll it into view automatically rather than
  // leaving the player to find it by hand every round.
  nextBtn.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function outcomeText(score) {
  if (score >= 9) return "You\u2019ve sized it up.";
  if (score >= 6) return "Solid sense of scale.";
  if (score >= 3) return "Your score is a bit small yo.";
  return "Back to the drawing board.";
}

function nextDifficulty(difficulty) {
  if (difficulty === "easy") return "medium";
  if (difficulty === "medium") return "hard";
  return null; // hard is the ceiling
}

// The player's actual guess renders in Pico's default link colour (blue);
// the side they didn't pick gets Pico's own `.contrast` class to de-emphasize
// it to body-text colour instead — both still real, clickable wiki links,
// just visually distinguished using Pico's existing link conventions rather
// than a hand-rolled colour class.
function reviewSideHTML(d, isGuess) {
  const linkClass = isGuess ? "" : ' class="contrast"';
  return `${thumbPlaceholderHTML(d)} <a href="${d.wiki}" target="_blank" rel="noopener"${linkClass}>${d.name}</a>`;
}

function renderGameReview() {
  const tbody = document.getElementById("game-review-body");
  const frag = document.createDocumentFragment();
  gameState.rounds.forEach((round, i) => {
    const { a, b, guess, correct } = round;
    const symbol = a.area_km2 === b.area_km2 ? "=" : (a.area_km2 > b.area_km2 ? "&gt;" : "&lt;");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${reviewSideHTML(a, guess === "a")}</td>
      <td>${symbol}</td>
      <td>${reviewSideHTML(b, guess === "b")}</td>
      <td>${correct ? "<ins>&check;</ins>" : "<del>&cross;</del>"}</td>
    `;
    frag.appendChild(tr);
  });
  tbody.innerHTML = "";
  tbody.appendChild(frag);
  // 10 rows / 20 thumbnails, shown once at game end — resolve directly
  // rather than routing through the main table's lazy-load
  // IntersectionObserver (same reasoning as Compare's two-thumb case).
  document.querySelectorAll("#game-review-body .thumb").forEach(resolveThumb);
}

async function shareGameResult(score, difficulty) {
  const text = `I scored ${score}/10 on "How big is it?" (${difficulty}) \u2014 can you beat me?`;
  const url = location.href.split("#")[0];
  const shareBtn = document.getElementById("game-share");
  const fullMessage = `${text} ${url}`;

  if (navigator.share) {
    // Deliberately one combined `text` field, no separate `url` field: some
    // share targets (iMessage in particular) render a url field as a link
    // preview card and drop an accompanying text field entirely, which
    // silently loses the goading message. Folding the link into the text
    // itself means every target gets the whole thing, together.
    try { await navigator.share({ text: fullMessage }); } catch (e) { /* user cancelled the share sheet */ }
    return;
  }
  if (navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(fullMessage);
      const original = shareBtn.textContent;
      shareBtn.textContent = "Copied!";
      setTimeout(() => { shareBtn.textContent = original; }, 1500);
    } catch (e) { /* clipboard blocked (permissions/insecure context) */ }
  }
}

function endGame() {
  document.getElementById("game-play").hidden = true;
  document.getElementById("game-end").hidden = false;

  const score = gameState.score;
  document.getElementById("game-score").textContent = `${score} / 10`;
  document.getElementById("game-outcome").textContent = outcomeText(score);
  renderGameReview();

  document.getElementById("game-share").onclick = () => shareGameResult(score, gameState.difficulty);
  document.getElementById("game-again-same").onclick = () => startGame(gameState.difficulty);

  const nextDiff = nextDifficulty(gameState.difficulty);
  const harderBtn = document.getElementById("game-again-harder");
  if (nextDiff) {
    harderBtn.hidden = false;
    document.getElementById("next-diff-label").textContent = nextDiff[0].toUpperCase() + nextDiff.slice(1);
    harderBtn.onclick = () => startGame(nextDiff);
  } else {
    harderBtn.hidden = true;
  }
}

function startGame(difficulty) {
  gameState = { difficulty, rounds: generateGameRounds(difficulty), index: 0, score: 0 };
  document.getElementById("game-setup").hidden = true;
  document.getElementById("game-end").hidden = true;
  document.getElementById("game-play").hidden = false;
  renderGameRound();
}

function setupGame() {
  document.querySelectorAll("#game-setup button[data-difficulty]").forEach(btn => {
    btn.addEventListener("click", () => startGame(btn.getAttribute("data-difficulty")));
  });
  document.getElementById("game-card-a").addEventListener("click", () => handleGameGuess("a"));
  document.getElementById("game-card-b").addEventListener("click", () => handleGameGuess("b"));
  document.getElementById("game-next").addEventListener("click", () => {
    gameState.index += 1;
    if (gameState.index >= 10) { endGame(); } else { renderGameRound(); }
  });
  document.getElementById("game-change-difficulty").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("game-play").hidden = true;
    document.getElementById("game-end").hidden = true;
    document.getElementById("game-setup").hidden = false;
  });
}

/* --------------------------------- Tabs --------------------------------- */
// Pure DOM wiring, independent of the CSV data, so tabs work immediately
// even while the data is still loading. Each tab also gets a `?tab=` URL
// param — deep-linkable (e.g. sharing a game result already lands the
// recipient on the Game tab, see shareGameResult) and kept in sync via
// replaceState rather than pushState, so switching tabs doesn't flood the
// browser's back/forward history with every click.
const TAB_PARAM = "tab";

function setupTabs() {
  const tabs = [
    { key: "browse", btn: document.getElementById("tab-list"), panel: document.getElementById("panel-list") },
    { key: "compare", btn: document.getElementById("tab-compare"), panel: document.getElementById("panel-compare") },
    { key: "game", btn: document.getElementById("tab-game"), panel: document.getElementById("panel-game") },
  ];

  function activate(activeBtn, { updateUrl = true } = {}) {
    for (const { key, btn, panel } of tabs) {
      const isActive = btn === activeBtn;
      btn.setAttribute("aria-selected", String(isActive));
      btn.classList.toggle("secondary", !isActive);
      panel.hidden = !isActive;
      if (isActive && updateUrl) {
        const url = new URL(location.href);
        url.searchParams.set(TAB_PARAM, key);
        history.replaceState(null, "", url);
      }
    }
  }
  for (const { btn } of tabs) {
    btn.addEventListener("click", () => activate(btn));
  }

  // Deep link on load: ?tab=compare or ?tab=game opens straight to that
  // tab. No match (including no param at all) leaves the static HTML
  // default — Browse — in place, so this only ever narrows, never resets.
  const requested = new URLSearchParams(location.search).get(TAB_PARAM);
  const match = tabs.find(t => t.key === requested);
  if (match) activate(match.btn, { updateUrl: false });
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
  setupGame();
}

async function init() {
  const tbody = document.getElementById("tbody");
  tbody.innerHTML = `<tr><td colspan="5"><small>Loading data from ${CSV_PATH}&hellip;</small></td></tr>`;
  try {
    await loadData();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5">
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
