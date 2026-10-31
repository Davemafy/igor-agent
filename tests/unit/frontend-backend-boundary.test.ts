import { afterEach, describe, expect, it } from "vitest";
import nextConfig, { configuredBackendOrigin } from "../../next.config";
import { checkOrigin } from "../../src/core/request-origin";

const initial = {
  origin: process.env.IGOR_BACKEND_ORIGIN,
  frontend: process.env.IGOR_FRONTEND_ONLY,
  vercel: process.env.VERCEL,
  allowed: process.env.IGOR_ALLOWED_FRONTEND_ORIGINS,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    IGOR_BACKEND_ORIGIN: initial.origin,
    IGOR_FRONTEND_ONLY: initial.frontend,
    VERCEL: initial.vercel,
    IGOR_ALLOWED_FRONTEND_ORIGINS: initial.allowed,
  })) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("backend-agnostic Vercel UI", () => {
  it("preserves the existing integrated local mode", async () => {
    delete process.env.VERCEL;
    delete process.env.IGOR_FRONTEND_ONLY;
    delete process.env.IGOR_BACKEND_ORIGIN;

    expect(configuredBackendOrigin()).toBeNull();
    const rewrites = await nextConfig.rewrites?.();

    expect(rewrites).toMatchObject({
      beforeFiles: [{ source: "/", destination: "/marketing/index.html" }],
    });
  });

  it("routes every same-origin API endpoint to the configured engine", async () => {
    process.env.IGOR_FRONTEND_ONLY = "1";
    process.env.IGOR_BACKEND_ORIGIN = "https://engine.example";
    delete process.env.VERCEL;

    expect(await nextConfig.rewrites?.()).toMatchObject({
      beforeFiles: [
        { source: "/", destination: "/marketing/index.html" },
        {
          source: "/api/:path*",
          destination: "https://engine.example/api/:path*",
        },
      ],
    });
  });

  it("refuses Vercel deployments without a backend", () => {
    process.env.VERCEL = "1";
    delete process.env.IGOR_BACKEND_ORIGIN;

    expect(configuredBackendOrigin).toThrow(/requires IGOR_BACKEND_ORIGIN/);
  });

  it.each([
    "http://engine.example",
    "https://user:pass@engine.example",
    "https://engine.example/api",
    "https://engine.example?token=secret",
    "https://engine.example/#fragment",
  ])("rejects an unsafe or non-origin backend URL: %s", (origin) => {
    process.env.IGOR_BACKEND_ORIGIN = origin;

    expect(configuredBackendOrigin).toThrow(/must be an HTTPS origin/);
  });

  it("supports HTTP loopback only for local integration tests", () => {
    delete process.env.VERCEL;
    process.env.IGOR_BACKEND_ORIGIN = "http://127.0.0.1:3570";

    expect(configuredBackendOrigin()).toBe("http://127.0.0.1:3570");

    process.env.VERCEL = "1";

    expect(configuredBackendOrigin).toThrow(/must be an HTTPS origin/);
  });
});

function request(
  origin: string,
  site: "same-origin" | "cross-site" = "same-origin",
): Request {
  return new Request("https://engine.example/api/tasks", {
    method: "POST",
    headers: {
      origin,
      host: "engine.example",
      "sec-fetch-site": site,
    },
  });
}

describe("trusted proxied frontend origin", () => {
  it("retains normal same-origin backend writes", () => {
    delete process.env.IGOR_ALLOWED_FRONTEND_ORIGINS;

    expect(() => checkOrigin(request("https://engine.example"))).not.toThrow();
  });

  it("allows only explicitly configured HTTPS Vercel origins", () => {
    process.env.IGOR_ALLOWED_FRONTEND_ORIGINS =
      "https://igor-preview.vercel.app, https://igor.example";

    expect(() =>
      checkOrigin(request("https://igor-preview.vercel.app")),
    ).not.toThrow();
    expect(() => checkOrigin(request("https://igor.example"))).not.toThrow();
    expect(() => checkOrigin(request("https://attacker.vercel.app"))).toThrow(
      /Cross-origin/,
    );
  });

  it("still blocks a cross-site request even from an allowlisted origin", () => {
    process.env.IGOR_ALLOWED_FRONTEND_ORIGINS =
      "https://igor-preview.vercel.app";

    expect(() =>
      checkOrigin(request("https://igor-preview.vercel.app", "cross-site")),
    ).toThrow(/Cross-origin/);
  });

  it("fails closed on malformed trusted origins", () => {
    process.env.IGOR_ALLOWED_FRONTEND_ORIGINS = "https://igor.example/path";

    expect(() => checkOrigin(request("https://igor.example"))).toThrow(
      /Invalid IGOR_ALLOWED_FRONTEND_ORIGINS/,
    );
  });
});
