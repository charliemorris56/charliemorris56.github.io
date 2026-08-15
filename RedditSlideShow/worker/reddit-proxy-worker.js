// Cloudflare Worker: minimal server-side relay for old.reddit.com listing pages.
//
// Deploy (free, no credit card):
//   1. https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
//   2. Give it a name (e.g. "reddit-slideshow-proxy"), deploy the default.
//   3. Click "Edit code", replace everything with this file's contents, Save & Deploy.
//   4. Copy the resulting *.workers.dev URL and paste it into WORKER_PROXY_URL
//      near the top of ../script.js.
//
// Only relays requests targeting reddit.com hostnames, over https, GET only —
// it is not a general-purpose open proxy.

const ALLOWED_ORIGINS = new Set([
  "https://charliemorris56.github.io",
  "http://localhost:8765",
  "http://127.0.0.1:8765",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

const ALLOWED_HOSTS = new Set(["old.reddit.com", "www.reddit.com", "reddit.com"]);

function corsOriginFor(request) {
  const origin = request.headers.get("Origin");
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : "*";
}

export default {
  async fetch(request) {
    const corsOrigin = corsOriginFor(request);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": corsOrigin,
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url= parameter", { status: 400 });
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return new Response("Invalid url parameter", { status: 400 });
    }

    if (targetUrl.protocol !== "https:" || !ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return new Response("Only https://*.reddit.com URLs are allowed", { status: 403 });
    }

    const upstream = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        Cookie: "over18=1",
      },
      redirect: "follow",
      cf: { cacheTtl: 30, cacheEverything: true },
    });

    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": corsOrigin,
        "Cache-Control": "public, max-age=30",
      },
    });
  },
};
