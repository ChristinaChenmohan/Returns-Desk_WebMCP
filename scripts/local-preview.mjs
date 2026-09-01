import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
const node = process.execPath;
function run(args) { return new Promise((res, reject) => { const child = spawn(node, args, { stdio: 'inherit', env: process.env }); child.on('error', reject); child.on('exit', code => code === 0 ? res() : reject(new Error(`Preview prerequisite failed: ${code}`))); }); }
await run(['node_modules/vite/bin/vite.js', 'build']);
await run(['node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'returns-desk', '--local']);
const child = spawn(node, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'dist/returns_desk/wrangler.json', '--persist-to', resolve('.wrangler/state'), '--port', '8787', '--var', 'CHANNEL_SIGNING_KEY:returns-desk-local-demo-signing-key-not-for-production'], { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => process.exit(code ?? 1));
