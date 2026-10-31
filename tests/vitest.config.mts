import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Original Qloo recordings are intentionally excluded from this public source.
// Archive-only suites stay in Git for review but cannot pass without the
// third-party response recordings; never invent replacement LIVE data.
const replaySuites = [
  "tests/unit/broader-outcomes.test.ts",
  "tests/unit/conversation.test.ts",
  "tests/unit/gemini-model.test.ts",
  "tests/unit/place-discovery.test.ts",
  "tests/unit/recorded-conversation.test.ts",
  "tests/unit/recorded-provider.test.ts",
  "tests/unit/recorded-workflow.test.ts",
  "tests/unit/recording-file.test.ts",
];

const recordingsPresent = existsSync(
  fileURLToPath(new URL("./fixtures/qloo-cultural.json.gz", import.meta.url)),
);

if (!recordingsPresent) {
  console.warn(
    `Sanitized source: ${replaySuites.length} archived-recording suites unavailable; they are excluded, not passing.`,
  );
}

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    exclude: recordingsPresent ? [] : replaySuites,
    environment: "node",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
  },
});
