"use client";

import clsx from "clsx";
import { Check, ChevronDown, Search } from "lucide-react";
import { createPortal } from "react-dom";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import styles from "./select-combobox.module.css";

export interface SelectComboboxOption {
  value: string;
  label: string;
  description?: string;
  leading?: ReactNode;
  disabled?: boolean;
}

export interface SelectComboboxProps {
  value: string;
  options: readonly SelectComboboxOption[];
  onChange: (value: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  ariaLabel?: string;
  listboxLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className?: string;
  triggerClassName?: string;
  autoFocus?: boolean;
}

interface PopoverPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

function optionMatches(option: SelectComboboxOption, query: string) {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return true;
  return `${option.label} ${option.description ?? ""} ${option.value}`
    .toLocaleLowerCase()
    .includes(needle);
}

function firstEnabledIndex(options: readonly SelectComboboxOption[]) {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabledIndex(options: readonly SelectComboboxOption[]) {
  return options.findLastIndex((option) => !option.disabled);
}

const focusableSelector = [
  "button:not([disabled]):not([hidden])",
  "input:not([disabled]):not([hidden]):not([type='hidden'])",
  "select:not([disabled]):not([hidden])",
  "textarea:not([disabled]):not([hidden])",
  "a[href]:not([hidden])",
  "[tabindex]:not([tabindex='-1']):not([hidden])",
].join(", ");

export function SelectCombobox({
  value,
  options,
  onChange,
  id,
  name,
  placeholder = "Choose an option",
  searchable = false,
  searchPlaceholder = "Search options",
  emptyMessage = "No matching options.",
  ariaLabel,
  listboxLabel = "Options",
  disabled = false,
  invalid = false,
  describedBy,
  className,
  triggerClassName,
  autoFocus = false,
}: SelectComboboxProps) {
  const generatedId = useId();
  const controlId = id ?? `select-combobox-${generatedId}`;
  const listId = `${controlId}-listbox`;
  const searchId = `${controlId}-search`;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const typeaheadRef = useRef("");
  const typeaheadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
  const popoverReady = popoverPosition !== null;
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(
    () => options.filter((option) => optionMatches(option, query)),
    [options, query],
  );
  const requestedActiveIndex = activeValue === null
    ? -1
    : filtered.findIndex((option) => option.value === activeValue && !option.disabled);
  const activeIndex = requestedActiveIndex >= 0
    ? requestedActiveIndex
    : firstEnabledIndex(filtered);
  const activeOption = activeIndex >= 0 ? filtered[activeIndex] : undefined;

  useEffect(() => () => {
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
  }, []);

  useEffect(() => {
    if (!open || !searchable || !popoverReady) return;
    const animationFrame = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(animationFrame);
  }, [open, popoverReady, searchable]);

  useEffect(() => {
    if (!open) return;

    let animationFrame = 0;
    let needsSecondMeasurement = true;

    function updatePosition() {
      const trigger = triggerRef.current;
      if (!trigger) return;

      const margin = 8;
      const gap = 7;
      const viewportWidth = document.documentElement.clientWidth;
      const viewportHeight = document.documentElement.clientHeight;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(
        Math.max(rect.width, 240),
        Math.max(0, viewportWidth - margin * 2),
      );
      const left = Math.min(
        Math.max(margin, rect.left),
        Math.max(margin, viewportWidth - margin - width),
      );
      const height = Math.min(popoverRef.current?.scrollHeight ?? 360, 360);
      const spaceBelow = viewportHeight - rect.bottom - gap - margin;
      const spaceAbove = rect.top - gap - margin;
      const placeBelow = spaceBelow >= Math.min(height, 220) || spaceBelow >= spaceAbove;
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
      if (
        !containerRef.current?.contains(target)
        && !popoverRef.current?.contains(target)
      ) {
        setOpen(false);
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
  }, [filtered.length, open, searchable]);

  function scrollToOption(option: SelectComboboxOption | undefined) {
    if (!option) return;
    requestAnimationFrame(() => {
      optionRefs.current.get(option.value)?.scrollIntoView({ block: "nearest" });
    });
  }

  function showOptions(initial: "selected" | "first" | "last" = "selected") {
    if (disabled) return;
    setQuery("");
    setPopoverPosition(null);

    const selectedIsEnabled = selected && !selected.disabled;
    const initialOption = initial === "first"
      ? options[firstEnabledIndex(options)]
      : initial === "last"
        ? options[lastEnabledIndex(options)]
        : selectedIsEnabled
          ? selected
          : options[firstEnabledIndex(options)];

    setActiveValue(initialOption?.value ?? null);
    setOpen(true);
    scrollToOption(initialOption);
  }

  function closeOptions({ restoreFocus = false } = {}) {
    setOpen(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function focusAdjacentToTrigger(backwards: boolean) {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const dialog = trigger.closest<HTMLElement>("[role='dialog']");
    const scope: ParentNode = dialog ?? document;
    const focusable = Array.from(scope.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => (
        element.getClientRects().length > 0
        && !element.matches(":disabled")
        && !element.closest("[inert], [aria-hidden='true']")
        && !popoverRef.current?.contains(element)
      ));
    const triggerIndex = focusable.indexOf(trigger);
    if (triggerIndex < 0 || focusable.length < 2) {
      trigger.focus();
      return;
    }

    const offset = backwards ? -1 : 1;
    const nextIndex = (triggerIndex + offset + focusable.length) % focusable.length;
    focusable[nextIndex]?.focus();
  }

  function choose(option: SelectComboboxOption | undefined) {
    if (!option || option.disabled) return;
    onChange(option.value);
    closeOptions({ restoreFocus: true });
  }

  function activateAt(index: number) {
    const option = filtered[index];
    if (!option || option.disabled) return;
    setActiveValue(option.value);
    scrollToOption(option);
  }

  function moveActive(direction: 1 | -1) {
    if (!filtered.length) return;

    let nextIndex = activeIndex;
    for (let attempts = 0; attempts < filtered.length; attempts += 1) {
      nextIndex = (nextIndex + direction + filtered.length) % filtered.length;
      if (!filtered[nextIndex]?.disabled) {
        activateAt(nextIndex);
        return;
      }
    }
  }

  function handleTypeaheadKey(event: KeyboardEvent<HTMLElement>) {
    if (
      searchable
      || disabled
      || event.key.length !== 1
      || event.key === " "
      || event.altKey
      || event.ctrlKey
      || event.metaKey
    ) {
      return false;
    }

    event.preventDefault();
    const character = event.key.toLocaleLowerCase();
    const combinedPrefix = `${typeaheadRef.current}${character}`;
    const currentIndex = open
      ? activeIndex
      : options.findIndex((option) => option.value === selected?.value);

    function findMatch(prefix: string) {
      for (let offset = 1; offset <= options.length; offset += 1) {
        const index = (currentIndex + offset + options.length) % options.length;
        const option = options[index];
        if (
          option
          && !option.disabled
          && option.label.trim().toLocaleLowerCase().startsWith(prefix)
        ) {
          return index;
        }
      }
      return -1;
    }

    let prefix = combinedPrefix;
    let matchIndex = findMatch(prefix);
    if (matchIndex < 0 && prefix.length > 1) {
      prefix = character;
      matchIndex = findMatch(prefix);
    }

    typeaheadRef.current = prefix;
    if (typeaheadTimerRef.current) clearTimeout(typeaheadTimerRef.current);
    typeaheadTimerRef.current = setTimeout(() => {
      typeaheadRef.current = "";
      typeaheadTimerRef.current = null;
    }, 700);

    const match = options[matchIndex];
    if (!match) return true;
    if (open) activateAt(matchIndex);
    else choose(match);
    return true;
  }

  function handleNavigationKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      activateAt(firstEnabledIndex(filtered));
    } else if (event.key === "End") {
      event.preventDefault();
      activateAt(lastEnabledIndex(filtered));
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(activeOption);
    }
  }

  return (
    <div
      ref={containerRef}
      className={clsx(styles.root, className)}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null;
        if (
          !nextTarget
          || (
            !event.currentTarget.contains(nextTarget)
            && !popoverRef.current?.contains(nextTarget)
          )
        ) {
          closeOptions();
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          closeOptions({ restoreFocus: true });
        } else if (event.key === "Tab" && open) {
          if (popoverRef.current?.contains(event.target as Node)) {
            event.preventDefault();
            event.stopPropagation();
            focusAdjacentToTrigger(event.shiftKey);
          }
          closeOptions();
        }
      }}
    >
      <button
        ref={triggerRef}
        id={controlId}
        className={clsx(
          styles.trigger,
          selected?.leading && styles.triggerWithLeading,
          triggerClassName,
        )}
        type="button"
        role="combobox"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={!searchable && open && activeOption
          ? `${listId}-option-${activeIndex}`
          : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoFocus={autoFocus}
        onClick={() => (open ? closeOptions() : showOptions())}
        onKeyDown={(event) => {
          if (handleTypeaheadKey(event)) return;
          if (!open) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              showOptions("selected");
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              showOptions(value ? "selected" : "last");
            } else if (event.key === "Home") {
              event.preventDefault();
              showOptions("first");
            } else if (event.key === "End") {
              event.preventDefault();
              showOptions("last");
            } else if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              showOptions();
            }
          } else if (!searchable) {
            if (event.key === " ") {
              event.preventDefault();
              choose(activeOption);
            } else {
              handleNavigationKey(event);
            }
          }
        }}
      >
        {selected?.leading ? (
          <span className={styles.leading} aria-hidden="true">{selected.leading}</span>
        ) : null}
        <span className={clsx(styles.selectedLabel, !selected && styles.placeholder)}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
      </button>

      {name ? <input className={styles.hiddenInput} type="hidden" name={name} value={value} disabled={disabled} /> : null}

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
          {searchable ? (
            <label className={styles.search} htmlFor={searchId}>
              <Search size={15} aria-hidden="true" />
              <span className="sr-only">{searchPlaceholder}</span>
              <input
                ref={searchRef}
                id={searchId}
                className={styles.searchInput}
                role="searchbox"
                type="search"
                value={query}
                autoComplete="off"
                placeholder={searchPlaceholder}
                aria-controls={listId}
                aria-activedescendant={activeOption ? `${listId}-option-${activeIndex}` : undefined}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  const nextOptions = options.filter((option) => optionMatches(option, nextQuery));
                  setQuery(nextQuery);
                  setActiveValue(nextOptions.find((option) => !option.disabled)?.value ?? null);
                }}
                onKeyDown={handleNavigationKey}
              />
            </label>
          ) : null}

          {searchable ? (
            <p className={styles.resultCount} role="status" aria-live="polite">
              {filtered.length} {filtered.length === 1 ? "option" : "options"}
            </p>
          ) : null}

          <div
            className={styles.list}
            id={listId}
            role="listbox"
            aria-label={listboxLabel}
          >
            {filtered.length ? filtered.map((option, index) => (
              <button
                ref={(node) => {
                  if (node) optionRefs.current.set(option.value, node);
                  else optionRefs.current.delete(option.value);
                }}
                id={`${listId}-option-${index}`}
                className={clsx(styles.option, option.leading && styles.optionWithLeading)}
                type="button"
                role="option"
                tabIndex={-1}
                disabled={option.disabled}
                aria-disabled={option.disabled || undefined}
                aria-selected={option.value === value}
                data-value={option.value}
                data-active={index === activeIndex || undefined}
                key={option.value}
                onPointerMove={() => {
                  if (!option.disabled) setActiveValue(option.value);
                }}
                onClick={() => choose(option)}
              >
                {option.leading ? (
                  <span className={styles.optionLeading} aria-hidden="true">{option.leading}</span>
                ) : null}
                <span className={styles.optionCopy}>
                  <span className={styles.optionLabel}>{option.label}</span>
                  {option.description ? (
                    <span className={styles.optionDescription}>{option.description}</span>
                  ) : null}
                </span>
                {option.value === value ? <Check className={styles.check} size={16} aria-hidden="true" /> : null}
              </button>
            )) : (
              <p className={styles.empty}>{emptyMessage}</p>
            )}
          </div>
        </div>
      ), document.body) : null}
    </div>
  );
}
