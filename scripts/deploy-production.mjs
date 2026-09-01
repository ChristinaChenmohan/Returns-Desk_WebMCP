import { spawn } from "node:child_process";

const env = { ...process.env, CLOUDFLARE_ENV: "production" };
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Production deployment step failed: ${code}`)));
  });
}

await run(["node_modules/vite/bin/vite.js", "build"]);
await run(["node_modules/wrangler/bin/wrangler.js", "deploy", ...process.argv.slice(2)]);
