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
(cookies included) applies — so quarantined subreddits just work if the user is
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

### Quick open

`index.html` has a small subreddit/sort/time form ("Quick open") that builds a URL like
`https://old.reddit.com/r/memes/top/?t=week&slideshow=1` and navigates there. The `slideshow=1`
marker only matters if `reddit-slideshow.user.js` is already installed: on `document-idle` it
checks `location.search` for that marker and calls `launch()` immediately instead of waiting for
the floating button to be clicked, then strips the marker via `history.replaceState` so it
doesn't linger in the address bar. This is the *only* way to get a "type it on this site, land
already in the slideshow" experience — a plain link can't trigger anything on the page it
navigates to, and a bookmarklet's execution ends the moment it navigates away, so only something
already running persistently on every reddit page load (i.e. the userscript) can react to the
marker. Without the userscript installed, Quick open still works as a plain URL builder — it
just requires the usual manual bookmarklet tap once you land there.

## How extraction works

`extractItemsFromDoc(doc, baseUrl)` in `inject.js` walks every `.thing` element (Reddit's
per-post container in old.reddit's markup) and reads its `data-url` attribute:

- `.jpg/.jpeg/.png/.gif/.webp` → shown as an `<img>` (animated GIFs just play natively).
- imgur `.gifv` → rewritten to the equivalent `.mp4`, shown as a looping muted `<video>`.
- `v.redd.it` (no extension in its own `data-url`) → the real HLS manifest is played via
  `hls.js` (Safari/iOS get native HLS, no library needed). Where that manifest URL actually
  *is* depends on what kind of page is loaded — see below.
- `data-is-gallery="true"` → each image becomes its own slide (tagged with
  `galleryId`/`galleryIndex`/`galleryTotal`) rather than a nested sub-slideshow. Same
  two-location story as video — see below.
- Anything else (text posts, link posts) is skipped.

This function takes a `Document`, not an HTML string, so the exact same code handles both the
initial scan (`document`, already live) and "Load more" pagination (a same-origin `fetch()` of
Reddit's own "next ›" link, parsed via `DOMParser`).

### Video and gallery content live in two different places depending on the page

On a **subreddit listing**, video/gallery previews are collapsed by default — their real
content (the HLS manifest URL, or the gallery's image links) only exists pre-rendered as an
HTML-escaped *string*, stored *twice*-escaped inside the post's sibling
`.expando[data-cachedhtml]` attribute (old.reddit's mechanism for instant-expanding media
without a request). Reading it out takes two passes: the browser's own attribute parsing undoes
one escaping layer, leaving a string that still needs parsing *as HTML* itself to undo the
second layer.

On a post's **own comments page**, that same content is already expanded directly into the live
DOM — there is no `data-cachedhtml` at all in that case, and `data-hls-url` /
`a.gallery-item-thumbnail-link` elements are just sitting there as normal, unescaped markup.

`extractHlsUrl()` and `extractGalleryImages()` both try the direct, already-expanded case
first (`thing.querySelector(...)`), and only fall back to unwrapping `data-cachedhtml` if
nothing's found that way. Missing either case means video/gallery posts silently fail to load
depending on which kind of page they're viewed from — this bit us once already: both functions
originally *only* checked `data-cachedhtml`, so they worked fine on listing pages but silently
found nothing on a post's own comments page.

## UI

Built as a Shadow DOM overlay (`hostEl.attachShadow({ mode: "open" })`) so reddit's page CSS
can't leak in and the tool's CSS can't leak out. `:host { all: initial }` plus an explicit
reset on the shell wrapper guards against inherited properties (font, color) bleeding through
the shadow boundary, which Shadow DOM doesn't block by default (only *selector-based* rules are
scoped — inherited properties still cross it).

- **Prev / Next** — arrow buttons over the media, `←`/`→` keys, touch swipe. Keydown handling
  calls `stopPropagation()` so old.reddit's own `j`/`k`/arrow shortcuts don't also fire.
- **Sort cog (⚙)** — Sort (Hot/New/Rising/Controversial/Top) and, for Top/Controversial, a Time
  range. Reflects whatever the current URL's sort/time actually is when opened
  (`syncSortControlsFromLocation()`), not just a Hot default. "Go" is a plain navigation to
  `https://old.reddit.com/r/<sub>/<sort>/?t=<time>&slideshow=1` — a full page reload, same
  `slideshow=1` marker as Quick Open, so the userscript auto-relaunches after it if installed.
- **Autoplay** — range slider + synced editable number input, 2–15s, Space bar toggles it. On
  a video/HLS slide it waits for the clip to actually finish instead of advancing on the fixed
  delay — `scheduleAutoplayAdvance()` turns off that `<video>`'s `loop` and advances on its
  `ended` event, with a 120s backup timeout in case playback stalls and `ended` never fires.
  Static images and actual animated `.gif` files still use the fixed delay regardless — an
  `<img>` exposes no "this GIF finished" signal at all, so there's nothing to listen for.
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
