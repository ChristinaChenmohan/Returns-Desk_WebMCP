import { orderRules } from "./rule-catalog";
import type { EligibilityInput, PolicyDefinition } from "./types";

export function hashEligibilityInput(input: EligibilityInput, policy: PolicyDefinition): string {
  return hashFacts(input, policy, true);
}

export function hashInvalidEligibilityInput(input: EligibilityInput, policy: PolicyDefinition): string {
  return hashFacts(input, policy, false);
}

function hashFacts(
  input: EligibilityInput,
  policy: PolicyDefinition,
  normalizeInstants: boolean,
): string {
  const replacement = input.replacementVariant;
  const facts = {
    input: {
      sessionId: input.sessionId,
      caseId: input.caseId,
      orderId: input.orderId,
      orderItemId: input.orderItemId,
      requestedQuantity: input.requestedQuantity,
      reasonCode: input.reasonCode,
      conditionCode: input.conditionCode,
      policyVersionId: input.policyVersionId,
      orderedAt: normalizeInstants ? normalizeInstant(input.orderedAt) : input.orderedAt,
      fulfilledAt: normalizeInstants ? normalizeOptionalInstant(input.fulfilledAt) : input.fulfilledAt,
      deliveredAt: normalizeInstants ? normalizeOptionalInstant(input.deliveredAt) : input.deliveredAt,
      evaluatedAt: normalizeInstants ? normalizeInstant(input.evaluatedAt) : input.evaluatedAt,
      category: input.category,
      finalSale: input.finalSale,
      allowedReturnConditions: [...input.allowedReturnConditions].sort(),
      fulfilledQuantity: input.fulfilledQuantity,
      previouslyReturnedQuantity: input.previouslyReturnedQuantity,
      currency: input.currency.toUpperCase(),
      unitPriceCents: input.unitPriceCents,
      refundableAmountRemainingCents: input.refundableAmountRemainingCents,
      replacementVariant: replacement === null ? null : {
        id: replacement.id,
        sku: replacement.sku,
        active: replacement.active,
        inventoryQuantity: replacement.inventoryQuantity,
        inventoryVersion: replacement.inventoryVersion,
        unitPriceCents: replacement.unitPriceCents,
      },
      storeCreditConsent: input.storeCreditConsent,
      reviewSource: input.reviewSource,
      humanReviewOutcome: input.humanReviewOutcome ?? null,
    },
    policy: {
      id: policy.id,
      name: policy.name,
      versionNumber: policy.versionNumber,
      defaultWindowDays: policy.defaultWindowDays,
      absoluteMaxWindowDays: policy.absoluteMaxWindowDays,
      defaultReturnRequired: policy.defaultReturnRequired,
      defaultResolutions: [...policy.defaultResolutions].sort(),
      returnShippingPayer: policy.returnShippingPayer,
      eligibilityTtlMinutes: policy.eligibilityTtlMinutes,
      rules: orderRules(policy.rules).map(rule => ({
        id: rule.id,
        ruleType: rule.ruleType,
        priority: rule.priority,
        conditions: normalizeRuleValue(rule.conditions),
        outcome: normalizeRuleValue(rule.outcome),
        explanation: rule.explanation,
        active: rule.active,
      })),
    },
  };
  return sha256(canonicalJson(facts));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  const entries = Object.keys(record)
    .filter(key => record[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function normalizeRuleValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => normalizeRuleValue(item)).sort((left: unknown, right: unknown) =>
      compareCodePoints(canonicalJson(left), canonicalJson(right)),
    );
  }
  if (value !== null && typeof value === "object") {
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Readonly<Record<string, unknown>>)[key];
      if (child !== undefined) normalized[key] = normalizeRuleValue(child);
    }
    return normalized;
  }
  return value;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeInstant(value: string): string {
  return new Date(value).toISOString();
}

function normalizeOptionalInstant(value: string | null): string | null {
  return value === null ? null : normalizeInstant(value);
}

function sha256(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const before15 = words[index - 15] ?? 0;
      const before2 = words[index - 2] ?? 0;
      const s0 = rotateRight(before15, 7) ^ rotateRight(before15, 18) ^ (before15 >>> 3);
      const s1 = rotateRight(before2, 17) ^ rotateRight(before2, 19) ^ (before2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + s0 + (words[index - 7] ?? 0) + s1) >>> 0;
    }
    let a = hash[0] ?? 0;
    let b = hash[1] ?? 0;
    let c = hash[2] ?? 0;
    let d = hash[3] ?? 0;
    let e = hash[4] ?? 0;
    let f = hash[5] ?? 0;
    let g = hash[6] ?? 0;
    let h = hash[7] ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }
  return Array.from(hash, word => word.toString(16).padStart(8, "0")).join("");
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
