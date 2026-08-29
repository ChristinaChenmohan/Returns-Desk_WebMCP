import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));

createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  if (pathname !== "/probe.html") {
    response.writeHead(404).end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Origin-Agent-Cluster": "?1",
    "Permissions-Policy": "tools=(self)",
  });
  response.end(await readFile(`${root}probe.html`));
}).listen(8123, "127.0.0.1", () => {
  process.stdout.write("WEBMCP_PROBE_SERVER_READY\n");
});

