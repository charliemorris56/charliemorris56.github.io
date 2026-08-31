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
  // RedGifs posts are outbound links, not native reddit video — reddit only
  // ever gives us an iframe pointing back at RedGifs (see extractItemsFromDoc
  // below for why we can't get a direct .mp4 URL client-side), so these are
  // rendered as an embedded RedGifs player rather than a <video> we control.
  const REDGIFS_RE = /^https?:\/\/(?:www\.)?redgifs\.com\/(?:watch|ifr)\/([a-z0-9]+)/i;

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
      // Permalinks are always /r/<subreddit>/comments/... regardless of which
      // listing page we scraped them from, so this is a reliable per-post
      // subreddit even on a /user/<name>/submitted page that spans many subs.
      const subredditMatch = permalinkPath ? permalinkPath.match(/^\/r\/([^/]+)\//i) : null;
      const subreddit = subredditMatch ? subredditMatch[1] : "";

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
            subreddit,
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
      if (!media && dataUrl) {
        const redgifsMatch = dataUrl.match(REDGIFS_RE);
        if (redgifsMatch) media = { type: "iframe", src: `https://www.redgifs.com/ifr/${redgifsMatch[1]}` };
      }
      if (!media) continue;
      if (seen.has(media.src)) continue;
      seen.add(media.src);

      items.push({ type: media.type, src: media.src, title, permalink, subreddit });
    }

    let nextPageUrl = null;
    const nextLink = doc.querySelector("span.next-button a");
    if (nextLink && nextLink.getAttribute("href")) nextPageUrl = nextLink.getAttribute("href");

    // Subreddit listings have a .redditname; user profiles (/user/<name>/…)
    // don't — they render the username in #header .pagename instead.
    let subredditLabel = "";
    const srNameEl = doc.querySelector("#header .redditname a, .redditname a");
    const userNameEl = doc.querySelector("#header .pagename");
    if (srNameEl) subredditLabel = `r/${srNameEl.textContent.trim()}`;
    else if (userNameEl) subredditLabel = `u/${userNameEl.textContent.trim()}`;

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
    .shell button, .shell a, .shell input, .shell select { touch-action: manipulation; }
    .hidden { display: none !important; }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: calc(0.6rem + env(safe-area-inset-top)) calc(1rem + env(safe-area-inset-right)) 0.6rem calc(1rem + env(safe-area-inset-left));
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

    .sort-control { position: relative; }
    .icon-btn {
      padding: 0.55rem 0.7rem; border-radius: 6px; border: 1px solid #2a2e37;
      background: #10131a; color: #e8eaed; cursor: pointer; font-size: 1.05rem; line-height: 1;
    }
    .icon-btn:hover { border-color: #ff4500; }
    .sort-panel {
      position: absolute; top: calc(100% + 0.5rem); left: 0; z-index: 10;
      display: flex; flex-direction: column; gap: 0.6rem; min-width: 180px;
      padding: 0.85rem; border-radius: 8px; background: #181b21; border: 1px solid #2a2e37;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .sort-panel label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.8rem; color: #9aa0aa; }
    .sort-panel select {
      padding: 0.4rem 0.5rem; border-radius: 6px; border: 1px solid #2a2e37;
      background: #10131a; color: #e8eaed; font-size: 0.9rem;
    }
    .sort-go-btn {
      padding: 0.5rem 1rem; border-radius: 6px; border: none; background: #ff4500;
      color: white; font-weight: 600; cursor: pointer; font-size: 0.9rem;
    }
    .sort-go-btn:hover { background: #ff5e1f; }
    .sort-panel-hint { margin: 0; font-size: 0.72rem; color: #9aa0aa; max-width: 22ch; }

    .search-control { position: relative; }
    .search-panel {
      position: absolute; top: calc(100% + 0.5rem); right: 0; z-index: 10;
      display: flex; flex-direction: column; gap: 0.6rem; width: 280px; max-width: 80vw;
      padding: 0.85rem; border-radius: 8px; background: #181b21; border: 1px solid #2a2e37;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .search-input {
      padding: 0.5rem 0.6rem; border-radius: 6px; border: 1px solid #2a2e37;
      background: #10131a; color: #e8eaed; font-size: 0.9rem; width: 100%;
    }
    .search-input:focus { outline: 2px solid #ff4500; }
    .search-strict-label {
      display: flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; color: #9aa0aa;
      cursor: pointer; user-select: none;
    }
    .search-strict-label input[type="checkbox"] { accent-color: #ff4500; margin: 0; }
    .search-results { display: flex; flex-direction: column; gap: 0.3rem; max-height: 260px; overflow-y: auto; }
    .search-result-item {
      display: flex; align-items: center; justify-content: space-between; gap: 0.5rem;
      padding: 0.5rem 0.6rem; border-radius: 6px; border: 1px solid #2a2e37; background: #10131a;
      color: #e8eaed; cursor: pointer; font-size: 0.85rem; text-align: left;
    }
    .search-result-item:hover { border-color: #ff4500; }
    .sr-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sr-subs { color: #9aa0aa; font-size: 0.78rem; white-space: nowrap; }
    .search-empty { margin: 0; font-size: 0.8rem; color: #9aa0aa; }

    .media-viewport {
      position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center;
      background: #000; border-radius: 10px; overflow: hidden; border: 1px solid #2a2e37;
      touch-action: pan-y;
    }
    .media-container { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
    .media-container img, .media-container video { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
    .media-container iframe { width: 100%; height: 100%; border: 0; display: block; }

    .nav-arrow {
      position: absolute; top: 50%; transform: translateY(-50%); width: 44px; height: 44px;
      border-radius: 50%; border: none; background: rgba(0,0,0,0.45); color: white; font-size: 1.3rem;
      line-height: 1; cursor: pointer; z-index: 2; opacity: 1; display: flex; align-items: center;
      justify-content: center; transition: background 0.15s ease;
    }
    .nav-arrow-left { left: 10px; }
    .nav-arrow-right { right: 10px; }
    .nav-arrow:hover { background: rgba(0,0,0,0.65); }

    .exit-fullscreen-btn {
      position: absolute; top: calc(14px + env(safe-area-inset-top)); right: calc(14px + env(safe-area-inset-right));
      width: 40px; height: 40px; border-radius: 50%;
      border: none; background: rgba(0,0,0,0.45); color: white; font-size: 1.6rem; line-height: 1;
      cursor: pointer; z-index: 3; display: none; align-items: center; justify-content: center;
      transition: background 0.15s ease;
    }
    .exit-fullscreen-btn:hover { background: rgba(0,0,0,0.65); }
    .media-viewport:fullscreen .exit-fullscreen-btn { display: flex; }

    .skip-gallery-fs-btn {
      position: absolute; top: calc(14px + env(safe-area-inset-top)); left: calc(14px + env(safe-area-inset-left));
      padding: 0.5rem 0.9rem; border-radius: 999px;
      border: none; background: rgba(0,0,0,0.55); color: white; font-weight: 600; font-size: 0.85rem;
      cursor: pointer; z-index: 3; display: none; transition: background 0.15s ease;
    }
    .skip-gallery-fs-btn:hover { background: rgba(0,0,0,0.75); }
    .media-viewport:fullscreen .skip-gallery-fs-btn:not(.hidden) { display: block; }

    .permalink-fs {
      position: absolute; bottom: calc(14px + env(safe-area-inset-bottom)); right: calc(14px + env(safe-area-inset-right));
      padding: 0.5rem 0.9rem; border-radius: 999px;
      background: rgba(0,0,0,0.55); color: white; font-weight: 600; font-size: 0.85rem;
      text-decoration: none; z-index: 3; display: none; transition: background 0.15s ease;
    }
    .permalink-fs:hover { background: rgba(0,0,0,0.75); }
    .media-viewport:fullscreen .permalink-fs { display: block; }

    .post-title-fs {
      position: absolute; bottom: calc(14px + env(safe-area-inset-bottom)); left: calc(14px + env(safe-area-inset-left));
      max-width: min(60%, 420px); padding: 0.5rem 0.9rem; border-radius: 999px;
      background: rgba(0,0,0,0.55); color: white; font-weight: 600; font-size: 0.85rem;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; z-index: 3; display: none;
    }
    .media-viewport:fullscreen .post-title-fs { display: block; }

    .slideshow-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.75rem 0.25rem; flex-wrap: wrap; }
    .post-info { display: flex; align-items: center; gap: 0.6rem; min-width: 0; flex: 1; }
    .post-title {
      color: #e8eaed; font-size: 0.85rem; font-weight: 600; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; min-width: 0;
    }
    .permalink { color: #9aa0aa; text-decoration: none; font-size: 0.85rem; white-space: nowrap; }
    .permalink:hover { color: #e8eaed; }

    /* old.reddit.com ships <meta name="viewport" content="width=1024"> — it
       deliberately forces a fixed desktop-width layout viewport on every
       mobile browser, so max-width here would never match a real phone
       (its window.innerWidth genuinely is ~1024, not the physical screen
       width). max-device-width reads the physical screen instead, so it
       still fires regardless of the host page's viewport meta. Kept
       alongside max-width so this still behaves normally on pages (like
       the landing page) that use a proper width=device-width viewport. */
    @media (max-width: 640px), (max-device-width: 640px) {
      .close-btn { min-width: 48px; min-height: 48px; padding: 0.3rem 0.6rem; font-size: 1.7rem; }
      .actions { width: 100%; margin-left: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 0.6rem; }
      /* Explicit pairing regardless of markup order: search+sort, then
         autoplay+speed, then skip gallery+fullscreen. skip-gallery-btn is
         hidden outside galleries, so when absent fullscreen just ends up
         alone in its row instead of paired. */
      .search-control { order: 1; }
      .sort-control { order: 2; }
      #autoplay-btn { order: 3; }
      .speed-control { order: 4; width: 100%; min-height: 48px; }
      #skip-gallery-btn { order: 5; }
      #fullscreen-btn { order: 6; }
      .speed-control input[type="range"] { flex: 1; height: 32px; }
      .speed-number { width: 3.8rem; padding: 0.6rem 0.5rem; font-size: 1rem; }
      .actions button { width: 100%; min-height: 48px; padding: 0.75rem 1rem; font-size: 1rem; }
      .sort-control .icon-btn, .search-control .icon-btn { width: 100%; min-height: 48px; font-size: 1.2rem; }
      .sort-panel, .search-panel { left: 0; right: 0; width: auto; min-width: 0; max-width: none; }
      .sort-panel select { min-height: 46px; font-size: 1rem; }
      .sort-go-btn { min-height: 46px; font-size: 1rem; }
      .search-input { min-height: 46px; font-size: 1rem; }
      .search-result-item { min-height: 48px; font-size: 0.9rem; }
      .nav-arrow { width: 52px; height: 52px; font-size: 1.5rem; }
      .nav-arrow-left { left: 8px; }
      .nav-arrow-right { right: 8px; }
      .exit-fullscreen-btn { width: 48px; height: 48px; font-size: 1.8rem; }
      .skip-gallery-fs-btn, .permalink-fs, .post-title-fs { padding: 0.75rem 1rem; font-size: 0.85rem; }
      .post-title-fs { max-width: 50%; }
      .slideshow-footer { flex-direction: column; align-items: stretch; gap: 0.6rem; }
      #load-more-btn { width: 100%; min-height: 48px; font-size: 1rem; }
      .post-info { flex-direction: column; gap: 0.2rem; width: 100%; text-align: center; }
      .post-title { white-space: normal; max-height: 2.8em; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .permalink { min-height: 44px; display: flex; align-items: center; justify-content: center; }
      .slideshow { padding: 0 0.6rem 0.6rem; }
      .slideshow-header { gap: 0.5rem; padding: 0.4rem 0.15rem; }
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
            <div class="search-control">
              <button type="button" id="search-toggle-btn" class="icon-btn" title="Search subreddits" aria-haspopup="true" aria-expanded="false">&#128269;</button>
              <div id="search-panel" class="search-panel hidden">
                <input type="text" id="search-input" class="search-input" placeholder="Search subreddits…" autocomplete="off">
                <label class="search-strict-label">
                  <input type="checkbox" id="search-strict" checked>
                  Strict (name must contain search)
                </label>
                <div id="search-results" class="search-results"></div>
              </div>
            </div>
            <div class="sort-control">
              <button type="button" id="sort-toggle-btn" class="icon-btn" title="Sort settings" aria-haspopup="true" aria-expanded="false">&#9881;</button>
              <div id="sort-panel" class="sort-panel hidden">
                <label>
                  Sort
                  <select id="sort-select">
                    <option value="hot">Hot</option>
                    <option value="new">New</option>
                    <option value="rising">Rising</option>
                    <option value="controversial">Controversial</option>
                    <option value="top">Top</option>
                  </select>
                </label>
                <label id="time-label">
                  Time
                  <select id="time-select">
                    <option value="hour">Hour</option>
                    <option value="day">Day</option>
                    <option value="week">Week</option>
                    <option value="month">Month</option>
                    <option value="year">Year</option>
                    <option value="all">All time</option>
                  </select>
                </label>
                <button type="button" id="sort-go-btn" class="sort-go-btn">Go</button>
                <p class="sort-panel-hint">Reloads the page with the new sort.</p>
              </div>
            </div>
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
          <span id="post-title-fs" class="post-title-fs"></span>
          <a id="permalink-fs" class="permalink-fs" href="#" target="_blank" rel="noopener" title="View post on Reddit">View on Reddit ↗</a>
        </div>
        <div class="slideshow-footer">
          <div class="post-info">
            <span id="post-title" class="post-title"></span>
            <a id="permalink" class="permalink" href="#" target="_blank" rel="noopener">View post on Reddit ↗</a>
          </div>
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
    postTitle: shadow.getElementById("post-title"),
    permalink: shadow.getElementById("permalink"),
    permalinkFs: shadow.getElementById("permalink-fs"),
    postTitleFs: shadow.getElementById("post-title-fs"),
    loadMoreBtn: shadow.getElementById("load-more-btn"),
    sortToggleBtn: shadow.getElementById("sort-toggle-btn"),
    sortPanel: shadow.getElementById("sort-panel"),
    sortSelect: shadow.getElementById("sort-select"),
    timeLabel: shadow.getElementById("time-label"),
    timeSelect: shadow.getElementById("time-select"),
    sortGoBtn: shadow.getElementById("sort-go-btn"),
    searchToggleBtn: shadow.getElementById("search-toggle-btn"),
    searchPanel: shadow.getElementById("search-panel"),
    searchInput: shadow.getElementById("search-input"),
    searchStrict: shadow.getElementById("search-strict"),
    searchResults: shadow.getElementById("search-results"),
  };

  const state = {
    items: [],
    currentIndex: 0,
    autoplayActive: false,
    autoplayTimeoutId: null,
    autoplayEndedEl: null,
    autoplayEndedHandler: null,
    nextPageUrl: null,
    hls: null,
  };

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
    clearAutoplayAdvance();

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
    } else if (item.type === "iframe") {
      // RedGifs: no direct .mp4 URL is reachable client-side (their info API
      // is CORS-locked to redgifs.com origins), so this embeds their own
      // player instead. It has its own autoplay/mute/loop, and no "ended"
      // event we can see from outside the iframe, so autoplay-wait-for-finish
      // falls back to the fixed-delay timer for these, same as static GIFs.
      el = document.createElement("iframe");
      el.src = item.src;
      el.frameBorder = "0";
      el.allow = "autoplay; fullscreen";
      el.allowFullscreen = true;
      el.referrerPolicy = "no-referrer";
    } else {
      el = document.createElement("img");
      el.src = item.src;
      el.alt = item.title || "";
      el.loading = "eager";
      el.onerror = () => skipBrokenSlide();
    }
    els.mediaContainer.appendChild(el);

    els.counter.textContent = `${state.currentIndex + 1} / ${state.items.length}`;
    const displayTitle = item.subreddit ? `r/${item.subreddit} — ${item.title || ""}` : item.title || "";
    els.postTitle.textContent = displayTitle;
    els.postTitle.title = displayTitle;
    els.postTitleFs.textContent = displayTitle;
    els.postTitleFs.title = displayTitle;
    els.permalink.href = item.permalink;
    els.permalinkFs.href = item.permalink;
    els.loadMoreBtn.classList.toggle("hidden", !state.nextPageUrl);

    const inGallery = Boolean(item.galleryId);
    els.galleryBadge.classList.toggle("hidden", !inGallery);
    els.skipGalleryBtn.classList.toggle("hidden", !inGallery);
    els.skipGalleryBtnFs.classList.toggle("hidden", !inGallery);
    if (inGallery) {
      els.galleryBadge.textContent = `🖼 Gallery ${item.galleryIndex} / ${item.galleryTotal}`;
    }

    scheduleAutoplayAdvance();
    preloadUpcoming();
  }

  // Warms the browser's own cache for the next couple of image slides so
  // Next/autoplay shows them instantly instead of popping in a blank frame.
  function preloadUpcoming() {
    if (state.items.length < 2) return;
    for (let offset = 1; offset <= 2; offset++) {
      const upcoming = state.items[(state.currentIndex + offset) % state.items.length];
      if (upcoming && upcoming.type === "image") {
        const img = new Image();
        img.src = upcoming.src;
      }
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

  // Cancels whatever's currently scheduled to advance the slide — either the
  // fixed-delay timer (images/gifs) or the "wait for this video to finish"
  // listener (video/hls) — without touching state.autoplayActive itself.
  // Always safe to call, including when nothing is scheduled.
  function clearAutoplayAdvance() {
    if (state.autoplayTimeoutId) {
      clearTimeout(state.autoplayTimeoutId);
      state.autoplayTimeoutId = null;
    }
    if (state.autoplayEndedEl && state.autoplayEndedHandler) {
      state.autoplayEndedEl.removeEventListener("ended", state.autoplayEndedHandler);
    }
    state.autoplayEndedEl = null;
    state.autoplayEndedHandler = null;
  }

  // On a video/hls slide, autoplay waits for the clip to actually finish
  // (loop is turned off for this) instead of advancing after a fixed delay —
  // static images and actual animated .gif files still use the fixed delay,
  // since <img> exposes no "this GIF finished playing" signal at all to
  // hook into. A generous backup timeout guards against autoplay getting
  // permanently stuck if a video stalls or never fires "ended".
  function scheduleAutoplayAdvance() {
    clearAutoplayAdvance();
    if (!state.autoplayActive) return;

    const item = state.items[state.currentIndex];
    const videoEl = els.mediaContainer.querySelector("video");

    if (item && (item.type === "video" || item.type === "hls") && videoEl) {
      videoEl.loop = false;
      const advance = () => {
        clearAutoplayAdvance();
        goTo(1);
      };
      videoEl.addEventListener("ended", advance);
      state.autoplayEndedEl = videoEl;
      state.autoplayEndedHandler = advance;
      state.autoplayTimeoutId = setTimeout(advance, 120000);
    } else {
      const seconds = Number(els.autoplaySpeed.value) || 5;
      state.autoplayTimeoutId = setTimeout(() => goTo(1), seconds * 1000);
    }
  }

  function stopAutoplay() {
    state.autoplayActive = false;
    clearAutoplayAdvance();
    els.autoplayBtn.textContent = "▶ Autoplay";
  }

  function startAutoplay() {
    state.autoplayActive = true;
    els.autoplayBtn.textContent = "⏸ Pause";
    scheduleAutoplayAdvance();
  }

  function toggleAutoplay() {
    if (state.autoplayActive) stopAutoplay();
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
        "No image, GIF, video, or gallery posts found on this page. Make sure you're on a subreddit or user profile listing page (not a single post), and that it's finished loading.",
        true
      );
      return;
    }

    state.items = items;
    state.nextPageUrl = nextPageUrl;
    els.subTitle.textContent = subredditLabel || "Reddit";
    els.subTitle.href = location.href;
    syncSortControlsFromLocation();
    showSlideshow(true);
    renderSlide();
  }

  // Subreddits put sort in the path (/r/pics/top/); user profiles put it in
  // a query param (/user/name/submitted/?sort=top) instead — there's no
  // per-sort path for profiles. Everything below branches on this.
  function currentContext() {
    const subMatch = location.pathname.match(/^\/r\/([^/]+)/i);
    if (subMatch) return { kind: "subreddit", name: subMatch[1] };
    const userMatch = location.pathname.match(/^\/u(?:ser)?\/([^/]+)/i);
    if (userMatch) return { kind: "user", name: userMatch[1] };
    return null;
  }

  function updateTimeVisibility() {
    const show = els.sortSelect.value === "top" || els.sortSelect.value === "controversial";
    els.timeLabel.classList.toggle("hidden", !show);
  }

  // Reflects whatever sort/time the current URL actually is, so opening the
  // cog shows the truth rather than always defaulting to Hot.
  function syncSortControlsFromLocation() {
    const ctx = currentContext();
    if (ctx && ctx.kind === "subreddit") {
      const sortMatch = location.pathname.match(/^\/r\/[^/]+\/(hot|new|rising|controversial|top)\b/i);
      els.sortSelect.value = sortMatch ? sortMatch[1].toLowerCase() : "hot";
    } else {
      const params = new URLSearchParams(location.search);
      const sort = (params.get("sort") || "hot").toLowerCase();
      els.sortSelect.value = ["hot", "new", "rising", "controversial", "top"].includes(sort) ? sort : "hot";
    }
    const params = new URLSearchParams(location.search);
    if (params.has("t")) els.timeSelect.value = params.get("t");
    updateTimeVisibility();
  }

  function openSortPanel() {
    els.sortPanel.classList.remove("hidden");
    els.sortToggleBtn.setAttribute("aria-expanded", "true");
  }
  function closeSortPanel() {
    els.sortPanel.classList.add("hidden");
    els.sortToggleBtn.setAttribute("aria-expanded", "false");
  }

  function openSearchPanel() {
    els.searchPanel.classList.remove("hidden");
    els.searchToggleBtn.setAttribute("aria-expanded", "true");
    els.searchInput.focus();
  }
  function closeSearchPanel() {
    els.searchPanel.classList.add("hidden");
    els.searchToggleBtn.setAttribute("aria-expanded", "false");
  }

  function formatSubscribers(n) {
    if (typeof n !== "number") return "";
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  function renderSearchResults(subs) {
    els.searchResults.innerHTML = "";
    if (!subs.length) {
      els.searchResults.innerHTML = '<p class="search-empty">No subreddits found.</p>';
      return;
    }
    subs.forEach((sr) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "search-result-item";
      btn.innerHTML =
        `<span class="sr-name">r/${sr.display_name}</span>` +
        `<span class="sr-subs">${formatSubscribers(sr.subscribers)} members</span>`;
      btn.addEventListener("click", () => {
        window.location.href = `https://old.reddit.com/r/${encodeURIComponent(sr.display_name)}/hot/?slideshow=1`;
      });
      els.searchResults.appendChild(btn);
    });
  }

  let searchAbortController = null;
  let searchDebounceId = null;

  // search_reddit_names.json substring-matches the subreddit *name* itself
  // (confirmed: query=ota returns DotA2, which the relevance search below
  // never does) but hard-caps at exactly 10 results no matter the query —
  // confirmed against "cat"/"pic"/"game", all capped at 10 with no limit
  // param honored — so on any broad query it silently drops most matches
  // (74 unique name-matching subs actually exist for "cat"; this endpoint
  // alone surfaces 10 of them). Recovered by also running
  // subreddits/search.json (relevance search, but accepts limit=100 and
  // returns full subscriber data already attached) and keeping only the
  // results that are themselves a name substring match. Whatever
  // search_reddit_names.json found that ISN'T already covered by that gets
  // its subscriber count filled in via one batched /api/info.json call.
  async function strictSubredditSearch(query, signal) {
    const needle = query.toLowerCase();
    const [namesRes, relRes] = await Promise.all([
      fetch(
        `https://old.reddit.com/api/search_reddit_names.json?query=${encodeURIComponent(query)}&include_over_18=true&exact=false`,
        { signal }
      ),
      fetch(
        `https://old.reddit.com/subreddits/search.json?q=${encodeURIComponent(query)}&limit=100&include_over_18=on`,
        { signal }
      ),
    ]);
    if (!namesRes.ok || !relRes.ok) throw new Error("search failed");
    const namesData = await namesRes.json();
    const relData = await relRes.json();

    const relMatches = (relData && relData.data && relData.data.children ? relData.data.children : [])
      .map((c) => c.data)
      .filter((d) => d && d.display_name && d.display_name.toLowerCase().includes(needle));

    const covered = new Set(relMatches.map((d) => d.display_name.toLowerCase()));
    const names = (namesData && namesData.names) || [];
    const extraNames = names.filter((n) => !covered.has(n.toLowerCase()));

    let extraSubs = [];
    if (extraNames.length) {
      const infoRes = await fetch(
        `https://old.reddit.com/api/info.json?sr_name=${encodeURIComponent(extraNames.join(","))}`,
        { signal }
      );
      if (infoRes.ok) {
        const infoData = await infoRes.json();
        extraSubs = (infoData && infoData.data && infoData.data.children ? infoData.data.children : []).map((c) => c.data);
      }
    }

    return [...relMatches, ...extraSubs];
  }

  // Both search endpoints above can omit a subreddit even when the query IS
  // its exact literal name — confirmed against a real, large, non-quarantined
  // restricted subreddit whose name neither subreddits/search.json nor
  // search_reddit_names.json returned at all for a query matching it
  // exactly, even though a direct /api/info.json?sr_name=<name> lookup finds
  // it instantly. Reddit's search index itself appears to suppress certain
  // high-profile restricted communities from search while still serving
  // them by direct name — include_over_18 doesn't affect this, it's not a
  // login/session thing either (tested logged out; info.json still returned
  // full data). So: whenever the typed query isn't already an exact name
  // match in what search returned, try a direct name lookup and splice it in.
  async function ensureExactMatch(query, subs, signal) {
    const needle = query.toLowerCase();
    if (subs.some((d) => d.display_name.toLowerCase() === needle)) return subs;
    try {
      const res = await fetch(`https://old.reddit.com/api/info.json?sr_name=${encodeURIComponent(query)}`, { signal });
      if (!res.ok) return subs;
      const data = await res.json();
      const exact = ((data && data.data && data.data.children) || []).map((c) => c.data)[0];
      if (exact && exact.display_name) return [exact, ...subs];
    } catch (err) {
      // Best-effort — a failed fallback lookup shouldn't break the rest of
      // the results that already came back fine.
    }
    return subs;
  }

  // Same-origin fetch (we're running on old.reddit.com itself) — the same
  // reason loadMore() above needs no proxy. This is why subreddit search
  // has to live inside the injected overlay rather than on the landing
  // page: reddit.com won't answer this request cross-origin.
  async function runSubredditSearch(rawQuery) {
    if (searchAbortController) searchAbortController.abort();
    const query = rawQuery.trim().replace(/^\/?r\//i, "");
    if (!query || query.length < 2) {
      els.searchResults.innerHTML = "";
      return;
    }
    searchAbortController = new AbortController();
    const signal = searchAbortController.signal;
    els.searchResults.innerHTML = '<p class="search-empty">Searching…</p>';
    try {
      let subs;
      if (els.searchStrict.checked) {
        subs = await strictSubredditSearch(query, signal);
      } else {
        // include_over_18=on: without it reddit silently drops restricted
        // subreddits from results regardless of the account's own content
        // prefs.
        const res = await fetch(
          `https://old.reddit.com/subreddits/search.json?q=${encodeURIComponent(query)}&limit=25&include_over_18=on`,
          { signal }
        );
        if (!res.ok) throw new Error("search failed");
        const data = await res.json();
        subs = (data && data.data && data.data.children ? data.data.children : []).map((c) => c.data);
      }
      subs = subs.filter((d) => d && d.display_name);
      subs = await ensureExactMatch(query, subs, signal);
      const needle = query.toLowerCase();
      subs.sort((a, b) => {
        const aExact = a.display_name.toLowerCase() === needle;
        const bExact = b.display_name.toLowerCase() === needle;
        if (aExact !== bExact) return aExact ? -1 : 1;
        return (b.subscribers || 0) - (a.subscribers || 0);
      });
      renderSearchResults(subs);
    } catch (err) {
      if (err.name === "AbortError") return;
      els.searchResults.innerHTML = '<p class="search-empty">Search failed. Try again.</p>';
    }
  }

  // "It's ok if it just refreshes the page" — so this is a plain navigation,
  // not an in-place re-scan. Carries the slideshow=1 marker so the
  // userscript (if installed) auto-relaunches after the reload instead of
  // requiring another manual tap; bookmarklet users just need to re-click it.
  function applySortChange() {
    const ctx = currentContext();
    if (!ctx) return;
    const sort = els.sortSelect.value;
    const params = [];
    if (ctx.kind === "user") params.push(`sort=${sort}`);
    if (sort === "top" || sort === "controversial") params.push(`t=${els.timeSelect.value}`);
    params.push("slideshow=1");
    const url =
      ctx.kind === "subreddit"
        ? `https://old.reddit.com/r/${ctx.name}/${sort}/?${params.join("&")}`
        : `https://old.reddit.com/user/${ctx.name}/submitted/?${params.join("&")}`;
    window.location.href = url;
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
  els.sortToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (els.sortPanel.classList.contains("hidden")) {
      closeSearchPanel();
      openSortPanel();
    } else closeSortPanel();
  });
  els.sortPanel.addEventListener("click", (e) => e.stopPropagation());
  els.sortSelect.addEventListener("change", updateTimeVisibility);
  els.sortGoBtn.addEventListener("click", applySortChange);
  els.searchToggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (els.searchPanel.classList.contains("hidden")) {
      closeSortPanel();
      openSearchPanel();
    } else closeSearchPanel();
  });
  els.searchPanel.addEventListener("click", (e) => e.stopPropagation());
  els.searchInput.addEventListener("input", () => {
    clearTimeout(searchDebounceId);
    const query = els.searchInput.value.trim();
    searchDebounceId = setTimeout(() => runSubredditSearch(query), 350);
  });
  els.searchStrict.addEventListener("change", () => {
    runSubredditSearch(els.searchInput.value.trim());
  });
  shadow.addEventListener("click", () => {
    closeSortPanel();
    closeSearchPanel();
  });
  els.prevBtn.addEventListener("click", () => goTo(-1));
  els.nextBtn.addEventListener("click", () => goTo(1));
  els.skipGalleryBtn.addEventListener("click", skipGallery);
  els.skipGalleryBtnFs.addEventListener("click", skipGallery);
  els.autoplayBtn.addEventListener("click", toggleAutoplay);
  els.autoplaySpeed.addEventListener("input", () => {
    els.autoplaySpeedNumber.value = els.autoplaySpeed.value;
  });
  els.autoplaySpeed.addEventListener("change", () => {
    if (state.autoplayActive) scheduleAutoplayAdvance();
  });
  els.autoplaySpeedNumber.addEventListener("input", () => {
    els.autoplaySpeed.value = clampSpeed(els.autoplaySpeedNumber.value);
  });
  els.autoplaySpeedNumber.addEventListener("change", () => {
    els.autoplaySpeedNumber.value = clampSpeed(els.autoplaySpeedNumber.value);
    els.autoplaySpeed.value = els.autoplaySpeedNumber.value;
    if (state.autoplayActive) scheduleAutoplayAdvance();
  });
  els.fullscreenBtn.addEventListener("click", toggleFullscreen);
  els.exitFullscreenBtn.addEventListener("click", () => document.exitFullscreen?.());
  els.loadMoreBtn.addEventListener("click", loadMore);

  document.addEventListener("keydown", (e) => {
    if (!hostEl.isConnected || els.slideshow.classList.contains("hidden")) return;
    if (e.key === "Escape") {
      if (!els.sortPanel.classList.contains("hidden")) closeSortPanel();
      else if (!els.searchPanel.classList.contains("hidden")) closeSearchPanel();
      else closeOverlay();
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
