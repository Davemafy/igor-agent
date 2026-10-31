import type { NextConfig } from "next";

/**
 * Vercel runs the presentation layer. A durable Igor engine owns every /api
 * request, including streaming turns and session cookies. The browser always
 * uses same-origin /api URLs and never receives a provider secret.
 */
export function configuredBackendOrigin(): string | null {
  const configured = process.env.IGOR_BACKEND_ORIGIN?.trim();

  if (!configured) {
    if (process.env.VERCEL === "1" || process.env.IGOR_FRONTEND_ONLY === "1") {
      throw new Error(
        "Frontend-only deployment requires IGOR_BACKEND_ORIGIN. Refusing to serve local agent APIs on Vercel.",
      );
    }

    return null;
  }

  const url = new URL(configured);
  const local = ["127.0.0.1", "localhost"].includes(url.hostname);

  if (
    (url.protocol !== "https:" &&
      !(local && url.protocol === "http:" && process.env.VERCEL !== "1")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "IGOR_BACKEND_ORIGIN must be an HTTPS origin without credentials, paths, or query strings (HTTP localhost is allowed only outside Vercel).",
    );
  }

  return url.origin;
}

const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    const backend = configuredBackendOrigin();

    return {
      beforeFiles: [
        // Keep the existing marketing homepage on this deployment.
        { source: "/", destination: "/marketing/index.html" },
        ...(backend
          ? [
              {
                source: "/api/:path*",
                destination: `${backend}/api/:path*`,
              },
            ]
          : []),
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  allowedDevOrigins: ["127.0.0.1"],
  serverExternalPackages: ["node:sqlite"],
};

export default config;
