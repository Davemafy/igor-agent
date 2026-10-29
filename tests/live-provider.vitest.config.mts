import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Explicit opt-in only: npm test never discovers or pays for this suite.
export default defineConfig({
  test: {
    include: ["tests/live/*.live.ts"],
    environment: "node",
    fileParallelism: false,
    bail: 1,
    testTimeout: 90000,
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
  },
});
