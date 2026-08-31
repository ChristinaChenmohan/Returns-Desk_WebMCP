import { createApp } from "../../worker/app";
import { SessionRepository } from "../../worker/repositories/session-repository";
import { approvalClock, approvalIds } from "./approval";
export const apiOrigin = "https://returns.test";
export const apiKey = "returns-desk-test-signing-key-32-bytes-long";
export async function apiFixture(db: D1Database) {
  const app = createApp({ db, sessionRepository: new SessionRepository(db, approvalClock, approvalIds),
    channelSigningKey: apiKey, clock: approvalClock, ids: approvalIds, allowedOrigin: apiOrigin });
  const bootstrap = await app.request(`${apiOrigin}/api/v1/session/bootstrap`);
  const auth = (await bootstrap.json()) as { data: { csrfToken: string; humanChannelToken: string; seedVersion: number } };
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { cookie, origin: apiOrigin, "content-type": "application/json",
    "x-csrf-token": auth.data.csrfToken, "x-channel-token": auth.data.humanChannelToken };
  const request = (path: string, method = "GET", body?: unknown, key = approvalIds.next("http"), token?: string) => app.request(`${apiOrigin}/api/v1${path}`, {
    method, headers: { ...headers, "idempotency-key": key, ...(token === undefined ? {} : { "x-channel-token": token }) },
    ...(body === undefined ? {} : { body: JSON.stringify({ expectedSeedVersion: auth.data.seedVersion, ...body as object }) }),
  });
  return { app, auth: auth.data, headers, cookie, request };
}
