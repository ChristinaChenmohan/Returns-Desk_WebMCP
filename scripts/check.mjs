import { spawnSync } from "node:child_process";
for (const [entry, ...args] of [
  ["node_modules/typescript/bin/tsc", "--noEmit"],
  ["node_modules/vitest/vitest.mjs", "run"],
  ["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.ui.config.ts"],
  ["node_modules/vite/bin/vite.js", "build"],
]) {
  const result = spawnSync(process.execPath, [entry, ...args], { stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
