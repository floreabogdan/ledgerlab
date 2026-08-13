import type { MessageKey } from "@/i18n/generated";
import type { Translator } from "@/i18n/runtime";

type DefaultCategoryNameKey =
  | "finance.defaultCategories.salary"
  | "finance.defaultCategories.otherIncome"
  | "finance.defaultCategories.housing"
  | "finance.defaultCategories.utilities"
  | "finance.defaultCategories.groceries"
  | "finance.defaultCategories.transport"
  | "finance.defaultCategories.health"
  | "finance.defaultCategories.education"
  | "finance.defaultCategories.dining"
  | "finance.defaultCategories.shopping"
  | "finance.defaultCategories.entertainment"
  | "finance.defaultCategories.travel";

export const DEFAULT_CATEGORY_TEMPLATES = [
  { nameKey: "finance.defaultCategories.salary", kind: "income", nature: null, priority: null, color: "#24735c" },
  { nameKey: "finance.defaultCategories.otherIncome", kind: "income", nature: null, priority: null, color: "#3d8b73" },
  { nameKey: "finance.defaultCategories.housing", kind: "expense", nature: "fixed", priority: "essential", color: "#7656a5" },
  { nameKey: "finance.defaultCategories.utilities", kind: "expense", nature: "fixed", priority: "essential", color: "#4f6f8f" },
  { nameKey: "finance.defaultCategories.groceries", kind: "expense", nature: "variable", priority: "essential", color: "#d0803f" },
  { nameKey: "finance.defaultCategories.transport", kind: "expense", nature: "variable", priority: "essential", color: "#3f7f91" },
  { nameKey: "finance.defaultCategories.health", kind: "expense", nature: "variable", priority: "essential", color: "#b45364" },
  { nameKey: "finance.defaultCategories.education", kind: "expense", nature: "variable", priority: "essential", color: "#5369a5" },
  { nameKey: "finance.defaultCategories.dining", kind: "expense", nature: "variable", priority: "discretionary", color: "#d05f54" },
  { nameKey: "finance.defaultCategories.shopping", kind: "expense", nature: "variable", priority: "discretionary", color: "#a85f91" },
  { nameKey: "finance.defaultCategories.entertainment", kind: "expense", nature: "variable", priority: "discretionary", color: "#85724a" },
  { nameKey: "finance.defaultCategories.travel", kind: "expense", nature: "variable", priority: "discretionary", color: "#487c74" },
] as const satisfies ReadonlyArray<{
  nameKey: DefaultCategoryNameKey & MessageKey;
  kind: "income" | "expense";
  nature: "fixed" | "variable" | null;
  priority: "essential" | "discretionary" | null;
  color: string;
}>;

export function localizedDefaultCategories(translator: Translator) {
  return DEFAULT_CATEGORY_TEMPLATES.map((template, displayOrder) => ({
    name: translator.translate(template.nameKey),
    kind: template.kind,
    spendingNature: template.nature,
    spendingPriority: template.priority,
    color: template.color,
    displayOrder,
  }));
}
