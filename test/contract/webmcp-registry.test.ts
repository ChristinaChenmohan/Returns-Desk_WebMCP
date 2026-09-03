import { expect, it, vi } from "vitest";
import { registerReturnsDeskTools, type RegistryDeps } from "../../src/webmcp/registry";
import type { BrowserTool, ModelContext } from "../../src/webmcp/global";
function fixture() {
  const definitions: BrowserTool[] = [], signals: AbortSignal[] = [];
  const context: ModelContext = { registerTool(tool, options) { definitions.push(tool); signals.push(options.signal); } };
  const call = vi.fn().mockResolvedValue({ data: { status: "pending" }, effects: [{ entityType: "return_case", entityId: "c1", entityVersion: 2 }], meta: {} });
  const sync = vi.fn().mockResolvedValue("synchronized");
  const deps: RegistryDeps = { agentClient: { call }, sync, diagnostics: vi.fn() };
  return { definitions, signals, context, deps, call, sync };
}
it("registers exactly six strict static tools with approved annotations and shared lifecycle", async () => {
  const f = fixture(); const first = registerReturnsDeskTools(f.deps, f.context), second = registerReturnsDeskTools(f.deps, f.context); await Promise.resolve();
  expect(f.definitions.map(t => [t.name, t.annotations.readOnlyHint, t.annotations.untrustedContentHint])).toEqual([
    ["search_orders", true, true], ["get_return_policy", true, false], ["check_return_eligibility", false, true], ["compare_resolution_options", true, false], ["draft_customer_message", true, true], ["submit_rma_for_approval", false, true],
  ]);
  for (const tool of f.definitions) expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
  first(); expect(f.signals.every(s => !s.aborted)).toBe(true); second(); expect(f.signals.every(s => s.aborted)).toBe(true);
});
it("validates input, moves the idempotency key to headers, forwards cancellation and never repeats a successful write for UI sync", async () => {
  const f = fixture(); const dispose = registerReturnsDeskTools(f.deps, f.context); await Promise.resolve(); const tool = f.definitions[2]!;
  expect(JSON.parse(await tool.execute({ orderId: "x", actorType: "human" })).error.code).toBe("INVALID_REQUEST"); expect(f.call).not.toHaveBeenCalled();
  f.sync.mockRejectedValueOnce(new Error("UI unavailable")); const controller = new AbortController();
  const result = JSON.parse(await tool.execute({ orderId: "o1", orderItemId: "i1", requestedQuantity: 1, reasonCode: "wrong_size", conditionCode: "unopened", idempotencyKey: "retry-1" }, { signal: controller.signal }));
  expect(result).toEqual({ data: { status: "pending" }, uiSync: "refresh_required" });
  expect(f.call).toHaveBeenCalledTimes(1); expect(f.call).toHaveBeenCalledWith("/eligibility-checks", "POST", expect.not.objectContaining({ idempotencyKey: expect.anything() }), "retry-1", controller.signal); dispose();
});
it("enriches a unique search match with order item details for dependent tools", async () => {
  const f = fixture();
  f.call
    .mockResolvedValueOnce({
      data: {
        orders: [{ orderId: "order-1", orderNumber: "ORD-1001" }],
        resultCount: 1,
        requiresSelection: false,
      },
      effects: [],
      meta: {},
    })
    .mockResolvedValueOnce({
      data: {
        orderId: "order-1",
        orderNumber: "ORD-1001",
        items: [{ orderItemId: "item-1", productTitle: "Everyday Runner" }],
      },
      effects: [],
      meta: {},
    });
  const dispose = registerReturnsDeskTools(f.deps, f.context); await Promise.resolve();

  const result = JSON.parse(await f.definitions[0]!.execute({ query: "ORD-1001", limit: 5 }));

  expect(result).toMatchObject({
    data: {
      resultCount: 1,
      selectedOrder: {
        orderId: "order-1",
        items: [{ orderItemId: "item-1" }],
      },
    },
    uiSync: "synchronized",
  });
  expect(f.call).toHaveBeenNthCalledWith(1, "/orders?query=ORD-1001&limit=5", "GET", undefined, undefined, undefined);
  expect(f.call).toHaveBeenNthCalledWith(2, "/orders/order-1", "GET", undefined, undefined, undefined);
  dispose();
});
it("contains registration compatibility failures without throwing or partial tool exposure", async () => {
  const f = fixture(); f.context.registerTool = () => { throw new Error("unsupported"); };
  const dispose = registerReturnsDeskTools(f.deps, f.context);
  await vi.waitFor(() => expect(f.deps.diagnostics).toHaveBeenCalledWith("registration_failed")); dispose();
});
