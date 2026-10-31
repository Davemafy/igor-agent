import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The sanitized public repository cannot redistribute Qloo's original API
// recordings. Preserve archived replay tests in the source, but do not report
// them as passing when their required third-party fixtures are unavailable.
const archivedReplaySuites = [
  "tests/unit/broader-outcomes.test.ts",
  "tests/unit/conversation.test.ts",
  "tests/unit/gemini-model.test.ts",
  "tests/unit/place-discovery.test.ts",
  "tests/unit/recorded-conversation.test.ts",
  "tests/unit/recorded-provider.test.ts",
  "tests/unit/recorded-workflow.test.ts",
  "tests/unit/recording-file.test.ts",
];
const hasPrivateRecordings = existsSync(
  fileURLToPath(new URL("./fixtures/qloo-cultural.json.gz", import.meta.url)),
);

if (!hasPrivateRecordings) {
  console.warn(
    `Sanitized public suite: ${archivedReplaySuites.length} recording-dependent suites excluded because their private source fixtures are unavailable.`,
  );
}

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    exclude: hasPrivateRecordings ? [] : archivedReplaySuites,
    environment: "node",
  },
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
  },
});
