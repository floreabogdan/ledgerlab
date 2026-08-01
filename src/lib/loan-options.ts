export const LOAN_REFERENCE_INDEX_SUGGESTIONS = [
  { value: "IRCC", label: "IRCC", description: "Romanian consumer credit reference index" },
  { value: "ROBOR", label: "ROBOR", description: "Romanian interbank offered rate" },
  { value: "EURIBOR", label: "EURIBOR", description: "Euro interbank offered rate" },
  { value: "SOFR", label: "SOFR", description: "US secured overnight financing rate" },
  { value: "SONIA", label: "SONIA", description: "Sterling overnight index average" },
  { value: "SARON", label: "SARON", description: "Swiss average rate overnight" },
  { value: "Prime", label: "Prime", description: "Bank prime rate" },
  { value: "Central bank base rate", label: "Central bank base rate", description: "Jurisdiction-specific policy rate" },
] as const;

export const LOAN_INTERVAL_MONTH_SUGGESTIONS = [
  { value: "1", label: "1 month" },
  { value: "3", label: "3 months" },
  { value: "6", label: "6 months" },
  { value: "12", label: "12 months" },
] as const;
