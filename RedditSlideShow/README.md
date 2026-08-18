# Reddit Slideshow

A bookmarklet (and userscript) that turns a subreddit or user profile listing on
`old.reddit.com` into an image / GIF / video slideshow, injected directly into the page you're
already on. No Reddit API, no proxy, no backend. Works from `www.reddit.com` too — it hands you
off to the `old.reddit.com` equivalent page first, since that's the only markup it can read.

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
  "▶ Slideshow" button to every `old.reddit.com/r/*` and `old.reddit.com/user/*` page, plus
  every `www.reddit.com` page (where it hands off instead — see below), using the same loader
  logic.

On `old.reddit.com`, both the bookmarklet and the userscript do the same thing: load
`vendor/hls.min.js` (if not already loaded) via `<script src>`, then load `inject.js` the same
way. Script tags aren't subject to CORS regardless of origin — only reading a `fetch()`/`XHR`
response body is — so this works even though it's pulling from `charliemorris56.github.io`
while running on `old.reddit.com`. Everything else the tool does from that point on is
same-origin.

### www.reddit.com

`inject.js`'s extraction depends on old.reddit's server-rendered markup (`.thing`,
`data-cachedhtml`) — none of which exists on the React/web-component markup `www.reddit.com`
renders instead, so there's nothing for it to read there. Rather than fail silently, both the
bookmarklet and the userscript check `location.hostname` first: anywhere that isn't
`old.reddit.com`, they just navigate to the equivalent `old.reddit.com` URL (same path, same
query string) with `?slideshow=1` appended, instead of trying to run. If the userscript is
installed, that marker makes it auto-launch the instant the old.reddit.com page loads — so in
practice, clicking the button on `www.reddit.com` with the userscript installed feels like it
worked in place. Without the userscript, the bookmarklet's hand-off still saves you a manual
URL edit; you just need one more click once you land there.

### The `slideshow=1` marker

Several in-overlay actions that navigate to a new page — the sort cog's "Go", and picking a
result in subreddit search — append `?slideshow=1` to the destination URL, e.g.
`https://old.reddit.com/r/memes/top/?t=week&slideshow=1`. That marker only matters if
`reddit-slideshow.user.js` is already installed: on `document-idle` it checks `location.search`
for it and calls `launch()` immediately instead of waiting for the floating button to be
clicked, then strips the marker via `history.replaceState` so it doesn't linger in the address
bar. This is the *only* way to get a "navigate and land already in the slideshow" experience — a
plain link can't trigger anything on the page it navigates to, and a bookmarklet's execution
ends the moment it navigates away, so only something already running persistently on every
reddit page load (i.e. the userscript) can react to the marker. Without the userscript
installed, these actions still work as plain navigation — they just leave you on a normal
listing page, requiring the usual manual bookmarklet tap.

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
- `redgifs.com/watch/<id>` (or `/ifr/<id>`) → shown as an embedded RedGifs player, not a
  `<video>` we control. See "RedGifs" below for why.
- Anything else (text posts, link posts) is skipped.

