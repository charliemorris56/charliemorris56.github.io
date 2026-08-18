// ==UserScript==
// @name         Reddit Slideshow
// @namespace    https://charliemorris56.github.io/RedditSlideShow/
// @version      1.2.0
// @description  Turns a subreddit or user profile listing into an image/GIF/video slideshow, in place. Adds a small floating button; click it to launch. On www.reddit.com it instead hands you off to the old.reddit.com equivalent page, since extraction only works there. Auto-launches if the URL has ?slideshow=1 (set by the overlay's sort/search actions, or the www.reddit.com hand-off).
// @author       Charlie Morris
// @match        https://old.reddit.com/r/*
// @match        https://old.reddit.com/user/*
// @match        https://old.reddit.com/u/*
// @match        https://www.reddit.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Auto-runs on reddit pages (Tampermonkey/Violentmonkey), but only ever adds
// a small floating trigger button — it never scrapes or opens the slideshow
// until you click it. The extraction logic in inject.js depends on markup
// (.thing, data-cachedhtml) that only exists on the server-rendered
// old.reddit pages, not the React-based www.reddit.com ones — so on
// www.reddit.com the button just hands off to the old.reddit.com equivalent
// URL (carrying ?slideshow=1, so this same script auto-launches there the
// moment it lands) instead of trying to run inject.js in place.
(function () {
  "use strict";

  var BASE = "https://charliemorris56.github.io/RedditSlideShow/";
  var isOldReddit = location.hostname === "old.reddit.com";

  function loadScript(src, cb) {
    var s = document.createElement("script");
    s.src = src;
    s.onload = cb;
    document.body.appendChild(s);
  }

  function launch() {
    if (window.__redditSlideshowLoaded) {
      window.__redditSlideshowToggle(true);
      return;
    }
    function core() {
      loadScript(BASE + "inject.js?t=" + Date.now(), function () {});
    }
    if (window.Hls) core();
    else loadScript(BASE + "vendor/hls.min.js", core);
  }

  function goToOldReddit() {
    var params = new URLSearchParams(location.search);
    params.set("slideshow", "1");
    window.location.href = "https://old.reddit.com" + location.pathname + "?" + params.toString();
  }

  var btn = document.createElement("button");
  btn.textContent = "▶ Slideshow";
  btn.title = isOldReddit ? "Open Reddit Slideshow" : "Open this page on old.reddit.com and launch Reddit Slideshow";
  btn.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:2147483646;" +
    "background:#ff4500;color:#fff;border:none;border-radius:999px;" +
    "padding:0.6rem 1rem;font:600 0.85rem -apple-system,sans-serif;" +
    "cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.35);";
  btn.addEventListener("click", isOldReddit ? launch : goToOldReddit);
  document.body.appendChild(btn);

  // The overlay's sort/search actions, and this same script's own
  // www.reddit.com hand-off above, both link here with ?slideshow=1 so
  // arriving from there launches immediately instead of requiring the extra
  // tap on the floating button. Only this userscript can do that — a
  // bookmarklet can't act on a page it just navigated away from, and a plain
  // link has nothing on the destination page watching for the marker unless
  // this script is already installed and running. Only relevant on
  // old.reddit.com — the www.reddit.com branch above never sets this marker
  // on its own current URL, only on the page it's sending you to.
  if (isOldReddit && /[?&]slideshow=1(&|$)/.test(location.search)) {
    launch();
    if (window.history && window.history.replaceState) {
      var cleanUrl = location.pathname + location.search.replace(/[?&]slideshow=1/, "").replace(/^&/, "?") + location.hash;
      window.history.replaceState({}, "", cleanUrl);
    }
  }
})();
