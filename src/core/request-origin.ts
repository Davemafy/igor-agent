/**
 * Only the engine validates writes. The Vercel UI is a same-origin reverse
 * proxy in the browser, but the backend sees the browser's original Origin.
 * Permit explicitly trusted UI origins without permitting arbitrary CORS.
 */
function trustedFrontendOrigins(): Set<string> {
  const configured = process.env.IGOR_ALLOWED_FRONTEND_ORIGINS?.trim();

  if (!configured) {
    return new Set();
  }

  const allowed = new Set<string>();

  for (const entry of configured.split(",")) {
    const candidate = entry.trim();

    if (!candidate) {
      continue;
    }

    const url = new URL(candidate);
    const local = ["localhost", "127.0.0.1"].includes(url.hostname);

    if (
      (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid IGOR_ALLOWED_FRONTEND_ORIGINS entry.");
    }

    allowed.add(url.origin);
  }

  return allowed;
}

export function checkOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  const expected = `${url.protocol}//${host}`;

  if (
    origin &&
    origin !== expected &&
    !trustedFrontendOrigins().has(origin)
  ) {
    throw new Error("Cross-origin writes are not allowed.");
  }

  // A trusted proxy request comes from the browser's SAME origin. Do not
  // disable this check to make arbitrary cross-site POSTs work.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new Error("Cross-origin writes are not allowed.");
  }
}