This function takes a `Document`, not an HTML string, so the exact same code handles both the
initial scan (`document`, already live) and "Load more" pagination (a same-origin `fetch()` of
Reddit's own "next ›" link, parsed via `DOMParser`). It also doesn't care whether that document
is a subreddit listing or a user profile listing (`/user/<name>/submitted/`) — both use the
same `.thing`-based template, so the same extraction runs unchanged on either.

### RedGifs

RedGifs posts are outbound links (`data-domain="redgifs.com"`), not native reddit video, so
there's no `data-hls-url` anywhere for them — old.reddit's own `data-cachedhtml` only ever
contains an `<iframe src="//www.redditmedia.com/mediaembed/...">`, itself just a wrapper around
RedGifs' own embed. Getting an actual `.mp4` URL means calling RedGifs' info API
(`api.redgifs.com/v2/gifs/<id>`), and that API's CORS allowlist only covers `redgifs.com`
origins — a `fetch()` to it from `old.reddit.com` is blocked before the response body can even
be read (confirmed directly: the identical request succeeds with `Origin: www.redgifs.com` and
gets rejected with `Origin: old.reddit.com`). There's no proxy-free way around that from here.

So instead of a `<video>`, RedGifs posts render as an `<iframe src="https://www.redgifs.com/ifr/<id>">`
— that URL itself *is* embeddable from any origin (no `X-Frame-Options`/CSP block), so this
needs no API call and no auth token at all. The trade-off: it's RedGifs' own player with its
own autoplay/mute/loop, and there's no way to observe an "ended" event across the iframe
boundary, so autoplay-wait-for-video-to-finish (see "Autoplay" below) can't apply to these —
they use the fixed-delay timer, same as static images and animated GIFs.

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
  (`syncSortControlsFromLocation()`), not just a Hot default. "Go" is a plain navigation, with
  the same `slideshow=1` marker described above so the userscript auto-relaunches after it if
  installed —
  `https://old.reddit.com/r/<sub>/<sort>/?t=<time>&slideshow=1` on a subreddit, or
  `https://old.reddit.com/user/<name>/submitted/?sort=<sort>&t=<time>&slideshow=1` on a user
  profile (sort is a query param there, not a path segment — `currentContext()` branches on
  which kind of page it is).
- **Autoplay** — range slider + synced editable number input, 2–15s, Space bar toggles it. On
  a video/HLS slide it waits for the clip to actually finish instead of advancing on the fixed
  delay — `scheduleAutoplayAdvance()` turns off that `<video>`'s `loop` and advances on its
  `ended` event, with a 120s backup timeout in case playback stalls and `ended` never fires.
  Static images, actual animated `.gif` files, and RedGifs' embedded iframe player all still
  use the fixed delay regardless — none of them expose an "ended"-equivalent signal we can
  listen for from outside.
- **Fullscreen** — expands the media viewport via the Fullscreen API (works fine on a
  shadow-hosted element); a circular ✕ appears top-right, a duplicate "Skip gallery" button
  top-left, and a "View on Reddit" link bottom-right when relevant, since the rest of the
  overlay chrome isn't visible in fullscreen.
- **Gallery badge / Skip gallery** — "🖼 Gallery N / M" badge while on a gallery slide; a
  button that jumps to the first slide whose `galleryId` differs from the current one.
- **Search subreddits (🔍)** — debounced, results sorted by subscriber count (formatted as e.g.
  `1.2M`/`450k`), click a result to navigate straight into it with `slideshow=1`. Unchecking
  "Strict" (on by default) hits `old.reddit.com/subreddits/search.json` alone — reddit's
  relevance/topic search, fetched with `include_over_18=on` so restricted subreddits aren't
  silently dropped, but it can surface subs whose *name* doesn't contain the query at all (only
  their description does), and can just as easily omit a real name match. Strict mode
  (`strictSubredditSearch()`) instead merges two sources: `subreddits/search.json` itself
  (`limit=100`, kept only where `display_name` actually contains the query) plus
  `api/search_reddit_names.json`, which substring-matches the name directly (confirmed: query
  `ota` returns `DotA2`, which the relevance endpoint never returns at all) — but hard-caps at
  exactly 10 results with no way to ask for more (confirmed against `cat`/`pic`/`game`, all
  capped at 10 regardless of params, even though e.g. 74 unique name-matching subreddits exist
  for `cat`). Whichever of those 10 names isn't already covered by the relevance search gets its
  subscriber count filled in via one batched `api/info.json?sr_name=a,b,c` call. This has to
  live here rather than on the landing page for the same CORS reason `loadMore()` does — it's a
  same-origin fetch only because we're already running on `old.reddit.com` (confirmed:
  `www.reddit.com`'s own search API is unreachable from here — blocked outright by CORS, same as
  the rest of `www.reddit.com`).

  `ensureExactMatch()` covers a further gap in *both* modes: reddit's search endpoints can omit
  a subreddit even when the query is its exact literal name — confirmed against a real,
  non-quarantined, multi-million-subscriber restricted subreddit that neither
  `subreddits/search.json` nor `search_reddit_names.json` returns for a query matching its name
  exactly, even though a direct `api/info.json?sr_name=<name>` lookup finds it instantly (tested
  logged out, so this isn't an account/content-pref thing — reddit's search index itself appears
  to suppress certain high-profile restricted communities from search while still serving them
  by direct name).
  So whenever the typed query isn't already an exact name match in what search returned, a
  direct name lookup is spliced in and pinned to the top of the results.
- **Image prefetch** — `preloadUpcoming()` fires off `new Image()` requests for the next two
  slides (image type only) after every render, so Next/autoplay usually shows an already-cached
  frame instead of a blank one.
- **Close (✕, top bar)** — tears the whole overlay down, stops autoplay, destroys any active
  `Hls` instance, exits fullscreen if active.

Re-triggering (bookmarklet clicked again, or the userscript's button clicked again) reopens an
already-built overlay via `window.__redditSlideshowToggle()` instead of rebuilding it, unless
it was closed first — closing fully tears down and resets `window.__redditSlideshowLoaded` so
the next trigger does a clean rebuild.

## Known limitations

- Only reads `old.reddit.com` listing pages (subreddits and user profiles) — the extraction
  logic depends on markup (`.thing`, `data-cachedhtml`) that doesn't exist on the React-based
  `www.reddit.com`. Both the bookmarklet and the userscript hand off there automatically from
  anywhere else on reddit, so this mostly isn't user-visible — see "www.reddit.com" above.
- RedGifs posts play in RedGifs' own embedded iframe player, not a `<video>` this tool
  controls — no way to pull a direct `.mp4` URL client-side (CORS-blocked API), and no
  autoplay-wait-for-finish for the same reason. See "RedGifs" above.
- Quarantined subreddits still need the user to be logged in and opted in on their real Reddit
  account — same as browsing reddit normally, no way around that from any tool.
- Bookmarklets are fiddly to install on mobile (no drag-and-drop) — see the install page for
  the workaround (bookmark any page, then edit its URL).
