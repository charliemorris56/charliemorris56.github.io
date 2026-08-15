// Reddit Slideshow — injected version.
//
// Loaded via a bookmarklet or userscript while already on a live
// old.reddit.com listing page. Everything here runs same-origin, in the
// context of that already-loaded page — there is no fetch() to a different
// origin anywhere in this file for the initial scan, which is the whole
// point: no CORS, no anti-scraping block, no proxy, no Worker. "Load more"
// pagination fetches the next listing page, but that's still a same-origin
// request (old.reddit.com fetching more of old.reddit.com), so it needs no
// special handling either.
//
// See extractHlsUrl()/extractGalleryImages() below for the one non-obvious
// part: video and gallery URLs aren't in the obvious place and need a
// double HTML-unescape to read out.

(() => {
  "use strict";

  // Re-running the loader (e.g. clicking the bookmarklet again) should just
  // reopen the existing overlay, not rebuild everything from scratch.
  if (window.__redditSlideshowLoaded) {
    window.__redditSlideshowToggle(true);
    return;
  }
  window.__redditSlideshowLoaded = true;

  const IMAGE_RE = /\.(jpe?g|png|gif|webp)(\?.*)?$/i;
  const GIFV_RE = /\.gifv(\?.*)?$/i;
  const REDDIT_VIDEO_RE = /^https?:\/\/v\.redd\.it\//i;

  // ---------- extraction (unchanged from the fetch-based version — it only
  // ever needed a Document to walk, and a live page IS one) ----------

  function extractMediaFromDataUrl(dataUrl) {
    if (!dataUrl) return null;
    if (IMAGE_RE.test(dataUrl)) return { type: "image", src: dataUrl };
    if (GIFV_RE.test(dataUrl)) return { type: "video", src: dataUrl.replace(GIFV_RE, ".mp4") };
    return null;
  }

  // On a subreddit listing page, video/gallery previews are collapsed —
  // their content only exists as the doubly-escaped data-cachedhtml string.
  // On a post's own comments page, that same content is already expanded
  // directly into the live DOM (no data-cachedhtml at all), so it has to be
  // read straight off `thing` first, falling back to the cachedhtml unwrap
  // only when nothing's there directly.
  function extractHlsUrl(thing) {
    const directEl = thing.querySelector("[data-hls-url]");
    if (directEl) return directEl.getAttribute("data-hls-url");

    const expando = thing.querySelector(".expando[data-cachedhtml]");
    const cached = expando ? expando.getAttribute("data-cachedhtml") : null;
    if (!cached) return null;
    const innerDoc = new DOMParser().parseFromString(cached, "text/html");
    const videoEl = innerDoc.querySelector("[data-hls-url]");
    return videoEl ? videoEl.getAttribute("data-hls-url") : null;
  }

  function extractGalleryImages(thing) {
    const direct = Array.from(thing.querySelectorAll("a.gallery-item-thumbnail-link[href]"))
      .map((a) => a.getAttribute("href"))
      .filter(Boolean);
    if (direct.length) return direct;

    const expando = thing.querySelector(".expando[data-cachedhtml]");
    const cached = expando ? expando.getAttribute("data-cachedhtml") : null;
    if (!cached) return [];
    const innerDoc = new DOMParser().parseFromString(cached, "text/html");
    return Array.from(innerDoc.querySelectorAll("a.gallery-item-thumbnail-link[href]"))
      .map((a) => a.getAttribute("href"))
      .filter(Boolean);
  }

  function extractItemsFromDoc(doc, baseUrl) {
    const things = Array.from(doc.querySelectorAll(".thing"));
    const items = [];
    const seen = new Set();

    for (const thing of things) {
      if (thing.classList.contains("promoted") || thing.classList.contains("stickied")) continue;
      const permalinkPath = thing.getAttribute("data-permalink");
      const title = thing.getAttribute("data-title") || "";
      const permalink = permalinkPath ? `https://old.reddit.com${permalinkPath}` : baseUrl;

      if (thing.getAttribute("data-is-gallery") === "true") {
        const images = extractGalleryImages(thing);
        const galleryId = thing.getAttribute("data-fullname") || permalinkPath;
        images.forEach((src, idx) => {
          if (seen.has(src)) return;
          seen.add(src);
          items.push({
            type: "image",
            src,
            title,
            permalink,
            galleryId,
            galleryIndex: idx + 1,
            galleryTotal: images.length,
          });
        });
        continue;
      }

      const dataUrl = thing.getAttribute("data-url");
      let media = extractMediaFromDataUrl(dataUrl);
      if (!media && dataUrl && REDDIT_VIDEO_RE.test(dataUrl)) {
        const hlsUrl = extractHlsUrl(thing);
        if (hlsUrl) media = { type: "hls", src: hlsUrl };
      }
      if (!media) continue;
      if (seen.has(media.src)) continue;
      seen.add(media.src);

      items.push({ type: media.type, src: media.src, title, permalink });
    }

    let nextPageUrl = null;
    const nextLink = doc.querySelector("span.next-button a");
    if (nextLink && nextLink.getAttribute("href")) nextPageUrl = nextLink.getAttribute("href");

    let subredditLabel = "";
    const nameEl = doc.querySelector("#header .redditname a, .redditname a");
    if (nameEl) subredditLabel = nameEl.textContent.trim();

    return { items, nextPageUrl, subredditLabel };
  }

  // ---------- overlay shell (Shadow DOM so reddit's own CSS can't leak in,
  // and ours can't leak out onto the rest of the page) ----------

  const CSS_TEXT = `
    :host { all: initial; }
    .shell {
      all: initial;
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      background: #0f1115;
      color: #e8eaed;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }
    .shell * { box-sizing: border-box; }
    .hidden { display: none !important; }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.6rem 1rem;
      background: #181b21;
      border-bottom: 1px solid #2a2e37;
    }
    .topbar .title { color: #ff4500; font-weight: 700; font-size: 1rem; }
    .close-btn {
      border: none; background: transparent; color: #e8eaed;
      font-size: 1.5rem; line-height: 1; cursor: pointer; padding: 0.2rem 0.5rem;
    }
    .close-btn:hover { color: #ff4500; }

    .status-area { padding: 1rem; color: #9aa0aa; font-size: 0.9rem; }
    .error-msg { color: #ff6b6b; font-weight: 600; }

    .spinner {
      margin: 2rem auto; width: 42px; height: 42px;
      border: 4px solid #2a2e37; border-top-color: #ff4500; border-radius: 50%;
      animation: rss-spin 0.8s linear infinite;
    }
    @keyframes rss-spin { to { transform: rotate(360deg); } }

    .slideshow { flex: 1; display: flex; flex-direction: column; padding: 0 1rem 1rem; min-height: 0; }

    .slideshow-header { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; padding: 0.5rem 0.25rem; }
    .sub-title { color: #ff4500; font-weight: 700; text-decoration: none; font-size: 1.05rem; }
    .sub-title:hover { text-decoration: underline; }
    .slide-counter { color: #9aa0aa; font-variant-numeric: tabular-nums; }
    .gallery-badge {
      padding: 0.2rem 0.55rem; border-radius: 999px; background: rgba(255,69,0,0.15);
      color: #ff4500; font-size: 0.8rem; font-weight: 600; white-space: nowrap;
    }
    .actions { display: flex; align-items: center; gap: 0.5rem; margin-left: auto; flex-wrap: wrap; }
    .actions button {
      padding: 0.55rem 1rem; border-radius: 6px; border: none; background: #ff4500;
      color: white; font-weight: 600; cursor: pointer; font-size: 0.9rem; white-space: nowrap;
    }
    .actions button:hover { background: #ff5e1f; }
    #skip-gallery-btn { background: #10131a; border: 1px solid #2a2e37; }
    #skip-gallery-btn:hover { border-color: #ff4500; background: #ff4500; }
    .speed-control { display: flex; align-items: center; gap: 0.4rem; }
    .speed-control input[type="range"] { accent-color: #ff4500; }
    .speed-number {
      width: 3.2rem; padding: 0.35rem 0.4rem; border-radius: 6px; border: 1px solid #2a2e37;
      background: #10131a; color: #e8eaed; font-size: 0.9rem; text-align: center;
    }
    .speed-unit { color: #9aa0aa; font-size: 0.85rem; }

    .media-viewport {
      position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
      background: #000; border-radius: 10px; overflow: hidden; border: 1px solid #2a2e37;
    }
    .media-container { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    .media-container img, .media-container video { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }

    .nav-arrow {
      position: absolute; top: 50%; transform: translateY(-50%); width: 44px; height: 44px;
      border-radius: 50%; border: none; background: rgba(0,0,0,0.45); color: white; font-size: 1.3rem;
      line-height: 1; cursor: pointer; z-index: 2; opacity: 0; display: flex; align-items: center;
      justify-content: center; transition: opacity 0.15s ease, background 0.15s ease;
    }
    .nav-arrow-left { left: 10px; }
    .nav-arrow-right { right: 10px; }
    .nav-arrow:hover { background: rgba(0,0,0,0.65); }
    .media-viewport:hover .nav-arrow, .nav-arrow:focus { opacity: 1; }

    .exit-fullscreen-btn {
      position: absolute; top: 14px; right: 14px; width: 40px; height: 40px; border-radius: 50%;
      border: none; background: rgba(0,0,0,0.45); color: white; font-size: 1.6rem; line-height: 1;
      cursor: pointer; z-index: 3; display: none; align-items: center; justify-content: center;
      transition: background 0.15s ease;
    }
    .exit-fullscreen-btn:hover { background: rgba(0,0,0,0.65); }
    .media-viewport:fullscreen .exit-fullscreen-btn { display: flex; }

    .skip-gallery-fs-btn {
      position: absolute; top: 14px; left: 14px; padding: 0.5rem 0.9rem; border-radius: 999px;
      border: none; background: rgba(0,0,0,0.55); color: white; font-weight: 600; font-size: 0.85rem;
      cursor: pointer; z-index: 3; display: none; transition: background 0.15s ease;
    }
    .skip-gallery-fs-btn:hover { background: rgba(0,0,0,0.75); }
    .media-viewport:fullscreen .skip-gallery-fs-btn:not(.hidden) { display: block; }

    .slideshow-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 0.25rem; flex-wrap: wrap; }
    .permalink { color: #9aa0aa; text-decoration: none; font-size: 0.85rem; }
    .permalink:hover { color: #e8eaed; }

    @media (max-width: 640px) {
      .actions { width: 100%; margin-left: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
      #autoplay-btn, .speed-control { grid-column: 1 / -1; width: 100%; }
      .speed-control input[type="range"] { flex: 1; }
      .actions button { width: 100%; }
      .nav-arrow { opacity: 1; }
      .slideshow-footer { flex-direction: column; align-items: stretch; gap: 0.5rem; }
      #load-more-btn { width: 100%; }
      .permalink { text-align: center; }
    }
  `;

  const HTML_TEMPLATE = `
    <div class="shell">
      <div class="topbar">
        <span class="title">Reddit Slideshow</span>
        <button id="close-btn" class="close-btn" title="Close" aria-label="Close">&times;</button>
      </div>
      <div id="status-area" class="status-area"></div>
      <div id="spinner" class="spinner hidden"></div>
      <section id="slideshow" class="slideshow hidden">
        <div class="slideshow-header">
          <a id="sub-title" class="sub-title" href="#" target="_blank" rel="noopener"></a>
          <span id="slide-counter" class="slide-counter"></span>
          <span id="gallery-badge" class="gallery-badge hidden"></span>
          <div class="actions">
            <button id="skip-gallery-btn" class="hidden" type="button" title="Skip to the next post">Skip gallery ⏭</button>
            <button id="autoplay-btn" type="button" title="Toggle autoplay">▶ Autoplay</button>
            <div class="speed-control">
              <input id="autoplay-speed" type="range" min="2" max="15" value="5" title="Autoplay interval (seconds)">
              <input id="autoplay-speed-number" type="number" min="2" max="15" step="1" value="5" title="Autoplay interval (seconds)" class="speed-number">
              <span class="speed-unit">s</span>
            </div>
            <button id="fullscreen-btn" type="button" title="Toggle fullscreen">⛶</button>
          </div>
        </div>
        <div class="media-viewport" id="media-viewport">
          <button id="prev-btn" class="nav-arrow nav-arrow-left" type="button" aria-label="Previous">&#10094;</button>
          <div id="media-container" class="media-container"></div>
          <button id="next-btn" class="nav-arrow nav-arrow-right" type="button" aria-label="Next">&#10095;</button>
          <button id="exit-fullscreen-btn" class="exit-fullscreen-btn" type="button" aria-label="Exit fullscreen" title="Exit fullscreen">&times;</button>
          <button id="skip-gallery-btn-fs" class="skip-gallery-fs-btn hidden" type="button" title="Skip to the next post">Skip gallery ⏭</button>
        </div>
        <div class="slideshow-footer">
          <a id="permalink" class="permalink" href="#" target="_blank" rel="noopener">View post on Reddit ↗</a>
          <button id="load-more-btn" class="hidden" type="button">Load more posts</button>
        </div>
      </section>
    </div>
  `;

  const hostEl = document.createElement("div");
  hostEl.id = "reddit-slideshow-host";
  document.documentElement.appendChild(hostEl);
  const shadow = hostEl.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${CSS_TEXT}</style>${HTML_TEMPLATE}`;

  const els = {
    shell: shadow.querySelector(".shell"),
    closeBtn: shadow.getElementById("close-btn"),
    status: shadow.getElementById("status-area"),
    spinner: shadow.getElementById("spinner"),
    slideshow: shadow.getElementById("slideshow"),
    subTitle: shadow.getElementById("sub-title"),
    counter: shadow.getElementById("slide-counter"),
    galleryBadge: shadow.getElementById("gallery-badge"),
    skipGalleryBtn: shadow.getElementById("skip-gallery-btn"),
    skipGalleryBtnFs: shadow.getElementById("skip-gallery-btn-fs"),
    mediaViewport: shadow.getElementById("media-viewport"),
    mediaContainer: shadow.getElementById("media-container"),
    prevBtn: shadow.getElementById("prev-btn"),
    nextBtn: shadow.getElementById("next-btn"),
    autoplayBtn: shadow.getElementById("autoplay-btn"),
    autoplaySpeed: shadow.getElementById("autoplay-speed"),
    autoplaySpeedNumber: shadow.getElementById("autoplay-speed-number"),
    fullscreenBtn: shadow.getElementById("fullscreen-btn"),
    exitFullscreenBtn: shadow.getElementById("exit-fullscreen-btn"),
    permalink: shadow.getElementById("permalink"),
    loadMoreBtn: shadow.getElementById("load-more-btn"),
  };

  const state = { items: [], currentIndex: 0, autoplayTimer: null, nextPageUrl: null, hls: null };

  // ---------- UI helpers (ported near-verbatim from the fetch-based version) ----------

  function setStatus(html, isError) {
    els.status.innerHTML = "";
    const p = document.createElement("p");
    p.className = isError ? "error-msg" : "";
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
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }

    const item = state.items[state.currentIndex];
    els.mediaContainer.innerHTML = "";
    if (!item) return;

    let el;
    if (item.type === "hls") {
      el = document.createElement("video");
      el.autoplay = true;
      el.loop = true;
      el.muted = true;
      el.playsInline = true;
      el.controls = true;
      if (window.Hls && window.Hls.isSupported()) {
        const hls = new window.Hls();
        hls.loadSource(item.src);
        hls.attachMedia(el);
        state.hls = hls;
      } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
        el.src = item.src;
      } else {
        skipBrokenSlide();
        return;
      }
    } else if (item.type === "video") {
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

    const inGallery = Boolean(item.galleryId);
    els.galleryBadge.classList.toggle("hidden", !inGallery);
    els.skipGalleryBtn.classList.toggle("hidden", !inGallery);
    els.skipGalleryBtnFs.classList.toggle("hidden", !inGallery);
    if (inGallery) {
      els.galleryBadge.textContent = `🖼 Gallery ${item.galleryIndex} / ${item.galleryTotal}`;
    }
  }

  function skipGallery() {
    const item = state.items[state.currentIndex];
    if (!item || !item.galleryId) return;
    let i = state.currentIndex;
    while (i < state.items.length && state.items[i].galleryId === item.galleryId) i++;
    state.currentIndex = i < state.items.length ? i : 0;
    renderSlide();
  }

  function skipBrokenSlide() {
    if (state.items.length <= 1) return;
    state.items.splice(state.currentIndex, 1);
    if (state.currentIndex >= state.items.length) state.currentIndex = 0;
    renderSlide();
  }

  function goTo(delta) {
    if (state.items.length === 0) return;
    state.currentIndex = (state.currentIndex + delta + state.items.length) % state.items.length;
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
    if (!document.fullscreenElement) els.mediaViewport.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  function clampSpeed(value) {
    const min = Number(els.autoplaySpeed.min);
    const max = Number(els.autoplaySpeed.max);
    let n = Math.round(Number(value));
    if (Number.isNaN(n)) n = min;
    return Math.min(max, Math.max(min, n));
  }

  // ---------- load flow ----------

  function loadFromCurrentPage() {
    state.items = [];
    state.currentIndex = 0;
    stopAutoplay();
    showSlideshow(false);
    setStatus("", false);

    const { items, nextPageUrl, subredditLabel } = extractItemsFromDoc(document, location.href);

    if (items.length === 0) {
      setStatus(
        "No image, GIF, video, or gallery posts found on this page. Make sure you're on a subreddit listing page (not a single post), and that it's finished loading.",
        true
      );
      return;
    }

    state.items = items;
    state.nextPageUrl = nextPageUrl;
    els.subTitle.textContent = subredditLabel ? `r/${subredditLabel}` : "Reddit";
    els.subTitle.href = location.href;
    showSlideshow(true);
    renderSlide();
  }

  async function loadMore() {
    if (!state.nextPageUrl) return;
    els.loadMoreBtn.disabled = true;
    els.loadMoreBtn.textContent = "Loading…";
    try {
      // Same-origin (we're running on old.reddit.com itself) — no proxy needed.
      const res = await fetch(state.nextPageUrl);
      const html = await res.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const { items, nextPageUrl } = extractItemsFromDoc(doc, state.nextPageUrl);
      const existing = new Set(state.items.map((i) => i.src));
      const fresh = items.filter((i) => !existing.has(i.src));
      state.items.push(...fresh);
      state.nextPageUrl = nextPageUrl;
      renderSlide();
    } catch (err) {
      setStatus("Failed to load more posts. Try again shortly.", true);
    } finally {
      els.loadMoreBtn.disabled = false;
      els.loadMoreBtn.textContent = "Load more posts";
    }
  }

  function closeOverlay() {
    stopAutoplay();
    if (state.hls) {
      state.hls.destroy();
      state.hls = null;
    }
    if (document.fullscreenElement) document.exitFullscreen?.();
    hostEl.remove();
    window.__redditSlideshowLoaded = false;
  }

  // ---------- events ----------

  els.closeBtn.addEventListener("click", closeOverlay);
  els.prevBtn.addEventListener("click", () => goTo(-1));
  els.nextBtn.addEventListener("click", () => goTo(1));
  els.skipGalleryBtn.addEventListener("click", skipGallery);
  els.skipGalleryBtnFs.addEventListener("click", skipGallery);
  els.autoplayBtn.addEventListener("click", toggleAutoplay);
  els.autoplaySpeed.addEventListener("input", () => {
    els.autoplaySpeedNumber.value = els.autoplaySpeed.value;
  });
  els.autoplaySpeed.addEventListener("change", () => {
    if (state.autoplayTimer) startAutoplay();
  });
  els.autoplaySpeedNumber.addEventListener("input", () => {
    els.autoplaySpeed.value = clampSpeed(els.autoplaySpeedNumber.value);
  });
  els.autoplaySpeedNumber.addEventListener("change", () => {
    els.autoplaySpeedNumber.value = clampSpeed(els.autoplaySpeedNumber.value);
    els.autoplaySpeed.value = els.autoplaySpeedNumber.value;
    if (state.autoplayTimer) startAutoplay();
  });
  els.fullscreenBtn.addEventListener("click", toggleFullscreen);
  els.exitFullscreenBtn.addEventListener("click", () => document.exitFullscreen?.());
  els.loadMoreBtn.addEventListener("click", loadMore);

  document.addEventListener("keydown", (e) => {
    if (!hostEl.isConnected || els.slideshow.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      closeOverlay();
      return;
    }
    if (e.key === "ArrowLeft") {
      goTo(-1);
    } else if (e.key === "ArrowRight") {
      goTo(1);
    } else if (e.key === " ") {
      e.preventDefault();
      toggleAutoplay();
    } else {
      return;
    }
    // Stop old.reddit's own keyboard-shortcut handlers (j/k/arrows) from
    // also reacting to the same keypress while our overlay is open.
    e.stopPropagation();
  });

  let touchStartX = null;
  els.mediaViewport.addEventListener("touchstart", (e) => {
    touchStartX = e.touches[0].clientX;
  });
  els.mediaViewport.addEventListener("touchend", (e) => {
    if (touchStartX === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) goTo(dx < 0 ? 1 : -1);
    touchStartX = null;
  });

  // Exposed so a re-triggered bookmarklet click, or a userscript's trigger
  // button, can reopen an already-built overlay instead of rebuilding it.
  window.__redditSlideshowToggle = (forceOpen) => {
    if (forceOpen || !hostEl.isConnected) {
      if (!hostEl.isConnected) document.documentElement.appendChild(hostEl);
      loadFromCurrentPage();
    } else {
      closeOverlay();
    }
  };

  loadFromCurrentPage();
})();
