(() => {
  "use strict";

  // Fill this in after deploying worker/reddit-proxy-worker.js to Cloudflare
  // Workers (free) — see that file's header comment for steps. Example:
  // "https://reddit-slideshow-proxy.yourname.workers.dev"
  const WORKER_PROXY_URL = "";

  // old.reddit.com rejects cross-site browser fetches outright (its edge
  // sees the Sec-Fetch-Site/Origin headers a page-JS fetch() sends and
  // returns a "Blocked" page) — a CORS-unblock extension only changes what
  // the *browser* lets script read, it can't change what reddit's server
  // does with the request, so a direct fetch cannot work here. A request
  // that originates from a server instead (no browser fetch fingerprint)
  // isn't rejected the same way, which is what the Worker proxy and the
  // public proxy fallbacks below rely on.
  const PROXIES = [
    ...(WORKER_PROXY_URL
      ? [(url) => `${WORKER_PROXY_URL}?url=${encodeURIComponent(url)}`]
      : []),
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
    null,
  ];

  const IMAGE_RE = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;
  const GIFV_RE = /\.gifv(\?.*)?$/i;

  const els = {
    form: document.getElementById("load-form"),
    input: document.getElementById("sub-input"),
    status: document.getElementById("status-area"),
    spinner: document.getElementById("spinner"),
    slideshow: document.getElementById("slideshow"),
    subTitle: document.getElementById("sub-title"),
    counter: document.getElementById("slide-counter"),
    mediaViewport: document.getElementById("media-viewport"),
    mediaContainer: document.getElementById("media-container"),
    prevBtn: document.getElementById("prev-btn"),
    nextBtn: document.getElementById("next-btn"),
    autoplayBtn: document.getElementById("autoplay-btn"),
    autoplaySpeed: document.getElementById("autoplay-speed"),
    shareBtn: document.getElementById("share-btn"),
    fullscreenBtn: document.getElementById("fullscreen-btn"),
    permalink: document.getElementById("permalink"),
    loadMoreBtn: document.getElementById("load-more-btn"),
    sortToggleBtn: document.getElementById("sort-toggle-btn"),
    sortPanel: document.getElementById("sort-panel"),
    sortSelect: document.getElementById("sort-select"),
    timeLabel: document.getElementById("time-label"),
    timeSelect: document.getElementById("time-select"),
  };

  const state = {
    items: [],
    currentIndex: 0,
    autoplayTimer: null,
    nextPageUrl: null,
    rawInput: null,
    subredditLabel: "",
  };

  // ---------- input parsing ----------

  function stripToPath(raw) {
    let s = (raw || "").trim();
    if (!s) return "";

    s = s.replace(/^https?:\/\//i, "");
    s = s.replace(/^(www\.|old\.|new\.|np\.|m\.)?reddit\.com\/?/i, "");
    s = s.replace(/^\/+/, "");
    s = s.replace(/^r\//i, "");

    return s;
  }

  function normalizeInput(raw) {
    const s = stripToPath(raw);
    return s || null;
  }

  // Only applies the sort/time cog when the box holds a bare subreddit name
  // (no "/" or "?" yet) — a pasted URL or path already spells out its own
  // sort, and is respected as typed instead of being overridden.
  function applySortSettings(raw) {
    const stripped = stripToPath(raw);
    if (!stripped || /[/?]/.test(stripped)) return stripped;

    const sort = els.sortSelect.value;
    let result = `${stripped}/${sort}/`;
    if (sort === "top" || sort === "controversial") {
      result += `?t=${els.timeSelect.value}`;
    }
    return result;
  }

  function updateTimeVisibility() {
    const show = els.sortSelect.value === "top" || els.sortSelect.value === "controversial";
    els.timeLabel.classList.toggle("hidden", !show);
  }

  function syncSortControlsFromPath(pathAndQuery) {
    const sortMatch = pathAndQuery.match(/^[^/]+\/(hot|new|rising|controversial|top)\b/i);
    els.sortSelect.value = sortMatch ? sortMatch[1].toLowerCase() : "hot";
    const timeMatch = pathAndQuery.match(/[?&]t=([a-z]+)/i);
    if (timeMatch) els.timeSelect.value = timeMatch[1].toLowerCase();
    updateTimeVisibility();
  }

  function buildScrapeUrl(pathAndQuery) {
    return `https://old.reddit.com/r/${pathAndQuery}`;
  }

  // Reads everything after "r=" verbatim, so a value that itself contains
  // "?" and "&" (e.g. ?r=memes/top/?sort=top&t=month) still works, instead
  // of being split apart by normal query-string parsing.
  function readQueryParam() {
    const search = window.location.search;
    if (!search || search.length < 2) return null;
    const query = search.slice(1);
    const key = "r=";
    let raw = null;
    if (query.startsWith(key)) {
      raw = query.slice(key.length);
    } else {
      const params = new URLSearchParams(search);
      if (params.has("r")) raw = params.get("r");
    }
    if (raw === null) return null;
    try {
      return decodeURIComponent(raw);
    } catch (e) {
      return raw;
    }
  }

  function updateAddressBar(rawPathAndQuery) {
    const newUrl = `${window.location.pathname}?r=${rawPathAndQuery}`;
    window.history.replaceState({}, "", newUrl);
  }

  // ---------- fetching ----------

  async function fetchWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  // Reddit's own anti-scraping "Blocked" interstitial is structurally valid,
  // full-length HTML — without this check a proxy serving it looks like a
  // successful fetch and the chain stops instead of trying the next proxy.
  const REDDIT_BLOCKED_RE = /<title>\s*Blocked\s*<\/title>/i;

  async function fetchRedditHtml(targetUrl) {
    let lastError = null;
    for (const buildProxyUrl of PROXIES) {
      const proxyUrl = buildProxyUrl ? buildProxyUrl(targetUrl) : targetUrl;
      try {
        const res = await fetchWithTimeout(proxyUrl, 15000);
        if (!res.ok) {
          lastError = new Error(`Proxy responded with ${res.status}`);
          continue;
        }
        const text = await res.text();
        if (REDDIT_BLOCKED_RE.test(text)) {
          lastError = Object.assign(
            new Error(
              "Reddit blocked this request via every proxy tried. Deploy worker/reddit-proxy-worker.js and set WORKER_PROXY_URL in script.js."
            ),
            { code: "BLOCKED" }
          );
          continue;
        }
        if (text && text.length > 500 && /<html/i.test(text)) {
          return text;
        }
        lastError = new Error("Proxy returned empty or unexpected content");
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("All proxies failed");
  }

  // ---------- HTML parsing ----------

  function extractMediaFromDataUrl(dataUrl) {
    if (!dataUrl) return null;
    if (IMAGE_RE.test(dataUrl)) {
      return { type: "image", src: dataUrl };
    }
    if (GIFV_RE.test(dataUrl)) {
      return { type: "video", src: dataUrl.replace(GIFV_RE, ".mp4") };
    }
    return null;
  }

  function parseRedditHtml(html, baseListUrl) {
    const doc = new DOMParser().parseFromString(html, "text/html");

    if (/you must be over eighteen|quarantined/i.test(doc.body ? doc.body.textContent.slice(0, 3000) : "")) {
      const err = new Error(
        "That subreddit requires age/quarantine confirmation, which this tool can't get past."
      );
      err.code = "QUARANTINED";
      throw err;
    }

    const things = Array.from(doc.querySelectorAll(".thing"));
    const items = [];
    const seen = new Set();

    for (const thing of things) {
      if (thing.classList.contains("promoted") || thing.classList.contains("stickied")) {
        continue;
      }
      const dataUrl = thing.getAttribute("data-url");
      const media = extractMediaFromDataUrl(dataUrl);
      if (!media) continue;
      if (seen.has(media.src)) continue;
      seen.add(media.src);

      const permalinkPath = thing.getAttribute("data-permalink");
      const title = thing.getAttribute("data-title") || "";

      items.push({
        type: media.type,
        src: media.src,
        title,
        permalink: permalinkPath ? `https://old.reddit.com${permalinkPath}` : baseListUrl,
      });
    }

    let nextPageUrl = null;
    const nextLink = doc.querySelector("span.next-button a");
    if (nextLink && nextLink.getAttribute("href")) {
      nextPageUrl = nextLink.getAttribute("href");
    }

    let subredditLabel = "";
    const nameEl = doc.querySelector("#header .redditname a, .redditname a");
    if (nameEl) subredditLabel = nameEl.textContent.trim();

    return {
      items,
      nextPageUrl,
      subredditLabel,
      debug: { thingCount: things.length, docTitle: doc.title, htmlLength: html.length },
    };
  }

  // ---------- UI helpers ----------

  function setStatus(html, isError) {
    els.status.innerHTML = "";
    const p = document.createElement("p");
    p.className = isError ? "error-msg" : "hint";
    p.innerHTML = html;
    els.status.appendChild(p);
  }

  function showSpinner(show) {
    els.spinner.classList.toggle("hidden", !show);
  }

  function showSlideshow(show) {
    els.slideshow.classList.toggle("hidden", !show);
  }

  function renderSlide() {
    const item = state.items[state.currentIndex];
    els.mediaContainer.innerHTML = "";
    if (!item) return;

    let el;
    if (item.type === "video") {
      el = document.createElement("video");
      el.src = item.src;
      el.autoplay = true;
      el.loop = true;
      el.muted = true;
      el.playsInline = true;
      el.controls = false;
    } else {
      el = document.createElement("img");
      el.src = item.src;
      el.alt = item.title || "";
      el.loading = "eager";
      el.onerror = () => skipBrokenSlide();
    }
    els.mediaContainer.appendChild(el);

    els.counter.textContent = `${state.currentIndex + 1} / ${state.items.length}`;
    els.permalink.href = item.permalink;
    els.loadMoreBtn.classList.toggle("hidden", !state.nextPageUrl);
  }

  function skipBrokenSlide() {
    if (state.items.length <= 1) return;
    state.items.splice(state.currentIndex, 1);
    if (state.currentIndex >= state.items.length) state.currentIndex = 0;
    renderSlide();
  }

  function goTo(delta) {
    if (state.items.length === 0) return;
    state.currentIndex =
      (state.currentIndex + delta + state.items.length) % state.items.length;
    renderSlide();
  }

  function stopAutoplay() {
    if (state.autoplayTimer) {
      clearInterval(state.autoplayTimer);
      state.autoplayTimer = null;
    }
    els.autoplayBtn.textContent = "▶ Autoplay";
  }

  function startAutoplay() {
    stopAutoplay();
    const seconds = Number(els.autoplaySpeed.value) || 5;
    state.autoplayTimer = setInterval(() => goTo(1), seconds * 1000);
    els.autoplayBtn.textContent = "⏸ Pause";
  }

  function toggleAutoplay() {
    if (state.autoplayTimer) stopAutoplay();
    else startAutoplay();
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      els.mediaViewport.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }

  async function copyShareLink() {
    const url = `${window.location.origin}${window.location.pathname}?r=${state.rawInput}`;
    try {
      await navigator.clipboard.writeText(url);
      const original = els.shareBtn.textContent;
      els.shareBtn.textContent = "Copied!";
      setTimeout(() => (els.shareBtn.textContent = original), 1500);
    } catch (e) {
      window.prompt("Copy this link:", url);
    }
  }

  // ---------- load flow ----------

  async function loadSubreddit(rawInputValue) {
    const normalized = normalizeInput(rawInputValue);
    if (!normalized) {
      setStatus("Please enter a subreddit name or reddit URL.", true);
      return;
    }

    state.rawInput = normalized;
    state.items = [];
    state.currentIndex = 0;
    state.nextPageUrl = null;
    stopAutoplay();
    showSlideshow(false);
    showSpinner(true);
    setStatus("Loading&hellip;", false);

    const scrapeUrl = buildScrapeUrl(normalized);

    try {
      const html = await fetchRedditHtml(scrapeUrl);
      const { items, nextPageUrl, subredditLabel, debug } = parseRedditHtml(html, scrapeUrl);
      console.log("[reddit-slideshow] debug:", debug);

      if (items.length === 0) {
        const extra =
          debug.thingCount > 0
            ? ` (found ${debug.thingCount} post(s) on the page, but none were direct image/gif links)`
            : ` (page title was "${debug.docTitle}", ${debug.htmlLength} bytes, 0 posts found &mdash; likely blocked, rate-limited, or not a listing page)`;
        setStatus(
          `No image or GIF posts were found${extra}. The subreddit may be empty, private, nonexistent, or only contain post types this tool doesn't support (galleries, Reddit-hosted video, text posts). Check the browser console for full details.`,
          true
        );
        showSpinner(false);
        return;
      }

      state.items = items;
      state.nextPageUrl = nextPageUrl;
      state.subredditLabel = subredditLabel || normalized.split("/")[0];

      els.subTitle.textContent = `r/${state.subredditLabel}`;
      els.subTitle.href = scrapeUrl;

      syncSortControlsFromPath(normalized);
      updateAddressBar(normalized);
      setStatus("", false);
      els.status.innerHTML = "";
      showSpinner(false);
      showSlideshow(true);
      renderSlide();
    } catch (err) {
      showSpinner(false);
      const msg =
        err && (err.code === "QUARANTINED" || err.code === "BLOCKED")
          ? err.message
          : `Couldn't load that subreddit (${err && err.message ? err.message : "unknown error"}). Deploy worker/reddit-proxy-worker.js and set WORKER_PROXY_URL in script.js for reliable loading &mdash; the public proxy fallbacks are frequently down or rate-limited.`;
      setStatus(msg, true);
    }
  }

  async function loadMore() {
    if (!state.nextPageUrl) return;
    els.loadMoreBtn.disabled = true;
    els.loadMoreBtn.textContent = "Loading&hellip;";
    try {
      const html = await fetchRedditHtml(state.nextPageUrl);
      const { items, nextPageUrl } = parseRedditHtml(html, state.nextPageUrl);
      const existing = new Set(state.items.map((i) => i.src));
      const fresh = items.filter((i) => !existing.has(i.src));
      state.items.push(...fresh);
      state.nextPageUrl = nextPageUrl;
      renderSlide();
    } catch (err) {
      const msg =
        err && (err.code === "QUARANTINED" || err.code === "BLOCKED")
          ? err.message
          : "Failed to load more posts. Try again shortly.";
      setStatus(msg, true);
    } finally {
      els.loadMoreBtn.disabled = false;
      els.loadMoreBtn.textContent = "Load more posts";
    }
  }

  // ---------- events ----------

  els.form.addEventListener("submit", (e) => {
    e.preventDefault();
    closeSortPanel();
    loadSubreddit(applySortSettings(els.input.value));
  });

  function openSortPanel() {
    els.sortPanel.classList.remove("hidden");
    els.sortToggleBtn.setAttribute("aria-expanded", "true");
  }
  function closeSortPanel() {
    els.sortPanel.classList.add("hidden");
    els.sortToggleBtn.setAttribute("aria-expanded", "false");
  }
  els.sortToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (els.sortPanel.classList.contains("hidden")) openSortPanel();
    else closeSortPanel();
  });
  els.sortPanel.addEventListener("click", (e) => e.stopPropagation());
  els.sortSelect.addEventListener("change", updateTimeVisibility);
  document.addEventListener("click", closeSortPanel);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSortPanel();
  });
  updateTimeVisibility();

  els.prevBtn.addEventListener("click", () => goTo(-1));
  els.nextBtn.addEventListener("click", () => goTo(1));
  els.autoplayBtn.addEventListener("click", toggleAutoplay);
  els.autoplaySpeed.addEventListener("change", () => {
    if (state.autoplayTimer) startAutoplay();
  });
  els.shareBtn.addEventListener("click", copyShareLink);
  els.fullscreenBtn.addEventListener("click", toggleFullscreen);
  els.loadMoreBtn.addEventListener("click", loadMore);

  document.addEventListener("keydown", (e) => {
    if (els.slideshow.classList.contains("hidden")) return;
    if (document.activeElement === els.input) return;
    if (e.key === "ArrowLeft") goTo(-1);
    else if (e.key === "ArrowRight") goTo(1);
    else if (e.key === " ") {
      e.preventDefault();
      toggleAutoplay();
    }
  });

  // basic touch swipe support
  (() => {
    let startX = null;
    els.mediaViewport.addEventListener("touchstart", (e) => {
      startX = e.touches[0].clientX;
    });
    els.mediaViewport.addEventListener("touchend", (e) => {
      if (startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 40) goTo(dx < 0 ? 1 : -1);
      startX = null;
    });
  })();

  // ---------- init ----------

  (function init() {
    const fromQuery = readQueryParam();
    if (fromQuery) {
      els.input.value = fromQuery;
      loadSubreddit(applySortSettings(fromQuery));
    }
  })();
})();
