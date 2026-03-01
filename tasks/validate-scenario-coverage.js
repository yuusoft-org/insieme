import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const docsDir = path.resolve("docs/sync-scenarios");
const testsDir = path.resolve("spec/protocol");

const collectFiles = (dir, predicate) => {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) {
        stack.push(full);
      } else if (predicate(full)) {
        out.push(full);
      }
    }
  }
  return out;
};

const scenarioFiles = collectFiles(docsDir, (file) => file.endsWith(".md"));
const scenarioIds = scenarioFiles
  .map((file) => path.basename(file).match(/^(\d\d)-/))
  .filter(Boolean)
  .map((match) => match[1])
  .sort();

const testFiles = collectFiles(testsDir, (file) => file.endsWith(".test.js"));
const testBody = testFiles.map((file) => readFileSync(file, "utf8")).join("\n");

const missing = scenarioIds.filter((id) => !testBody.includes(`SC-${id}`));
if (missing.length > 0) {
  console.error(
    `Scenario coverage validation failed. Missing tags: ${missing
      .map((id) => `SC-${id}`)
      .join(", ")}`,
  );
  process.exit(1);
}

console.log(
  `Scenario coverage validated for ${scenarioIds.length} scenarios (${scenarioIds
    .map((id) => `SC-${id}`)
    .join(", ")}).`,
);
