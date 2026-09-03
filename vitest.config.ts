import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        d1Databases: ["DB"],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  test: {
    include: ["test/unit/**/*.test.{ts,mjs}", "test/integration/**/*.test.ts", "test/contract/**/*.test.ts", "test/security/**/*.test.ts"],
    environment: "node",
  },
});
