// Backend-exclusive test runner (contract: backend tests/fixtures ownership).
// Runs the backend suites only; UI suites keep their own `npm test` glob.
// Usage: node test/run-backend.cjs   (after `npx tsc -p .`)
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const tests = [
  path.join(__dirname, "..", "out", "test", "backend-normalize.test.js"),
  path.join(__dirname, "..", "out", "test", "backend-catalog.test.js"),
  path.join(__dirname, "..", "out", "test", "backend-cold-start.test.js"),
  path.join(__dirname, "..", "out", "test", "backend-legacy.test.js"),
];

// The integration suites share one isolated sandbox home, so the files must
// run sequentially (--test-concurrency=1); node:test would parallelize them.
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=300000", ...tests], {
  stdio: "inherit",
  cwd: path.join(__dirname, ".."),
});
process.exit(result.status ?? 1);
