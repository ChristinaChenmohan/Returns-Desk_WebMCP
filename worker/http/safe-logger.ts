export type SafeLog = Partial<Record<"requestId" | "correlationId" | "route" | "status" | "durationMs" | "errorCode" | "entityType", string | number>>;
export function safeLog(input: Readonly<Record<string, unknown>>, sink: (entry: SafeLog) => void = entry => console.log(JSON.stringify(entry))): void {
  const entry: SafeLog = {};
  for (const key of ["requestId", "correlationId", "errorCode", "entityType"] as const) {
    const value = input[key]; if (typeof value === "string" && /^[A-Za-z0-9_:-]{1,80}$/.test(value)) entry[key] = value;
  }
  if (typeof input.route === "string" && /^\/(?:[a-z0-9-]+|:[A-Za-z]+|\*)(?:\/(?:[a-z0-9-]+|:[A-Za-z]+|\*))*$/.test(input.route) && input.route.length <= 160) entry.route = input.route;
  if (typeof input.status === "number" && Number.isInteger(input.status) && input.status >= 100 && input.status <= 599) entry.status = input.status;
  if (typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs >= 0) entry.durationMs = Math.min(Math.round(input.durationMs), 300_000);
  sink(entry);
}
