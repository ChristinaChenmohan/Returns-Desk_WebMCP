import { expect, type Page, type APIRequestContext } from "@playwright/test";
import type { SessionAuth } from "../src/api/client";
import type { Workspace, OrderDetails, EligibilityResult } from "../src/api/models";
import type { ProposalResult } from "../worker/domain/proposal-service";
export async function api(request: APIRequestContext, cookie?: string) {
  const bootstrap = await request.get("/api/v1/session/bootstrap", cookie ? { headers: { Cookie: cookie } } : {}); expect(bootstrap.ok()).toBe(true);
  const auth = (await bootstrap.json()).data as SessionAuth;
  const sessionCookie = bootstrap.headers()["set-cookie"]?.split(";")[0] ?? cookie ?? "";
  async function call<T>(path: string, method = "GET", body?: object, key: string = crypto.randomUUID()) {
    const response = await request.fetch(`/api/v1${path}`, { method, headers: { Cookie: sessionCookie, "X-Channel-Token": auth.humanChannelToken!, "X-CSRF-Token": auth.csrfToken, "Idempotency-Key": key, Origin: new URL(responseBase()).origin }, ...(method === "GET" ? {} : { data: { ...body, expectedSeedVersion: auth.seedVersion } }) });
    const envelope = await response.json() as { data: T; error?: { code: string } }; return { response, data: envelope.data, error: envelope.error };
  }
  return { auth, call, cookie: sessionCookie };
}
function responseBase() { return process.env.RETURNS_DESK_BASE_URL ?? "http://127.0.0.1:8787"; }
export async function startUiCase(page: Page, resolution: "refund" | "exchange" | "store_credit" = "refund", order = "ORD-1001") {
  await page.goto("/orders"); await page.getByLabel("Search orders").fill(order); await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(`^${order} Avery`) }).click();
  await page.getByRole("combobox", { name: "Order item", exact: true }).selectOption({ index: 1 });
  if (resolution === "exchange") await page.getByRole("combobox", { name: "Optional exchange variant" }).selectOption({ index: 1 });
  if (resolution === "store_credit") await page.getByLabel("Customer explicitly agrees to store credit as an option").check();
  if (order === "ORD-1002") await page.getByRole("combobox", { name: "Return reason" }).selectOption("damaged");
  await page.getByRole("button", { name: "Check return eligibility", exact: true }).click();
  await expect(page).toHaveURL(/\/cases\//); return page.url().split("/").at(-1)!;
}
export async function proposeUi(page: Page, resolution = "refund") {
  await page.getByRole("button", { name: "Prepare proposal", exact: true }).click(); await page.getByRole("combobox", { name: "Resolution", exact: true }).selectOption(resolution);
  await page.getByRole("button", { name: "Generate message draft" }).click(); await expect(page.getByLabel("Message subject")).not.toHaveValue("");
  await page.getByRole("button", { name: "Submit for approval", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
}
export async function approveUi(page: Page) {
  await page.getByRole("button", { name: "Review & approve", exact: true }).click();
  await page.getByRole("checkbox", { name: "I confirm these simulated effects." }).check();
  await page.getByRole("button", { name: "Approve and simulate completion", exact: true }).click(); await expect(page.getByRole("heading", { name: "Demo RMA completed" })).toBeVisible();
}
export async function facts(page: Page, id: string) { const cookies = await page.context().cookies(); const cookie = cookies.find(c => c.name === "returns_desk_session"); const client = await api(page.request, cookie ? `${cookie.name}=${cookie.value}` : undefined); const result = await client.call<Workspace>(`/cases/${id}`); expect(result.response.ok()).toBe(true); return result.data; }
export async function apiProposal(request: APIRequestContext) {
  const client = await api(request);
  const search = await client.call<{ orders: { orderId: string }[] }>("/orders?query=ORD-1001");
  const order = (await client.call<OrderDetails>(`/orders/${search.data.orders[0]!.orderId}`)).data;
  const check = (await client.call<EligibilityResult>("/eligibility-checks", "POST", { orderId: order.orderId, orderItemId: order.items[0]!.orderItemId, requestedQuantity: 1, reasonCode: "wrong_size", conditionCode: "unopened" })).data;
  const input = { caseId: check.caseId, eligibilityCheckId: check.eligibilityCheckId, resolutionType: "refund", customerMessage: { subject: "Review", bodyText: "Please review this demo refund.", locale: "en-US" } };
  const proposal = (await client.call<ProposalResult>("/rma-proposals", "POST", input)).data;
  return { ...client, proposal, check, input };
}


