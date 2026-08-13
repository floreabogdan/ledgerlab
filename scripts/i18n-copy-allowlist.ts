export type I18nCopyAllowlistEntry = Readonly<{
  file: string;
  text: string;
  reason: string;
}>;

/**
 * Product names and other deliberately untranslated presentation literals.
 * Keep this list narrow: protocol values, routes, CSS tokens, and identifiers
 * are excluded by the scanner and do not belong here.
 */
export const i18nCopyAllowlist: readonly I18nCopyAllowlistEntry[] = [
  {
    file: "src/app/(auth)/layout.tsx",
    text: "L",
    reason: "LedgerLab's untranslated brand monogram.",
  },
  {
    file: "src/components/app-shell.tsx",
    text: "L",
    reason: "LedgerLab's untranslated brand monogram.",
  },
  {
    file: "src/components/app-shell.tsx",
    text: "K",
    reason: "Keyboard shortcut key, not interface copy.",
  },
];
