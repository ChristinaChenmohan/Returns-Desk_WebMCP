const endpoint = process.argv[2] ?? "http://127.0.0.1:9223";
const deadline = Date.now() + 20_000;

async function findTarget() {
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`${endpoint}/json/list`).then(response => response.json());
      const target = targets.find(candidate => candidate.url.endsWith("/probe.html"));
      if (target) return target;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("CDP target was not ready");
}

const target = await findTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", event => {
  const message = JSON.parse(event.data);
  const handler = pending.get(message.id);
  if (handler) {
    pending.delete(message.id);
    handler(message);
  }
});

function evaluate(expression) {
  const id = nextId++;
  socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  return new Promise(resolve => pending.set(id, resolve));
}

let snapshot;
while (Date.now() < deadline) {
  const response = await evaluate(`JSON.stringify({
    title: document.title,
    result: document.querySelector('#result')?.textContent,
    caseVersion: document.querySelector('#case')?.dataset.version,
    caseText: document.querySelector('#case')?.textContent
  })`);
  snapshot = JSON.parse(response.result.result.value);
  if (["WEBMCP_PROBE_PASS", "WEBMCP_PROBE_PARTIAL", "WEBMCP_PROBE_FAIL"].includes(snapshot.title)) break;
  await new Promise(resolve => setTimeout(resolve, 200));
}

socket.close();
process.stdout.write(`${JSON.stringify(snapshot)}\n`);
if (!["WEBMCP_PROBE_PASS", "WEBMCP_PROBE_PARTIAL"].includes(snapshot?.title)) process.exitCode = 1;
