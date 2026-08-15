# Reddit Slideshow

A single-page site that turns a subreddit's image/GIF posts into a slideshow. No Reddit API
key, no backend of its own — it scrapes `old.reddit.com`'s HTML directly in the browser.

Files: `index.html`, `style.css`, `script.js` (all the logic), plus an optional
`worker/reddit-proxy-worker.js` for reliability (see below).

## How loading a subreddit works

1. **Parse whatever was typed or shared.** `stripToPath()` in `script.js` accepts a bare name
   (`memes`), a path (`r/aww/top/`), or a full URL (`https://www.reddit.com/r/aww/top/?sort=top&t=month`)
   and normalizes all of them down to a path-and-query string like `aww/top/?sort=top&t=month`.
2. **Build the scrape URL.** That string is appended to `https://old.reddit.com/r/`.
   `old.reddit.com` is used deliberately — it's still server-rendered HTML, unlike the
   React-based `www.reddit.com`, so the listing can be parsed with plain `DOMParser`.
3. **Fetch it through a proxy chain.** `fetchRedditHtml()` tries a list of proxies in order
   and returns the first one that yields real content — see "Why a proxy is needed" below.
4. **Extract posts.** `parseRedditHtml()` walks every `.thing` element (Reddit's per-post
   container in the old markup) and reads its `data-url` attribute — the actual link target of
   that post. A regex keeps only direct image/GIF links:
   - `.jpg/.jpeg/.png/.gif/.webp` → shown as an `<img>` (animated GIFs just play natively).
   - imgur `.gifv` → rewritten to the equivalent `.mp4` and shown as a looping muted `<video>`
     (imgur serves an actual video file at that same path).
   - `v.redd.it` → played with real audio via `hls.js` — see "Video posts" below.
   - Galleries (`data-is-gallery="true"`) → unrolled into one item per image — see "Gallery
     posts" below.
   - Anything else (text posts, link posts) is skipped.
5. **Render.** The first post becomes the current slide; Prev/Next/autoplay just walk the
   `items` array and re-render.

## Why a proxy is needed, and why there are several

`old.reddit.com` sends no `Access-Control-Allow-Origin` header, so a plain `fetch()` from this
page is blocked by the browser's CORS policy. Worse, Reddit's edge actively rejects
cross-site browser fetches outright (it inspects the `Sec-Fetch-Site`/`Origin` headers a
page's JS fetch sends and returns a `Blocked` interstitial or silently redirects to a login
wall) — a "CORS-unblock" browser extension doesn't help here, because it only changes what
the *browser* lets script read; it can't change how Reddit's server treats the request.

A request that originates from a server instead — no browser fetch fingerprint — isn't
rejected the same way. That's what every entry in `PROXIES` (top of `script.js`) relies on:

```js
const PROXIES = [
  ...(WORKER_PROXY_URL ? [yourWorker] : []),
  allorigins.win,
  corsproxy.io,
  null,  // last resort: a direct fetch with no proxy at all
];
```

`fetchRedditHtml()` tries each in order and falls through on failure. It also actively
detects several non-obvious "this isn't the real listing" responses — a `Blocked`
interstitial, a `/login/` redirect, a quarantine notice — and retries the next proxy instead
of treating any of them as the real listing, even though each arrives as a normal `200 OK`.

**The public proxies (`allorigins.win`, `corsproxy.io`) are free, third-party, and
consequently unreliable** — they get rate-limited, go down, or get blocked by Reddit
themselves since their IPs are shared across everyone using them. For anything beyond casual
use, deploy your own relay:

### Optional: your own Cloudflare Worker proxy

`worker/reddit-proxy-worker.js` is a ~40-line Worker that does the same job — fetch the page
server-side, return it with CORS headers — but from infrastructure only you use, so it isn't
already flagged. It only relays requests targeting `*.reddit.com` over `https`, GET only; it
is not an open proxy.

