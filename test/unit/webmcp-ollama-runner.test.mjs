import { describe, expect, it, vi } from "vitest";
import {
  buildAgentOverlayView,
  buildBrowserLaunchOptions,
  parseRunnerArgs,
  runOllamaToolLoop,
  validateDemoUrl,
} from "../../scripts/webmcp-ollama-runner-lib.mjs";

describe("Ollama WebMCP demo runner", () => {
  it("compacts the prompt after execution starts while preserving every tool step", () => {
    const prompt = "Use the WebMCP tools registered by this page to prepare a return for ORD-1001. ".repeat(8).trim();
    const history = Array.from({ length: 6 }, (_, index) => ({ name: `tool_${index + 1}`, args: {}, result: {} }));

    const view = buildAgentOverlayView({ prompt, history, state: "Complete" });

    expect(view.promptExpanded).toBe(false);
    expect(view.promptText.length).toBeLessThan(prompt.length);
    expect(view.promptText).toMatch(/…$/u);
    expect(view.rows.map(row => row.name)).toEqual(["tool_1", "tool_2", "tool_3", "tool_4", "tool_5", "tool_6"]);
    expect(view.rows.map(row => row.expanded)).toEqual([false, false, false, false, true, true]);
  });

  it("supports an explicit headed recording mode", () => {
    expect(parseRunnerArgs([
      "--headed",
      "--hold-open=15",
      "https://returns.example.test",
    ])).toEqual({
      baseUrl: "https://returns.example.test/",
      headed: true,
      holdOpenSeconds: 15,
    });
  });

  it("allows HTTPS deployments and local HTTP development only", () => {
    expect(validateDemoUrl("https://returns.example.test").protocol).toBe("https:");
    expect(validateDemoUrl("http://127.0.0.1:5173").hostname).toBe("127.0.0.1");
    expect(() => validateDemoUrl("http://returns.example.test")).toThrow("HTTPS or localhost");
  });

  it("launches a visible recording window and accepts the local Wrangler certificate", () => {
    expect(buildBrowserLaunchOptions({
      headed: true,
      chromeChannel: "chrome-canary",
      flags: ["--enable-features=WebMCPTesting"],
    })).toMatchObject({
      channel: "chrome-canary",
      headless: false,
      defaultViewport: { width: 1500, height: 940 },
      args: expect.arrayContaining(["--ignore-certificate-errors", "--window-size=1500,940"]),
    });
  });

  it("feeds each browser tool result back to Ollama until the agent stops", async () => {
    const execute = vi.fn()
      .mockResolvedValueOnce({ toolCalls: [{ functionName: "search_orders", args: { query: "ORD-1001", limit: 5 } }] })
      .mockResolvedValueOnce({ toolCalls: [{ functionName: "get_return_policy", args: { orderId: "order-1", orderItemId: "item-1" } }] })
      .mockResolvedValueOnce({ toolCalls: [], text: "Ready for the next step." });
    const executeTool = vi.fn()
      .mockResolvedValueOnce({ success: true, result: { data: { selectedOrder: { orderId: "order-1", items: [{ orderItemId: "item-1" }] } } } })
      .mockResolvedValueOnce({ success: true, result: { data: { lockedToOrderItem: true } } });
    const onStep = vi.fn();
    const buildContinuation = vi.fn(({ call }) => `Continue after ${call.functionName}.`);

    const result = await runOllamaToolLoop({
      initialMessages: [{ role: "user", type: "message", content: "Run the return workflow." }],
      availableTools: [{ functionName: "search_orders" }, { functionName: "get_return_policy" }],
      execute,
      executeTool,
      onStep,
      buildContinuation,
      maxSteps: 6,
    });

    expect(result.toolCalls.map(call => call.functionName)).toEqual(["search_orders", "get_return_policy"]);
    expect(result.text).toBe("Ready for the next step.");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[1][0]).toEqual(expect.arrayContaining([
      { role: "model", type: "functioncall", name: "search_orders", arguments: { query: "ORD-1001", limit: 5 } },
      { role: "tool", type: "functionresponse", name: "search_orders", response: JSON.stringify({ data: { selectedOrder: { orderId: "order-1", items: [{ orderItemId: "item-1" }] } } }) },
      { role: "user", type: "message", content: "Continue after search_orders." },
    ]));
    expect(onStep).toHaveBeenCalledTimes(2);
    expect(buildContinuation).toHaveBeenCalledTimes(2);
  });

  it("stops when a completed browser tool payload contains a business error", async () => {
    await expect(runOllamaToolLoop({
      initialMessages: [],
      availableTools: [{ functionName: "search_orders" }],
      execute: async () => ({ toolCalls: [{ functionName: "search_orders", args: {} }] }),
      executeTool: async () => ({ success: true, result: { error: { code: "FORBIDDEN" } } }),
      maxSteps: 2,
    })).rejects.toThrow("search_orders: FORBIDDEN");
  });

  it("fails instead of silently truncating a runaway agent", async () => {
    const execute = vi.fn().mockResolvedValue({
      toolCalls: [{ functionName: "search_orders", args: { query: "ORD-1001", limit: 5 } }],
    });

    await expect(runOllamaToolLoop({
      initialMessages: [],
      availableTools: [{ functionName: "search_orders" }],
      execute,
      executeTool: async () => ({ success: true, result: {} }),
      maxSteps: 2,
    })).rejects.toThrow("exceeded 2 tool steps");
  });
});
