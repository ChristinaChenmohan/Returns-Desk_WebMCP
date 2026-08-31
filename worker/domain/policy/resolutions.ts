import type { ResolutionType } from "../../../src/shared/contracts/common";
import type { AllowedResolution, EligibilityInput, ResolutionSettings } from "./types";

const RESOLUTION_ORDER: readonly ResolutionType[] = ["exchange", "refund", "store_credit"];

export interface ResolutionResult {
  options: readonly AllowedResolution[];
  reasonCodes: readonly string[];
  missingInformation: readonly string[];
}

export function generateResolutions(
  input: EligibilityInput,
  settings: ResolutionSettings,
): ResolutionResult {
  const allowed = new Set(settings.allowedResolutions);
  const options: AllowedResolution[] = [];
  const reasonCodes: string[] = [];
  const missingInformation: string[] = [];
  const requestedAmount = input.unitPriceCents * input.requestedQuantity;
  const baseAmount = Math.min(requestedAmount, input.refundableAmountRemainingCents);

  for (const type of RESOLUTION_ORDER) {
    if (!allowed.has(type)) continue;
    if (type === "exchange") {
      const replacement = input.replacementVariant;
      if (
        replacement === null
        || !replacement.active
        || replacement.inventoryQuantity < input.requestedQuantity
      ) {
        reasonCodes.push("EXCHANGE_INVENTORY_UNAVAILABLE");
        if (replacement === null) missingInformation.push("replacementVariantId");
        continue;
      }
      options.push({
        type,
        customerOutcome: `Exchange for ${replacement.sku}`,
        merchantCostCents: baseAmount,
        amountCents: null,
        currency: input.currency,
        returnRequired: settings.returnRequired,
        customerConsentRequired: false,
        replacementVariantId: replacement.id,
        replacementSku: replacement.sku,
        inventoryQuantity: replacement.inventoryQuantity,
        inventoryVersion: replacement.inventoryVersion,
        recommendationReasons: ["IN_STOCK"],
      });
      continue;
    }
    if (baseAmount <= 0) continue;
    if (type === "refund") {
      options.push({
        type,
        customerOutcome: "Refund to original payment method",
        merchantCostCents: baseAmount,
        amountCents: baseAmount,
        currency: input.currency,
        returnRequired: settings.returnRequired,
        customerConsentRequired: false,
        replacementVariantId: null,
        replacementSku: null,
        inventoryQuantity: null,
        inventoryVersion: null,
        recommendationReasons: ["ORIGINAL_PAYMENT_AVAILABLE"],
      });
      continue;
    }
    const bonus = roundBasisPoints(baseAmount, settings.storeCreditBonusBps)
      + settings.storeCreditBonusCents;
    const creditAmount = baseAmount + bonus;
    options.push({
      type,
      customerOutcome: "Store credit",
      merchantCostCents: creditAmount,
      amountCents: creditAmount,
      currency: input.currency,
      returnRequired: settings.returnRequired,
      customerConsentRequired: !input.storeCreditConsent,
      replacementVariantId: null,
      replacementSku: null,
      inventoryQuantity: null,
      inventoryVersion: null,
      recommendationReasons: input.storeCreditConsent
        ? ["CUSTOMER_CONSENT_CONFIRMED"]
        : ["CUSTOMER_CONSENT_REQUIRED"],
    });
    if (!input.storeCreditConsent) reasonCodes.push("CUSTOMER_CONSENT_REQUIRED");
  }

  return {
    options,
    reasonCodes: [...new Set(reasonCodes)],
    missingInformation: [...new Set(missingInformation)],
  };
}

function roundBasisPoints(cents: number, basisPoints: number): number {
  return Number((BigInt(cents) * BigInt(basisPoints) + 5_000n) / 10_000n);
}
