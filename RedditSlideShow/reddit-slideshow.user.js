// ==UserScript==
// @name         Reddit Slideshow
// @namespace    https://charliemorris56.github.io/RedditSlideShow/
// @version      1.0.0
// @description  Turns a subreddit listing into an image/GIF/video slideshow, in place. Adds a small floating button; click it to launch.
// @author       Charlie Morris
// @match        https://old.reddit.com/r/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Auto-runs on old.reddit.com subreddit pages (Tampermonkey/Violentmonkey),
// but only ever adds a small floating trigger button — it never scrapes or
// opens the slideshow until you click it. Uses old.reddit.com specifically
// (not www.reddit.com) because the extraction logic in inject.js depends on
// markup (.thing, data-cachedhtml) that only exists on the server-rendered
// old.reddit pages, not the React-based www.reddit.com ones.
(function () {
  "use strict";

  var BASE = "https://charliemorris56.github.io/RedditSlideShow/";

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

  var btn = document.createElement("button");
  btn.textContent = "▶ Slideshow";
  btn.title = "Open Reddit Slideshow";
  btn.style.cssText =
    "position:fixed;bottom:16px;right:16px;z-index:2147483646;" +
    "background:#ff4500;color:#fff;border:none;border-radius:999px;" +
    "padding:0.6rem 1rem;font:600 0.85rem -apple-system,sans-serif;" +
    "cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.35);";
  btn.addEventListener("click", launch);
  document.body.appendChild(btn);
})();
