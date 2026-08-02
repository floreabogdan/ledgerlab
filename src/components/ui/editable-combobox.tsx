"use client";

import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type HTMLInputAutoCompleteAttribute,
  type HTMLInputTypeAttribute,
  type KeyboardEvent,
} from "react";

import type { SelectComboboxOption } from "./select-combobox";
import styles from "./editable-combobox.module.css";
import { useTranslations } from "@/i18n/client";

export interface EditableComboboxProps {
  value: string;
  suggestions: readonly SelectComboboxOption[];
  onValueChange: (value: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  emptyMessage?: string;
  ariaLabel?: string;
  listboxLabel?: string;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: HTMLInputAutoCompleteAttribute;
  inputMode?: "none" | "text" | "decimal" | "numeric" | "tel" | "search" | "email" | "url";
  type?: Exclude<HTMLInputTypeAttribute, "number">;
  maxLength?: number;
  pattern?: string;
  className?: string;
  inputClassName?: string;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
}

interface PopoverPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function matches(option: SelectComboboxOption, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return `${option.value} ${option.label} ${option.description ?? ""}`
    .toLocaleLowerCase()
    .includes(needle);
}

function enabledIndex(
  options: readonly SelectComboboxOption[],
  from: number,
  direction: 1 | -1,
) {
  if (!options.length) return -1;
  let index = from;
  for (let attempts = 0; attempts < options.length; attempts += 1) {
    index = (index + direction + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

export function EditableCombobox({
  value,
  suggestions,
  onValueChange,
  id,
  name,
  placeholder,
  emptyMessage,
  ariaLabel,
  listboxLabel,
  describedBy,
  invalid = false,
  disabled = false,
  required = false,
  autoFocus = false,
  autoComplete = "off",
  inputMode,
  type = "text",
  maxLength,
  pattern,
  className,
  inputClassName,
  onBlur,
}: EditableComboboxProps) {
  const t = useTranslations();
  const resolvedEmptyMessage = emptyMessage ?? t("common.controls.editable.noMatches");
  const resolvedListboxLabel = listboxLabel ?? t("common.controls.suggestions");
  const generatedId = useId();
  const controlId = id ?? `editable-combobox-${generatedId}`;
  const listId = `${controlId}-listbox`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
  const filtered = useMemo(
    () => suggestions.filter((option) => matches(option, query)),
    [query, suggestions],
  );
  const activeIndex = activeValue === null
    ? -1
    : filtered.findIndex((option) => option.value === activeValue && !option.disabled);
  const activeOption = activeIndex >= 0 ? filtered[activeIndex] : undefined;

  useEffect(() => {
    if (!open) return;

    let animationFrame = 0;
    let needsSecondMeasurement = true;

    function updatePosition() {
      const input = inputRef.current;
      if (!input) return;

      const margin = 8;
      const gap = 7;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const rect = input.getBoundingClientRect();
      const width = Math.min(
        Math.max(rect.width, 260),
        Math.max(0, viewportWidth - margin * 2),
      );
      const left = Math.min(
        Math.max(margin, rect.left),
        Math.max(margin, viewportWidth - margin - width),
      );
      const height = Math.min(popoverRef.current?.scrollHeight ?? 320, 320);
      const spaceBelow = viewportHeight - rect.bottom - gap - margin;
      const spaceAbove = rect.top - gap - margin;
      const placeBelow = spaceBelow >= Math.min(height, 200) || spaceBelow >= spaceAbove;
      const availableHeight = Math.max(80, placeBelow ? spaceBelow : spaceAbove);
      const top = placeBelow
        ? rect.bottom + gap
        : Math.max(margin, rect.top - gap - Math.min(height, availableHeight));

      setPopoverPosition({ top, left, width, maxHeight: availableHeight });
      if (needsSecondMeasurement) {
        needsSecondMeasurement = false;
        animationFrame = requestAnimationFrame(updatePosition);
      }
    }

    function schedulePositionUpdate() {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(updatePosition);
    }

    function dismiss(event: PointerEvent) {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        closeSuggestions();
      }
    }

    schedulePositionUpdate();
    document.addEventListener("pointerdown", dismiss);
    window.addEventListener("resize", schedulePositionUpdate);
    window.addEventListener("scroll", schedulePositionUpdate, true);
    return () => {
      cancelAnimationFrame(animationFrame);
      document.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("resize", schedulePositionUpdate);
      window.removeEventListener("scroll", schedulePositionUpdate, true);
    };
  }, [filtered.length, open]);

  function scrollToOption(option: SelectComboboxOption | undefined) {
    if (!option) return;
    requestAnimationFrame(() => {
      optionRefs.current.get(option.value)?.scrollIntoView({ block: "nearest" });
    });
  }

  function showSuggestions({ queryValue = "" }: { queryValue?: string } = {}) {
    if (disabled || open) return;
    const initialQuery = queryValue;
    const nextOptions = suggestions.filter((option) => matches(option, initialQuery));
    const selected = nextOptions.find((option) => option.value === value && !option.disabled);
    const initial = selected ?? nextOptions.find((option) => !option.disabled);
    setQuery(initialQuery);
    setActiveValue(initial?.value ?? null);
    setPopoverPosition(null);
    setOpen(true);
    scrollToOption(initial);
  }

  function closeSuggestions({ restoreFocus = false } = {}) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => inputRef.current?.focus());
  }

  function choose(option: SelectComboboxOption | undefined) {
    if (!option || option.disabled) return;
    onValueChange(option.value);
    closeSuggestions({ restoreFocus: true });
  }

  function activate(index: number) {
    const option = filtered[index];
    if (!option || option.disabled) return;
    setActiveValue(option.value);
    scrollToOption(option);
  }

  function move(direction: 1 | -1) {
    const index = enabledIndex(filtered, activeIndex, direction);
    if (index >= 0) activate(index);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        showSuggestions();
        return;
      }
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" && open && event.altKey) {
      event.preventDefault();
      activate(filtered.findIndex((option) => !option.disabled));
    } else if (event.key === "End" && open && event.altKey) {
      event.preventDefault();
      const reverseIndex = [...filtered].reverse().findIndex((option) => !option.disabled);
      if (reverseIndex >= 0) activate(filtered.length - reverseIndex - 1);
    } else if (event.key === "Enter" && open && activeOption) {
      event.preventDefault();
      choose(activeOption);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      closeSuggestions({ restoreFocus: true });
    } else if (event.key === "Tab" && open) {
      closeSuggestions();
    }
  }

  return (
    <div ref={rootRef} className={clsx(styles.root, className)}>
      <input
        ref={inputRef}
        id={controlId}
        name={name}
        className={clsx(styles.input, inputClassName)}
        type={type}
        role="combobox"
        value={value}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        pattern={pattern}
        autoComplete={autoComplete}
        disabled={disabled}
        required={required}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && activeOption ? `${listId}-option-${activeIndex}` : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onFocus={() => showSuggestions()}
        onBlur={(event) => {
          const nextTarget = event.relatedTarget as Node | null;
          if (!nextTarget || (!rootRef.current?.contains(nextTarget) && !popoverRef.current?.contains(nextTarget))) {
            closeSuggestions();
          }
          onBlur?.(event);
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          onValueChange(nextValue);
          setQuery(nextValue);
          const nextOptions = suggestions.filter((option) => matches(option, nextValue));
          setActiveValue(nextOptions.find((option) => !option.disabled)?.value ?? null);
          if (!open) showSuggestions({ queryValue: nextValue });
        }}
        onKeyDown={handleKeyDown}
      />
      <button
        className={styles.toggle}
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label={open ? t("common.controls.editable.hideSuggestions") : t("common.controls.editable.showSuggestions")}
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) closeSuggestions({ restoreFocus: true });
          else {
            inputRef.current?.focus();
            showSuggestions();
          }
        }}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>

      {open && typeof document !== "undefined" ? createPortal((
        <div
          ref={popoverRef}
          className={styles.popover}
          style={{
            top: popoverPosition?.top ?? 0,
            left: popoverPosition?.left ?? 0,
            width: popoverPosition?.width ?? 0,
            maxHeight: popoverPosition?.maxHeight,
            visibility: popoverPosition ? "visible" : "hidden",
          } satisfies CSSProperties}
        >
          <div className={styles.caption}>
            <span>{t("common.controls.editable.resultCount", { count: filtered.length })}</span>
            <span>{t("common.controls.editable.customValuesAccepted")}</span>
          </div>
          <div id={listId} className={styles.list} role="listbox" aria-label={resolvedListboxLabel}>
            {filtered.length ? filtered.map((option, index) => (
              <button
                ref={(node) => {
                  if (node) optionRefs.current.set(option.value, node);
                  else optionRefs.current.delete(option.value);
                }}
                id={`${listId}-option-${index}`}
                className={styles.option}
                type="button"
                role="option"
                tabIndex={-1}
                disabled={option.disabled}
                aria-disabled={option.disabled || undefined}
                aria-selected={option.value === value}
                data-active={index === activeIndex || undefined}
                data-value={option.value}
                key={option.value}
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => {
                  if (!option.disabled) setActiveValue(option.value);
                }}
                onClick={() => choose(option)}
              >
                <span className={styles.optionCopy}>
                  <span className={styles.optionLabel}>{option.label}</span>
                  {option.description ? <span className={styles.optionDescription}>{option.description}</span> : null}
                </span>
                {option.value === value ? <Check className={styles.check} size={16} aria-hidden="true" /> : null}
              </button>
            )) : (
              <p className={styles.empty}>{resolvedEmptyMessage}</p>
            )}
          </div>
        </div>
      ), document.body) : null}
    </div>
  );
}
