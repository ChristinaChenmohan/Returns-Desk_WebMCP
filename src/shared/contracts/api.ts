import type { EffectRef } from "./common";

export type ResponseMeta = {
  requestId: string;
  serverTime: string;
  seedVersion: number;
};

export type SuccessEnvelope<T> = {
  data: T;
  meta: ResponseMeta;
  effects?: EffectRef[];
};

export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    correlationId: string;
    currentState?: string;
    recoveryAction?: string;
    fieldErrors: unknown[];
  };
  meta: ResponseMeta;
};
