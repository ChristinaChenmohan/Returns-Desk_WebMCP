import type { SuccessEnvelope, ErrorEnvelope } from "../shared/contracts/api";
import { ApiError } from "./errors";
export interface SessionAuth { csrfToken: string; seedVersion: number; humanChannelToken?: string; agentChannelToken?: string }
export class ApiClient {
  private auth: SessionAuth | null = null;
  private refreshedAt = 0;
  private initializing: Promise<SessionAuth> | null = null;
  constructor(private readonly channel: "human" | "agent" = "human", private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  get seedVersion() { return this.auth?.seedVersion ?? 0; }
  setAuth(auth: SessionAuth) { this.auth = auth; this.refreshedAt = Date.now(); }
  async bootstrap(): Promise<SessionAuth> {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const response = await this.fetcher(`/api/v1/session/${this.channel === "human" ? "bootstrap" : "agent-bootstrap"}`, { credentials: "same-origin" });
      const result = await this.decode<SessionAuth>(response); this.setAuth(result.data); return result.data;
    })();
    try { return await this.initializing; } finally { this.initializing = null; }
  }
  async call<T>(path: string, method = "GET", body?: unknown, key?: string, signal?: AbortSignal): Promise<SuccessEnvelope<T>> {
    if (!this.auth || Date.now() - this.refreshedAt > 240_000) await this.bootstrap();
    const auth = this.auth!;
    const headers = new Headers({ "X-Channel-Token": (this.channel === "human" ? auth.humanChannelToken : auth.agentChannelToken)! });
    if (method !== "GET") {
      headers.set("Content-Type", "application/json"); headers.set("X-CSRF-Token", auth.csrfToken);
      if (key) headers.set("Idempotency-Key", key);
    }
    const response = await this.fetcher(`/api/v1${path}`, { method, headers, credentials: "same-origin",
      ...(method === "GET" ? {} : { body: JSON.stringify({ ...body as object, expectedSeedVersion: auth.seedVersion }) }),
      ...(signal ? { signal } : {}) });
    return this.decode<T>(response);
  }
  async get<T>(path: string, signal?: AbortSignal): Promise<T> { return (await this.call<T>(path, "GET", undefined, undefined, signal)).data; }
  async write<T>(path: string, body: unknown, key?: string, method = "POST"): Promise<T> { return (await this.call<T>(path, method, body, key)).data; }
  private async decode<T>(response: Response): Promise<SuccessEnvelope<T>> {
    const body = await response.json() as SuccessEnvelope<T> | ErrorEnvelope;
    if (!response.ok || "error" in body) {
      if ("error" in body) throw new ApiError(body.error.code, response.status, body.error.message, body.error.retryable, body.error.recoveryAction);
      throw new ApiError("INVALID_RESPONSE", response.status, "Unable to load the response.");
    }
    return body;
  }
}