1. [Cloudflare dashboard](https://dash.cloudflare.com) → Workers & Pages → Create → Create
   Worker (free, no card required).
2. Name it, deploy the default, then "Edit code" and paste in
   `worker/reddit-proxy-worker.js`. Save & Deploy.
3. Copy the resulting `https://<name>.<subdomain>.workers.dev` URL.
4. Paste it into `WORKER_PROXY_URL` near the top of `script.js`. It's tried first,
   automatically, once set.

## Video posts

`v.redd.it` posts have no playable URL in their own `data-url` (just `https://v.redd.it/<id>`)
— the actual HLS manifest is pre-rendered as an HTML-escaped HTML fragment in the post's
sibling `.expando[data-cachedhtml]` attribute (old.reddit's mechanism for instant-expanding
video without a request). `extractHlsUrl()` unwraps it: read the attribute (the browser undoes
one layer of escaping), then parse *that string* as HTML again to undo the second layer and
land on a clean `.m3u8` URL.

Playing it needs `hls.js` (self-hosted in `vendor/hls.min.js`, loaded before `script.js`) since
no browser except Safari plays HLS natively. `renderSlide()` feeds the manifest to `Hls` via
`attachMedia`, with a native-HLS fallback (`canPlayType('application/vnd.apple.mpegurl')`) for
Safari/iOS. Unlike the muted, controls-less gifv treatment, these get real `controls` — they're
actual videos, not gif-like loops — starting muted (autoplay-with-sound is blocked by every
browser) with the native controls bar as the way to unmute. Each `Hls` instance is destroyed
in `renderSlide()` before the next slide renders, cancelling any in-flight segment fetches.

## Gallery posts

Same `data-cachedhtml` expando as above, different contents: `data-is-gallery="true"` posts
list one `a.gallery-item-thumbnail-link[href]` per image, in order — each already a full-size,
signed `preview.redd.it` URL. `extractGalleryImages()` reads them all and `parseRedditHtml()`
pushes one item per image, tagging each with `galleryId`/`galleryIndex`/`galleryTotal` instead
of nesting a sub-slideshow — they're just consecutive slides in the normal flow, with a
"🖼 Gallery N / M" badge and a **Skip gallery** button (visible only mid-gallery) that jumps to
the first item whose `galleryId` differs from the current one.

## URL formats and sharing

The page's own URL takes an `r` query parameter holding the same path-and-query format
described above, e.g.:

```
index.html?r=memes
index.html?r=aww/top/?sort=top&t=month
```

Note the second example: the value itself contains `?` and `&`. Standard query-string
parsing (`URLSearchParams`) would incorrectly split that into separate top-level params.
`readQueryParam()` avoids this by taking everything after `r=` as a single literal string
instead of parsing it as delimited key/value pairs — so a subreddit's own sort/time query
survives intact. The **Share** button and `updateAddressBar()` write links in this same
format, and reading is symmetric with an optional `decodeURIComponent()` pass so a
percent-encoded value works too.

## Sort / time settings (the ⚙ cog)

Next to the input box, the cog opens Sort (Hot/New/Rising/Controversial/Top) and, only for
Top/Controversial, a Time range (Hour/Day/Week/Month/Year/All time). It only ever modifies a
**bare subreddit name** — `applySortSettings()` checks for the presence of `/` or `?` in the
typed value first, and leaves anything that already looks like a path or full URL completely
untouched. After every successful load, `syncSortControlsFromPath()` reads the sort/time back
out of whatever path actually loaded (even a hand-typed one) so the cog stays truthful.

## Slideshow controls

- **Prev / Next** — arrow buttons over the media, plus `←`/`→` keys and touch swipe.
- **Autoplay** — a range slider paired with a live-synced number input (both editable,
  clamped to 2–15s), advancing one slide per interval. Space bar toggles it.
- **Fullscreen** — expands the media viewport (not the whole page chrome) via the
  Fullscreen API; a circular ✕ button appears top-right while active.
- **Share** — copies the current subreddit's shareable link to the clipboard (falls back to
  a `prompt()` if clipboard access is unavailable).
- **Load more** — fetches Reddit's next page (using the `after` cursor from its own
  pagination link) and appends new posts, de-duplicated by image URL.
- **Skip gallery** — visible only on a gallery slide, jumps past its remaining images to the
  next post.

## Known limitations

- **NSFW subreddits need the Worker** — it's the only proxy that can send the age-gate cookie;
  quarantined subreddits are unsupported regardless (needs a logged-in, opted-in account).
- **Reliability depends on the proxy in use.** Expect occasional failures on the public
  proxies; the error message always says why (blocked, rate-limited, empty response, etc.)
  and suggests deploying the Worker.
