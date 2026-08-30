import type { ErrorEnvelope } from "../../src/shared/contracts/api";
import { DomainError } from "../domain/errors";
import type { RequestContext } from "./context";

const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  FORBIDDEN: "You do not have permission to perform this action.",
  INVALID_REQUEST: "The request is invalid.",
  SESSION_EXPIRED: "The demo session has expired.",
  DEMO_SESSION_RESET: "The demo session changed. Reload the demo and try again.",
  ENTITY_NOT_FOUND: "The requested resource was not found.",
  ENTITY_VERSION_CONFLICT: "The resource changed. Refresh it and try again.",
  IDEMPOTENCY_KEY_REUSED: "This idempotency key was already used for a different request.",
  RATE_LIMITED: "Too many requests were made. Try again later.",
  DEPENDENCY_UNAVAILABLE: "A required service is temporarily unavailable.",
  ELIGIBILITY_CHECK_STALE: "The eligibility check is no longer current.",
  ELIGIBILITY_NOT_ELIGIBLE: "This return is not eligible for the requested action.",
  MANUAL_REVIEW_REQUIRED: "This return requires human review.",
  RESOLUTION_NOT_ALLOWED: "The requested resolution is not allowed.",
  CUSTOMER_CONSENT_REQUIRED: "Customer consent is required for this resolution.",
  PENDING_PROPOSAL_CONFLICT: "This case already has a pending proposal.",
  PROPOSAL_EXPIRED: "This proposal has expired.",
  PROPOSAL_INVALIDATED: "This proposal is no longer valid.",
  PROPOSAL_NOT_PENDING: "This proposal is no longer pending.",
  EXCHANGE_INVENTORY_UNAVAILABLE: "The requested exchange inventory is unavailable.",
};

function safeMessage(code: string): string {
  if (code.endsWith("_NOT_FOUND") || code.endsWith("_RELATION_MISMATCH")) {
    return "The requested resource was not found.";
  }
  return SAFE_MESSAGES[code] ?? "The request could not be completed.";
}

export function mapError(error: unknown, context: RequestContext, now: Date): Response {
  const domainError = error instanceof DomainError ? error : null;
  const details: ErrorEnvelope["error"] = {
    code: domainError?.code ?? "INTERNAL_ERROR",
    message: domainError === null ? "The request could not be completed." : safeMessage(domainError.code),
    retryable: domainError?.retryable ?? false,
    correlationId: context.requestId,
    fieldErrors: [],
  };

  if (domainError?.currentState !== undefined) details.currentState = domainError.currentState;
  if (domainError?.recoveryAction !== undefined) details.recoveryAction = domainError.recoveryAction;

  const envelope: ErrorEnvelope = {
    error: details,
    meta: {
      requestId: context.requestId,
      serverTime: now.toISOString(),
      seedVersion: context.seedVersion,
    },
  };

  return Response.json(envelope, { status: domainError?.httpStatus ?? 500 });
}
