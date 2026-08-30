import type { SuccessEnvelope } from "../../src/shared/contracts/api";
import type { RequestContext } from "./context";

export function successEnvelope<T>(
  data: T,
  context: RequestContext,
  now: Date,
): SuccessEnvelope<T> {
  return {
    data,
    meta: {
      requestId: context.requestId,
      serverTime: now.toISOString(),
      seedVersion: context.seedVersion,
    },
  };
}

export function jsonSuccess<T>(data: T, context: RequestContext, now: Date, status = 200): Response {
  return Response.json(successEnvelope(data, context, now), { status });
}
