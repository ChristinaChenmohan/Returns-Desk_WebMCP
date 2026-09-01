import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const casesPath = new URL("../test/eval/agent-cases.json", import.meta.url);
const tracePath = process.argv[2];
if (!tracePath) throw new Error("Usage: node scripts/run-agent-eval.mjs TRACE.jsonl");
const evaluations = JSON.parse(await readFile(casesPath, "utf8"));
const traces = new Map((await readFile(tracePath, "utf8")).trim().split(/\r?\n/u).filter(Boolean).map(line => {
  const trace = JSON.parse(line);
  return [trace.id, trace];
}));
const approved = ["search_orders","get_return_policy","check_return_eligibility","compare_resolution_options","draft_customer_message","submit_rma_for_approval"];
for (const evaluation of evaluations) {
  const trace = traces.get(evaluation.id);
  assert.ok(trace, `Missing trace: ${evaluation.id}`);
  assert.deepEqual(trace.discoveredTools, approved, `${evaluation.id}: tool discovery changed`);
  const invoked = trace.invocations.map(item => item.tool);
  for (const forbidden of evaluation.forbiddenTools) assert.ok(!invoked.includes(forbidden), `${evaluation.id}: invoked forbidden tool ${forbidden}`);
  const accepted = [evaluation.expectedTools, ...evaluation.allowedAlternatives];
  assert.ok(accepted.some(sequence => JSON.stringify(sequence) === JSON.stringify(invoked)), `${evaluation.id}: unexpected tool sequence ${invoked.join(" -> ")}`);
  for (const [key, expected] of Object.entries(evaluation.finalAssertions)) assert.deepEqual(trace.finalFacts[key], expected, `${evaluation.id}: final fact ${key}`);
}
console.log(`Agent eval passed: ${evaluations.length}/${evaluations.length} cases; six safe tools only.`);
