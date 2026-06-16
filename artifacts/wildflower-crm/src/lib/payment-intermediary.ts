import { PaymentIntermediaryType } from "@workspace/api-client-react";
import { formatEnum } from "@/lib/format";

export const INTERMEDIARY_TYPES: PaymentIntermediaryType[] = [
  PaymentIntermediaryType.daf,
  PaymentIntermediaryType.giving_platform,
  PaymentIntermediaryType.private_wealth_manager,
];

export const NONE_TYPE = "__none__";

export function intermediaryTypeLabel(t: PaymentIntermediaryType): string {
  return t === PaymentIntermediaryType.daf ? "DAF" : formatEnum(t);
}
