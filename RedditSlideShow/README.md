# Reddit Slideshow

A bookmarklet (and userscript) that turns a subreddit listing on `old.reddit.com` into an
image / GIF / video slideshow, injected directly into the page you're already on. No Reddit
API, no proxy, no backend.

## Why a bookmarklet instead of a website

reddit.com's edge actively rejects cross-site requests made by another website's JavaScript —
it inspects the `Sec-Fetch-Site`/`Origin` headers the browser itself attaches to any `fetch()`
a page makes to a different origin, and blocks or redirects it. That's not something a CORS
workaround, browser extension, or clever header trick can fix from a separate site, because the
browser sets those headers itself and no client-side code can remove or fake them.

Running the tool *on reddit.com's own page* sidesteps the problem entirely: there's no
cross-site request in the first place. `document` already *is* the fully-loaded listing page,
same-origin `fetch()` for pagination works normally, and the user's real logged-in session
(cookies included) applies — so NSFW and quarantined subreddits just work if the user is
logged in and opted in, with no cookie-injection hacks needed.

This project used to be a standalone site with its own subreddit-input box, fetching pages
through a chain of CORS proxies (public ones, plus an optional self-hosted Cloudflare Worker)
to get around exactly the block described above. That approach worked but was inherently
fragile — public proxies get rate-limited or blocked, and even the Worker was only ever a
workaround for a problem this architecture doesn't have. See git history for that version.

## Files

- **`inject.js`** — the entire tool. Extracts posts from the live page, builds a Shadow-DOM
  overlay UI, and runs the slideshow. This is the only file that matters functionally; the
  files below just get it loaded.
- **`vendor/hls.min.js`** — [hls.js](https://github.com/video-dev/hls.js), self-hosted (not a
  CDN dependency), for playing Reddit-hosted video with audio in non-Safari browsers.
- **`index.html` / `style.css`** — the install/landing page (this repo's GitHub Pages site),
  not part of the tool itself.
- **`bookmarklet.js`** — readable source for the bookmarklet; the actual bookmarklet on the
  install page is this same logic minified into a `javascript:` URI.
- **`reddit-slideshow.user.js`** — a Tampermonkey/Violentmonkey userscript that adds a small
  "▶ Slideshow" button to every `old.reddit.com/r/*` page, using the same loader logic.

Both the bookmarklet and the userscript do the same thing: load `vendor/hls.min.js` (if not
already loaded) via `<script src>`, then load `inject.js` the same way. Script tags aren't
subject to CORS regardless of origin — only reading a `fetch()`/`XHR` response body is — so
this works even though it's pulling from `charliemorris56.github.io` while running on
`old.reddit.com`. Everything else the tool does from that point on is same-origin.

## How extraction works

`extractItemsFromDoc(doc, baseUrl)` in `inject.js` walks every `.thing` element (Reddit's
per-post container in old.reddit's markup) and reads its `data-url` attribute:

- `.jpg/.jpeg/.png/.gif/.webp` → shown as an `<img>` (animated GIFs just play natively).
- imgur `.gifv` → rewritten to the equivalent `.mp4`, shown as a looping muted `<video>`.
- `v.redd.it` (no extension in its own `data-url`) → the real HLS manifest is pre-rendered,
  HTML-escaped *twice*, inside the post's sibling `.expando[data-cachedhtml]` attribute
  (old.reddit's mechanism for instant-expanding video without a request). `extractHlsUrl()`
  reads the attribute (browser undoes one escaping layer), then parses *that string* as HTML
  again to undo the second layer and land on a clean `.m3u8` URL, played via `hls.js`
  (Safari/iOS get native HLS, no library needed).
- `data-is-gallery="true"` → same `data-cachedhtml` mechanism, different contents: one
  `a.gallery-item-thumbnail-link[href]` per image, each already a full-size signed
  `preview.redd.it` URL. `extractGalleryImages()` reads them all; each becomes its own slide
  (tagged with `galleryId`/`galleryIndex`/`galleryTotal`) rather than a nested sub-slideshow.
- Anything else (text posts, link posts) is skipped.

This function takes a `Document`, not an HTML string, so the exact same code handles both the
initial scan (`document`, already live) and "Load more" pagination (a same-origin `fetch()` of
Reddit's own "next ›" link, parsed via `DOMParser`).

## UI

Built as a Shadow DOM overlay (`hostEl.attachShadow({ mode: "open" })`) so reddit's page CSS
can't leak in and the tool's CSS can't leak out. `:host { all: initial }` plus an explicit
reset on the shell wrapper guards against inherited properties (font, color) bleeding through
the shadow boundary, which Shadow DOM doesn't block by default (only *selector-based* rules are
scoped — inherited properties still cross it).

- **Prev / Next** — arrow buttons over the media, `←`/`→` keys, touch swipe. Keydown handling
  calls `stopPropagation()` so old.reddit's own `j`/`k`/arrow shortcuts don't also fire.
- **Autoplay** — range slider + synced editable number input, 2–15s, Space bar toggles it.
- **Fullscreen** — expands the media viewport via the Fullscreen API (works fine on a
  shadow-hosted element); a circular ✕ appears top-right, a duplicate "Skip gallery" button
  top-left when relevant, since the rest of the overlay chrome isn't visible in fullscreen.
- **Gallery badge / Skip gallery** — "🖼 Gallery N / M" badge while on a gallery slide; a
  button that jumps to the first slide whose `galleryId` differs from the current one.
- **Close (✕, top bar)** — tears the whole overlay down, stops autoplay, destroys any active
  `Hls` instance, exits fullscreen if active.

Re-triggering (bookmarklet clicked again, or the userscript's button clicked again) reopens an
already-built overlay via `window.__redditSlideshowToggle()` instead of rebuilding it, unless
it was closed first — closing fully tears down and resets `window.__redditSlideshowLoaded` so
the next trigger does a clean rebuild.

## Known limitations

- Only works on `old.reddit.com` listing pages — the extraction logic depends on markup
  (`.thing`, `data-cachedhtml`) that doesn't exist on the React-based `www.reddit.com`.
- Quarantined subreddits still need the user to be logged in and opted in on their real Reddit
  account — same as browsing reddit normally, no way around that from any tool.
- Bookmarklets are fiddly to install on mobile (no drag-and-drop) — see the install page for
  the workaround (bookmark any page, then edit its URL).
