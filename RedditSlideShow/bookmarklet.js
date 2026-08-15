// Readable source for the bookmarklet. The actual bookmarklet (on the
// install page, index.html) is this same logic minified into a single
// `javascript:` URI — regenerate it there if this file changes.
//
// Deliberately tiny: it only ever loads two files from GitHub Pages
// (hls.js, then inject.js) via <script src>, which is not subject to CORS
// (script loading never is — only fetch()/XHR response reading is). All the
// real logic lives in inject.js, so it can be updated without anyone
// needing to redo their bookmark.
(function () {
  var BASE = "https://charliemorris56.github.io/RedditSlideShow/";

  function loadScript(src, cb) {
    var s = document.createElement("script");
    s.src = src;
    s.onload = cb;
    s.onerror = function () {
      alert("Reddit Slideshow: failed to load " + src);
    };
    document.body.appendChild(s);
  }

  if (window.__redditSlideshowLoaded) {
    window.__redditSlideshowToggle(true);
    return;
  }

  function loadCore() {
    loadScript(BASE + "inject.js?t=" + Date.now(), function () {});
  }

  if (window.Hls) {
    loadCore();
  } else {
    loadScript(BASE + "vendor/hls.min.js", loadCore);
  }
})();
