import type { ApiClient } from "../api/client";
import { ApiError } from "../api/errors";
import type { EffectRef } from "../shared/contracts/common";
import type { ToolName } from "../shared/contracts/tools";
import type { ModelContext, BrowserTool } from "./global";
import { toolDefinitions } from "./tool-definitions";
import type { UiSync } from "./sync-effects";
export interface RegistryDeps {
  agentClient: Pick<ApiClient, "call">;
  sync: (effects: readonly EffectRef[]) => Promise<UiSync>;
  diagnostics: (code: "registration_failed") => void;
}
const registrations = new WeakMap<ModelContext, { users: number; controller: AbortController }>();
function route(name: ToolName, input: Record<string, unknown>) {
  const { idempotencyKey, ...body } = input; const key = typeof idempotencyKey === "string" ? idempotencyKey : undefined;
  if (name === "search_orders") return { path: `/orders?query=${encodeURIComponent(String(body.query))}&limit=${String(body.limit)}`, method: "GET", body: undefined, key };
  if (name === "get_return_policy") return { path: `/order-items/${encodeURIComponent(String(body.orderItemId))}/return-policy?orderId=${encodeURIComponent(String(body.orderId))}`, method: "GET", body: undefined, key };
  if (name === "compare_resolution_options") return { path: `/eligibility-checks/${encodeURIComponent(String(body.eligibilityCheckId))}/compare-resolutions`, method: "POST", body: { preference: body.preference }, key };
  return { path: name === "check_return_eligibility" ? "/eligibility-checks" : name === "draft_customer_message" ? "/message-drafts" : "/rma-proposals", method: "POST", body, key };
}
export function registerReturnsDeskTools(deps: RegistryDeps, context: ModelContext | undefined = document.modelContext): () => void {
  if (!context?.registerTool) return () => undefined;
  const existing = registrations.get(context);
  if (existing) { existing.users++; return release(context, existing); }
  const state = { users: 1, controller: new AbortController() }; registrations.set(context, state);
  const tools: BrowserTool[] = toolDefinitions.map(definition => ({
    name: definition.name, description: definition.description, inputSchema: definition.inputSchema, annotations: definition.annotations,
    async execute(raw, options) {
      const input = definition.schema.safeParse(raw);
      if (!input.success) return JSON.stringify({ error: { code: "INVALID_REQUEST", retryable: false, recoveryAction: "correct_input" } });
      const command = route(definition.name, input.data as Record<string, unknown>);
      try {
        let result = await deps.agentClient.call<unknown>(command.path, command.method, command.body, command.key, options?.signal);
        if (definition.name === "search_orders" && isUniqueSearchResult(result.data)) {
          const orderId = result.data.orders[0]!.orderId;
          const details = await deps.agentClient.call<unknown>(`/orders/${encodeURIComponent(orderId)}`, "GET", undefined, undefined, options?.signal);
          result = { ...result, data: { ...result.data, selectedOrder: details.data } };
        }
        const uiSync = await deps.sync(result.effects ?? []).catch(() => "refresh_required" as const);
        return JSON.stringify({ data: result.data, uiSync });
      } catch (error) {
        if (error instanceof ApiError) return JSON.stringify({ error: { code: error.code, retryable: error.retryable, recoveryAction: error.recoveryAction } });
        return JSON.stringify({ error: { code: options?.signal?.aborted ? "CANCELLED" : "NETWORK_ERROR", retryable: true, recoveryAction: "retry_same_idempotency_key" } });
      }
    },
  }));
  // Defer invocation so a synchronous compatibility failure is caught as well.
  void Promise.all(tools.map(tool => Promise.resolve().then(() => {
    if (!state.controller.signal.aborted) return context.registerTool(tool, { signal: state.controller.signal });
  }))).catch(() => { state.controller.abort(); deps.diagnostics("registration_failed"); });
  return release(context, state);
}
function isUniqueSearchResult(value: unknown): value is { resultCount: 1; requiresSelection: false; orders: [{ orderId: string }] } {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { resultCount?: unknown; requiresSelection?: unknown; orders?: unknown };
  if (result.resultCount !== 1 || result.requiresSelection !== false || !Array.isArray(result.orders) || result.orders.length !== 1) return false;
  const order = result.orders[0];
  return typeof order === "object" && order !== null && typeof (order as { orderId?: unknown }).orderId === "string";
}
function release(context: ModelContext, state: { users: number; controller: AbortController }) {
  let released = false;
  return () => { if (released) return; released = true; if (--state.users === 0) { state.controller.abort(); registrations.delete(context); } };
}
