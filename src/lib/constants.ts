export const ACCOUNT_TYPES = [
  "current",
  "savings",
  "cash",
  "credit_card",
  "loan",
  "investment",
  "custom",
] as const;

export const TRANSACTION_KINDS = ["income", "expense", "transfer", "refund", "adjustment"] as const;
export const TRANSACTION_STATUSES = ["pending", "cleared"] as const;
export const RECURRENCE_FREQUENCIES = ["weekly", "monthly", "quarterly", "yearly"] as const;
