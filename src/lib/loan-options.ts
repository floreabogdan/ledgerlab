export const LOAN_REFERENCE_INDEX_SUGGESTIONS = [
  { value: "IRCC", labelKey: "finance.loanOptions.referenceIndexes.ircc.label", descriptionKey: "finance.loanOptions.referenceIndexes.ircc.description" },
  { value: "ROBOR", labelKey: "finance.loanOptions.referenceIndexes.robor.label", descriptionKey: "finance.loanOptions.referenceIndexes.robor.description" },
  { value: "EURIBOR", labelKey: "finance.loanOptions.referenceIndexes.euribor.label", descriptionKey: "finance.loanOptions.referenceIndexes.euribor.description" },
  { value: "SOFR", labelKey: "finance.loanOptions.referenceIndexes.sofr.label", descriptionKey: "finance.loanOptions.referenceIndexes.sofr.description" },
  { value: "SONIA", labelKey: "finance.loanOptions.referenceIndexes.sonia.label", descriptionKey: "finance.loanOptions.referenceIndexes.sonia.description" },
  { value: "SARON", labelKey: "finance.loanOptions.referenceIndexes.saron.label", descriptionKey: "finance.loanOptions.referenceIndexes.saron.description" },
  { value: "Prime", labelKey: "finance.loanOptions.referenceIndexes.prime.label", descriptionKey: "finance.loanOptions.referenceIndexes.prime.description" },
  { value: "Central bank base rate", labelKey: "finance.loanOptions.referenceIndexes.centralBank.label", descriptionKey: "finance.loanOptions.referenceIndexes.centralBank.description" },
] as const;

export const LOAN_INTERVAL_MONTH_SUGGESTIONS = [
  { value: "1", labelKey: "finance.loanOptions.intervals.oneMonth" },
  { value: "3", labelKey: "finance.loanOptions.intervals.threeMonths" },
  { value: "6", labelKey: "finance.loanOptions.intervals.sixMonths" },
  { value: "12", labelKey: "finance.loanOptions.intervals.twelveMonths" },
] as const;
