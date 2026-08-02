import { describe, expect, it } from "vitest";

import {
  checkHardcodedCopy,
  findHardcodedCopy,
} from "../../scripts/i18n-copy";

describe("hard-coded interface copy guard", () => {
  it("finds visible JSX, presentation props, client errors, and message objects", () => {
    const violations = findHardcodedCopy(`
      export function Example() {
        const reason = "diagnostic";
        setActionError("Could not save");
        throw new Error(\`Could not save \${reason}\`);
        throw new Error("Choose an account");
        return <section aria-label="Account summary">
          Save changes
          <Widget
            aria-label={"Choose account"}
            info="How totals work"
            title="Monthly plan"
          />
          {{ title: "Review spending" }.title}
        </section>;
      }
    `);

    expect(violations.map((item) => item.text)).toEqual(expect.arrayContaining([
      "Choose an account",
      "Choose account",
      "Could not save",
      "Account summary",
      "How totals work",
      "Save changes",
      "Monthly plan",
      "Review spending",
    ]));
  });

  it("ignores translation keys, protocol values, identifiers, and numeric examples", () => {
    const violations = findHardcodedCopy(`
      export function Example() {
        const status = "paid";
        return <form method="POST" className="form grid">
          {t("finance.transactions.actions.save")}
          {([[
            "expense",
            "finance.transactions.kinds.expense",
          ]] as const).map(([value, label]) => <button value={value}>{t(label)}</button>)}
          <input type="text" inputMode="decimal" placeholder="0.00" />
        </form>;
      }
    `);

    expect(violations).toEqual([]);
  });

  it("only scans rendered branches inside JSX expressions", () => {
    const violations = findHardcodedCopy(`
      export function Example({ ready }: { ready: boolean }) {
        return <section>
          <button className="button button-primary" onKeyDown={(event) => {
            if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          }}>
            {ready ? "Ready to import" : "Waiting for file"}
          </button>
        </section>;
      }
    `);

    expect(violations.map((item) => item.text)).toEqual([
      "Ready to import",
      "Waiting for file",
    ]);
  });

  it("finds lowercase single-word copy in presentation contexts", () => {
    const violations = findHardcodedCopy(`
      export function Example() {
        return <button aria-label={"save"}>save</button>;
      }
    `);

    expect(violations.map((item) => item.text)).toEqual(["save", "save"]);
  });

  it("finds copy nested in arrays and rendered collection callbacks", () => {
    const violations = findHardcodedCopy(`
      export function Example({ items }: { items: string[] }) {
        return <section>
          {["Save changes"].map((label) => <button>{label}</button>)}
          {items.map(() => "Remove item")}
        </section>;
      }
    `);

    expect(violations.map((item) => item.text)).toEqual([
      "Save changes",
      "Remove item",
    ]);
  });

  it("rejects blank reasons and duplicate allowlist identities", async () => {
    const result = await checkHardcodedCopy([], [
      { file: "src/example.tsx", text: "LedgerLab", reason: " " },
      { file: "src/duplicate.tsx", text: "Protocol name", reason: "Protocol token" },
      { file: "src/duplicate.tsx", text: "Protocol name", reason: "Repeated token" },
    ]);

    expect(result.invalidAllowlist.map((item) => item.problem)).toEqual([
      "reason must not be blank",
      "duplicate file and text identity",
    ]);
  });
});
