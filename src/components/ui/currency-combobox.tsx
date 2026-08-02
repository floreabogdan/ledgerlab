"use client";

import clsx from "clsx";
import { Check, ChevronDown, Coins, Search } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import {
  DEFAULT_LOCALE,
  currencyCatalog,
  normalizeCurrencyCode,
  type CurrencyCatalogItem,
} from "@/lib/currencies";
import { useTranslations } from "@/i18n/client";
import type { Translator } from "@/i18n/runtime";

export interface CurrencyComboboxProps {
  value: string;
  onChange: (currency: string) => void;
  id?: string;
  name?: string;
  locale?: string;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  autoFocus?: boolean;
}

function optionLabel(item: CurrencyCatalogItem, t: Translator["translate"]) {
  const precision = item.minorUnitDigits === 0
    ? t("common.controls.currency.noDecimals")
    : t("common.controls.currency.decimalPlaces", { count: item.minorUnitDigits });
  return t("common.controls.currency.optionLabel", {
    code: item.code,
    name: item.name,
    precision,
  });
}

export function CurrencyCombobox({
  value,
  onChange,
  id,
  name,
  locale = DEFAULT_LOCALE,
  disabled = false,
  required = false,
  invalid = false,
  describedBy,
  className,
  autoFocus = false,
}: CurrencyComboboxProps) {
  const t = useTranslations();
  const generatedId = useId();
  const controlId = id ?? `currency-${generatedId}`;
  const listId = `${controlId}-listbox`;
  const searchId = `${controlId}-search`;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const normalizedValue = normalizeCurrencyCode(value);
  const catalog = useMemo(() => currencyCatalog(locale), [locale]);
  const selected = catalog.find((item) => item.code === normalizedValue);
  const filtered = useMemo(() => {
    // The profile locale is editable and can be temporarily incomplete while
    // somebody types (for example, `de-`). Currency search must remain usable
    // until that value reaches the validated settings boundary.
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return catalog;
    return catalog.filter((item) =>
      `${item.code} ${item.name} ${item.symbol}`.toLocaleLowerCase().includes(needle),
    );
  }, [catalog, query]);
  const resolvedActiveIndex = Math.min(activeIndex, Math.max(0, filtered.length - 1));
  const activeItem = filtered[resolvedActiveIndex];

  useEffect(() => {
    if (!open) return;
    function dismiss(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function showOptions() {
    if (disabled) return;
    setQuery("");
    setActiveIndex(Math.max(0, catalog.findIndex((item) => item.code === normalizedValue)));
    setOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  }

  function choose(item: CurrencyCatalogItem) {
    onChange(item.code);
    setOpen(false);
    setQuery("");
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function moveActive(nextIndex: number) {
    if (!filtered.length) return;
    const wrapped = (nextIndex + filtered.length) % filtered.length;
    setActiveIndex(wrapped);
    const code = filtered[wrapped]?.code;
    if (code) requestAnimationFrame(() => optionRefs.current.get(code)?.scrollIntoView({ block: "nearest" }));
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      // Keep Escape local to the open picker. Without stopping propagation a
      // containing dialog also receives the same key and closes entirely.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      requestAnimationFrame(() => triggerRef.current?.focus());
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveActive(filtered.length - 1);
    } else if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      choose(activeItem);
    }
  }

  return (
    <div
      className={clsx("currency-combobox", className)}
      ref={containerRef}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (!nextTarget || !event.currentTarget.contains(nextTarget)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        id={controlId}
        className="currency-combobox-trigger"
        type="button"
        role="combobox"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        aria-required={required || undefined}
        data-invalid={invalid || undefined}
        autoFocus={autoFocus}
        onClick={() => open ? setOpen(false) : showOptions()}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            showOptions();
          }
        }}
      >
        {required ? <span className="sr-only">{t("common.controls.currency.required")} </span> : null}
        <span className="currency-combobox-symbol" aria-hidden="true">{selected?.symbol ?? <Coins size={16} />}</span>
        <span className="currency-combobox-value">
          <strong>{selected?.code ?? (normalizedValue || t("common.controls.currency.choose"))}</strong>
          <span>{selected?.name ?? t("common.controls.currency.catalogHelp")}</span>
        </span>
        <ChevronDown className="currency-combobox-chevron" size={16} aria-hidden="true" />
      </button>
      {name ? <input type="hidden" name={name} value={normalizedValue} /> : null}

      {open ? (
        <div className="currency-combobox-popover">
          <label className="currency-combobox-search" htmlFor={searchId}>
            <Search size={15} aria-hidden="true" />
            <span className="sr-only">{t("common.controls.currency.searchLabel")}</span>
            <input
              ref={searchRef}
              id={searchId}
              role="combobox"
              type="search"
              value={query}
              autoComplete="off"
              placeholder={t("common.controls.currency.searchPlaceholder")}
              aria-autocomplete="list"
              aria-controls={listId}
              aria-expanded="true"
              aria-activedescendant={activeItem ? `${listId}-${activeItem.code}` : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleSearchKeyDown}
            />
          </label>
          <div className="currency-combobox-caption">
            <span>{query ? t("common.controls.currency.matches", { count: filtered.length }) : t("common.controls.currency.commonFirst")}</span>
            <span>{t("common.controls.currency.isoHeading")}</span>
          </div>
          <div className="currency-combobox-list" id={listId} role="listbox" aria-label={t("common.controls.currency.currenciesList")}>
            {filtered.length ? filtered.map((item, index) => (
              <button
                ref={(node) => {
                  if (node) optionRefs.current.set(item.code, node);
                  else optionRefs.current.delete(item.code);
                }}
                id={`${listId}-${item.code}`}
                className="currency-combobox-option"
                type="button"
                role="option"
                tabIndex={-1}
                aria-label={optionLabel(item, t)}
                aria-selected={item.code === normalizedValue}
                data-active={index === resolvedActiveIndex || undefined}
                key={item.code}
                onMouseMove={() => setActiveIndex(index)}
                onClick={() => choose(item)}
              >
                <span className="currency-combobox-symbol" aria-hidden="true">{item.symbol}</span>
                <span className="currency-combobox-option-copy">
                  <strong>{item.code}</strong>
                  <span>{item.name}</span>
                </span>
                {item.common ? <small>{t("common.controls.currency.commonGroup")}</small> : null}
                {item.code === normalizedValue ? <Check size={16} aria-hidden="true" /> : null}
              </button>
            )) : (
              <p className="currency-combobox-empty">{t("common.controls.currency.noMatches", { query })}</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
