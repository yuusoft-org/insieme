import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const pkg = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));

if (pkg.devDependencies?.puty) {
  console.error(
    "Test stack validation failed: puty dependency is not allowed.",
  );
  process.exit(1);
}

const legacyActionsDir = path.resolve("spec/actions");
if (existsSync(legacyActionsDir)) {
  const files = readdirSync(legacyActionsDir).filter((name) =>
    name.endsWith(".yaml"),
  );
  if (files.length > 0) {
    console.error(
      `Test stack validation failed: legacy YAML action specs still exist (${files.join(
        ", ",
      )}).`,
    );
    process.exit(1);
  }
}

console.log("Test stack validation passed (Vitest-only protocol suite). ");
