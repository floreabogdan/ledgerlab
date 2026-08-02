"use client";

import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  Children,
  Fragment,
  createContext,
  isValidElement,
  type FormEvent,
  type HTMLAttributes,
  type OptionHTMLAttributes,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dialog } from "@/components/ui/dialog";
import { EditableCombobox } from "@/components/ui/editable-combobox";
import {
  SelectCombobox,
  type SelectComboboxOption,
} from "@/components/ui/select-combobox";
import { InfoTooltip } from "@/components/ui/tooltip";
import { useTranslator, useTranslations } from "@/i18n/client";
import { defaultLanguage, messageCatalogs } from "@/i18n/generated";
import { createTranslator, type Translator } from "@/i18n/runtime";
import { parseApiError, translateApiError } from "@/lib/api-error";
import type { ApiErrorDescriptor } from "@/lib/api-response";
import {
  currencyMinorToInput,
  currencyMinorUnitDigits,
  currencyMinorUnitScale,
  parseCurrencyAmountToMinor,
} from "@/lib/domain/currency";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";
import styles from "./feature.module.css";

type JsonRecord = Record<string, unknown>;

const cx = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(" ");

const moneyFormatters = new Map<string, Intl.NumberFormat>();
const englishTranslator = createTranslator({
  language: defaultLanguage,
  catalog: messageCatalogs[defaultLanguage],
  fallbackCatalog: messageCatalogs[defaultLanguage],
});

function activeBrowserTranslator() {
  if (typeof document === "undefined") return englishTranslator;
  const requestedLanguage = document.documentElement.lang || defaultLanguage;
  const catalogs = messageCatalogs as Readonly<
    Record<string, (typeof messageCatalogs)[typeof defaultLanguage] | undefined>
  >;
  const catalog = catalogs[requestedLanguage] ?? messageCatalogs[defaultLanguage];
  return createTranslator({
    language: requestedLanguage,
    direction: document.documentElement.dir === "rtl" ? "rtl" : "ltr",
    catalog,
    fallbackCatalog: messageCatalogs[defaultLanguage],
    fallbackLanguage: defaultLanguage,
    formattingLocale:
      document.documentElement.dataset.locale || requestedLanguage,
    timeZone: document.documentElement.dataset.timeZone || undefined,
  });
}

type FieldContextValue = {
  controlId: string;
  descriptionId?: string;
  invalid: boolean;
  label: string;
};

const FieldContext = createContext<FieldContextValue | null>(null);

export function workspaceLocale() {
  return typeof document === "undefined"
    ? DEFAULT_LOCALE
    : document.documentElement.dataset.locale || DEFAULT_LOCALE;
}

export function workspaceTimeZone() {
  return typeof document === "undefined"
    ? DEFAULT_TIME_ZONE
    : document.documentElement.dataset.timeZone || DEFAULT_TIME_ZONE;
}

function workspaceCurrency() {
  return typeof document === "undefined"
    ? DEFAULT_CURRENCY
    : document.documentElement.dataset.currency || DEFAULT_CURRENCY;
}

function getMoneyFormatter(currency: string, digits: number, locale: string) {
  const key = `${locale}:${currency}:${digits}`;
  const cached = moneyFormatters.get(key);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  moneyFormatters.set(key, formatter);
  return formatter;
}

export function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

export function readList<T = JsonRecord>(value: unknown, ...keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  let cursor: unknown = value;
  for (const key of ["data", ...keys]) {
    const object = readRecord(cursor);
    if (Array.isArray(object[key])) return object[key] as T[];
    if (object[key] && typeof object[key] === "object") cursor = object[key];
  }
  const record = readRecord(value);
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as T[];
  }
  return [];
}

export function numberFrom(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function stringFrom(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function useJson<T>(url: string, fallback: T) {
  const translator = useTranslator();
  const t = translator.translate;
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    if (!mountedRef.current) return;
    const requestId = ++requestIdRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const apiError = parseApiError(body);
        throw new RequestError(
          response.status,
          translateApiError(translator, apiError),
          body && typeof body === "object" && !Array.isArray(body)
            ? body as JsonRecord
            : null,
          apiError,
        );
      }
      if (!mountedRef.current || controller.signal.aborted || requestId !== requestIdRef.current) return;
      setData((body ?? fallback) as T);
    } catch (caught) {
      if (!mountedRef.current || controller.signal.aborted || requestId !== requestIdRef.current) return;
      setError(caught instanceof RequestError ? caught.message : t("common.request.unexpected"));
    } finally {
      if (mountedRef.current && requestId === requestIdRef.current) {
        controllerRef.current = null;
        setLoading(false);
      }
    }
  // `fallback` is only an initial/empty-state value. Depending on object identity
  // here would refetch forever when a page supplies an inline empty object.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, translator, url]);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    // Start after the effect body so React does not receive a synchronous
    // state transition while it is committing the component tree.
    queueMicrotask(() => {
      if (active) void reload();
    });
    return () => {
      active = false;
      mountedRef.current = false;
      requestIdRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [reload]);

  return { data, setData, loading, error, reload };
}

export class RequestError extends Error {
  readonly status: number;
  readonly body: JsonRecord | null;
  readonly apiError: ApiErrorDescriptor | null;

  constructor(
    status: number,
    message: string,
    body: JsonRecord | null,
    apiError: ApiErrorDescriptor | null,
  ) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.body = body;
    this.apiError = apiError;
  }
}

export async function requestJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  translator?: Translator,
): Promise<T> {
  const activeTranslator = translator ?? activeBrowserTranslator();
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  headers.set("Accept", "application/json");
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch {
    throw new RequestError(
      0,
      activeTranslator.translate("common.request.unexpected"),
      null,
      null,
    );
  }
  const body = (await response.json().catch(() => null)) as JsonRecord | null;
  if (!response.ok) {
    const apiError = parseApiError(body);
    throw new RequestError(
      response.status,
      translateApiError(activeTranslator, apiError),
      body,
      apiError,
    );
  }
  return body as T;
}

export function formatMoney(minorUnits: unknown, currency?: string) {
  const amount = numberFrom(minorUnits);
  currency ??= workspaceCurrency();
  const digits = currencyMinorUnitDigits(currency);
  return getMoneyFormatter(currency, digits, workspaceLocale()).format(amount / currencyMinorUnitScale(currency));
}

export function moneyInputToMinor(value: string, currency?: string) {
  return parseCurrencyAmountToMinor(value, currency ?? workspaceCurrency());
}

export function minorToInput(value: unknown, currency?: string) {
  return currencyMinorToInput(numberFrom(value), currency ?? workspaceCurrency());
}

export function formatDate(value: unknown, options?: Intl.DateTimeFormatOptions) {
  if (!value) return "—";
  const raw = String(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const date = new Date(dateOnly ? `${raw}T12:00:00.000Z` : raw);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(workspaceLocale(), {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: dateOnly ? "UTC" : workspaceTimeZone(),
    ...options,
  }).format(date);
}

export function isoToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: workspaceTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function monthKey(offset = 0) {
  const today = isoToday();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function ViewHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className={styles.viewHeader}>
      <div>
        {eyebrow ? <p className={styles.eyebrow}>{eyebrow}</p> : null}
        <h1>{title}</h1>
        {description ? <p className={styles.viewDescription}>{description}</p> : null}
      </div>
      {actions ? <div className={styles.headerActions}>{actions}</div> : null}
    </header>
  );
}

export function Section({
  title,
  description,
  action,
  children,
  className,
  plain = false,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  plain?: boolean;
}) {
  return (
    <section className={cx(styles.section, plain && styles.sectionPlain, className)}>
      {title || description || action ? (
        <div className={styles.sectionHeader}>
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {action ? <div className={styles.sectionAction}>{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  detail,
  tone = "default",
  info,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: "default" | "positive" | "negative" | "warning" | "accent";
  info?: string;
}) {
  return (
    <div className={cx(styles.metric, styles[`tone_${tone}`])}>
      <div className={styles.metricLabel}>
        <span>{label}</span>
        {info ? <InfoButton text={info} /> : null}
      </div>
      <strong>{value}</strong>
      {detail ? <span className={styles.metricDetail}>{detail}</span> : null}
    </div>
  );
}

export function InfoButton({ text }: { text: string }) {
  return <InfoTooltip content={text} />;
}

export function Button({
  children,
  variant = "primary",
  icon,
  className,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  icon?: ReactNode;
}) {
  return (
    <button {...props} type={type} className={cx(styles.button, styles[`button_${variant}`], className)}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      {children}
    </button>
  );
}

export function AddButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button {...props} icon={<Plus size={16} aria-hidden="true" />}>{children}</Button>;
}

export function IconButton({
  label,
  children,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button {...props} type={type} className={styles.iconButton} aria-label={label} title={label}>
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

export function Pill({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "negative" | "warning" | "info";
}) {
  return <span className={cx(styles.pill, styles[`pill_${tone}`])}>{children}</span>;
}

export function Field({
  label,
  hint,
  error,
  children,
  className,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  const generatedId = useId();
  const controlId = htmlFor ?? `field-${generatedId}`;
  const descriptionId = error ? `${controlId}-error` : hint ? `${controlId}-hint` : undefined;
  return (
    <FieldContext.Provider value={{ controlId, descriptionId, invalid: Boolean(error), label }}>
      <div className={cx(styles.field, className)}>
        <label className={styles.fieldLabel} htmlFor={controlId}>{label}</label>
        {children}
        {error
          ? <span className={styles.fieldError} id={descriptionId} role="alert">{error}</span>
          : hint
            ? <span className={styles.fieldHint} id={descriptionId}>{hint}</span>
            : null}
      </div>
    </FieldContext.Provider>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const field = useContext(FieldContext);
  return (
    <input
      {...props}
      id={props.id ?? field?.controlId}
      aria-describedby={props["aria-describedby"] ?? field?.descriptionId}
      aria-invalid={props["aria-invalid"] ?? (field?.invalid || undefined)}
      className={cx(styles.control, props.className)}
    />
  );
}

type SuggestionInputProps = {
  value: string;
  suggestions: readonly SelectComboboxOption[];
  onValueChange: (value: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  autoComplete?: React.InputHTMLAttributes<HTMLInputElement>["autoComplete"];
  inputMode?: React.InputHTMLAttributes<HTMLInputElement>["inputMode"];
  maxLength?: number;
  pattern?: string;
  className?: string;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
};

/** Editable text control with searchable suggestions. Values outside the list remain valid. */
export function SuggestionInput({
  value,
  suggestions,
  onValueChange,
  id,
  name,
  placeholder,
  emptyMessage,
  disabled,
  required,
  autoFocus,
  autoComplete,
  inputMode,
  maxLength,
  pattern,
  className,
  onBlur,
  ...props
}: SuggestionInputProps) {
  const t = useTranslations();
  const field = useContext(FieldContext);
  const ariaInvalid = props["aria-invalid"] === true
    || props["aria-invalid"] === "true"
    || field?.invalid
    || false;
  const ariaLabel = props["aria-label"];
  const accessibleName = String(
    ariaLabel ?? field?.label ?? t("common.controls.suggestions"),
  );

  return (
    <EditableCombobox
      id={id ?? field?.controlId}
      name={name}
      value={value}
      suggestions={suggestions}
      onValueChange={onValueChange}
      placeholder={placeholder}
      emptyMessage={emptyMessage}
      ariaLabel={ariaLabel}
      listboxLabel={t("common.controls.editable.namedList", { label: accessibleName })}
      describedBy={props["aria-describedby"] ?? field?.descriptionId}
      invalid={ariaInvalid}
      disabled={disabled}
      required={required}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      inputMode={inputMode}
      maxLength={maxLength}
      pattern={pattern}
      onBlur={onBlur}
      className={styles.selectRoot}
      inputClassName={cx(styles.control, className)}
    />
  );
}

type NativeOptionElement = ReactElement<OptionHTMLAttributes<HTMLOptionElement>>;

function optionLabel(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") return String(child);
      if (isValidElement<{ children?: ReactNode }>(child)) return optionLabel(child.props.children);
      return "";
    })
    .join("");
}

function comboboxOptions(children: ReactNode): SelectComboboxOption[] {
  return Children.toArray(children).flatMap((child): SelectComboboxOption[] => {
    if (!isValidElement<{ children?: ReactNode }>(child)) return [];
    if (child.type === Fragment) return comboboxOptions(child.props.children);
    if (child.type !== "option") return [];

    const option = child as NativeOptionElement;
    const label = optionLabel(option.props.children);
    return [{
      value: String(option.props.value ?? label),
      label,
      disabled: option.props.disabled,
    }];
  });
}

type FeatureSelectProps = Pick<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  | "id"
  | "name"
  | "disabled"
  | "autoFocus"
  | "className"
  | "aria-label"
  | "aria-describedby"
  | "aria-invalid"
> & {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
};

export function Select({
  children,
  value,
  onValueChange,
  id,
  name,
  disabled,
  autoFocus,
  className,
  searchable,
  searchPlaceholder,
  ...props
}: FeatureSelectProps) {
  const t = useTranslations();
  const field = useContext(FieldContext);
  const options = useMemo(() => comboboxOptions(children), [children]);
  const currentValue = String(value);
  const ariaInvalid = props["aria-invalid"] === true
    || props["aria-invalid"] === "true"
    || field?.invalid
    || false;
  const ariaLabel = props["aria-label"];
  const accessibleName = String(
    ariaLabel ?? field?.label ?? t("common.controls.options"),
  );

  return (
    <SelectCombobox
      id={id ?? field?.controlId}
      name={name}
      value={currentValue}
      options={options}
      onChange={onValueChange}
      searchable={searchable ?? options.length >= 8}
      searchPlaceholder={searchPlaceholder ?? t("common.controls.select.searchNamed", { label: accessibleName })}
      ariaLabel={ariaLabel}
      listboxLabel={t("common.controls.select.namedList", { label: accessibleName })}
      disabled={disabled}
      invalid={ariaInvalid}
      describedBy={props["aria-describedby"] ?? field?.descriptionId}
      autoFocus={autoFocus}
      className={styles.selectRoot}
      triggerClassName={cx(styles.control, className)}
    />
  );
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useContext(FieldContext);
  return (
    <textarea
      {...props}
      id={props.id ?? field?.controlId}
      aria-describedby={props["aria-describedby"] ?? field?.descriptionId}
      aria-invalid={props["aria-invalid"] ?? (field?.invalid || undefined)}
      className={cx(styles.control, styles.textarea, props.className)}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <label className={styles.toggleRow}>
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
  label,
  id,
  panelId,
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ value: T; label: string; count?: number }>;
  label: string;
  id?: string;
  panelId?: string;
}) {
  const hasTabPanel = Boolean(id && panelId);
  return (
    <div className={styles.tabs} role={hasTabPanel ? "tablist" : "group"} aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          id={hasTabPanel ? `${id}-${item.value}-tab` : undefined}
          type="button"
          role={hasTabPanel ? "tab" : undefined}
          aria-selected={hasTabPanel ? value === item.value : undefined}
          aria-pressed={hasTabPanel ? undefined : value === item.value}
          aria-controls={hasTabPanel ? panelId : undefined}
          tabIndex={value === item.value ? 0 : -1}
          className={cx(styles.tab, value === item.value && styles.tabActive)}
          onClick={() => onChange(item.value)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const currentIndex = items.findIndex((candidate) => candidate.value === item.value);
            const nextIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
            const nextValue = items[nextIndex]?.value;
            if (!nextValue) return;
            onChange(nextValue);
            const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button");
            tabs?.[nextIndex]?.focus();
          }}
        >
          {item.label}
          {item.count !== undefined ? <span>{item.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const t = useTranslations();
  const resolvedPlaceholder = placeholder ?? t("common.controls.search.label");
  const inputId = useId();
  return (
    <div className={styles.searchField}>
      <label className="sr-only" htmlFor={inputId}>{resolvedPlaceholder}</label>
      <Search size={17} aria-hidden="true" />
      <input id={inputId} type="search" value={value} onChange={(event) => onChange(event.target.value)} placeholder={resolvedPlaceholder} />
      {value ? (
        <button type="button" aria-label={t("common.controls.search.clear")} onClick={() => onChange("")}>
          <X size={15} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function DataState({
  loading,
  error,
  empty,
  emptyTitle,
  emptyDescription,
  onRetry,
  action,
  children,
}: {
  loading?: boolean;
  error?: string | null;
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onRetry?: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations();
  const resolvedEmptyTitle = emptyTitle ?? t("common.status.emptyTitle");
  const resolvedEmptyDescription = emptyDescription ?? t("common.status.emptyDescription");
  if (loading) {
    return (
      <div className={styles.state} role="status">
        <LoaderCircle className={styles.spin} aria-hidden="true" />
        <strong>{t("common.status.loading")}</strong>
        <span>{t("common.status.loadingDetails")}</span>
      </div>
    );
  }
  if (error) {
    return (
      <div className={cx(styles.state, styles.stateError)} role="alert">
        <AlertCircle aria-hidden="true" />
        <strong>{t("common.status.failureTitle")}</strong>
        <span>{error}</span>
        {onRetry ? <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={onRetry}>{t("common.actions.tryAgain")}</Button> : null}
      </div>
    );
  }
  if (empty) {
    return (
      <div className={styles.state}>
        <div className={styles.stateCheck}><Check size={19} aria-hidden="true" /></div>
        <strong>{resolvedEmptyTitle}</strong>
        <span>{resolvedEmptyDescription}</span>
        {action}
      </div>
    );
  }
  return <>{children}</>;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  wide = false,
  size,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  size?: "sm" | "md" | "lg" | "xl";
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      title={title}
      description={description}
      size={size ?? (wide ? "lg" : "md")}
      footer={footer}
    >
      {children}
    </Dialog>
  );
}

export function FormMessage({ error, success }: { error?: string | null; success?: string | null }) {
  if (!error && !success) return null;
  return (
    <div className={cx(styles.formMessage, error ? styles.formMessageError : styles.formMessageSuccess)} role={error ? "alert" : "status"}>
      {error ? <AlertCircle size={16} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
      {error || success}
    </div>
  );
}

export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.filterBar, className)}>{children}</div>;
}

export function ResponsiveTable({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className={styles.tableScroll} role="region" aria-label={label} tabIndex={0}>
      <table className={styles.table}>{children}</table>
    </div>
  );
}

export function SparkBars({
  values,
  labels,
  tone = "accent",
  height = 120,
}: {
  values: number[];
  labels?: string[];
  tone?: "accent" | "positive" | "negative" | "mixed";
  height?: number;
}) {
  const t = useTranslations();
  const max = Math.max(...values.map((item) => Math.abs(item)), 1);
  const chartLabels = values.map(
    (_, index) => labels?.[index] ?? t("common.controls.chart.valueLabel", { index: index + 1 }),
  );
  return (
    <div
      className={styles.sparkBars}
      style={{ height }}
      role="img"
      aria-label={chartLabels
        .map((label, index) => t("common.controls.chart.valueTitle", {
          label,
          amount: formatMoney(values[index] ?? 0),
        }))
        .join(", ")}
    >
      {values.map((value, index) => (
        <div className={styles.sparkColumn} key={`${index}-${labels?.[index] ?? ""}`}>
          <div className={styles.sparkTrack}>
            <span
              className={cx(
                styles.sparkBar,
                styles[`spark_${tone === "mixed" ? (value < 0 ? "negative" : "positive") : tone}`],
              )}
              style={{ height: `${Math.max(4, (Math.abs(value) / max) * 100)}%` }}
              title={t("common.controls.chart.valueTitle", {
                label: chartLabels[index] ?? t("common.controls.chart.valueLabel", { index: index + 1 }),
                amount: formatMoney(value),
              })}
            />
          </div>
          {labels?.[index] ? <small>{labels[index]}</small> : null}
        </div>
      ))}
    </div>
  );
}

export function Progress({
  value,
  max,
  label,
  tone = "accent",
}: {
  value: number;
  max: number;
  label?: string;
  tone?: "accent" | "positive" | "warning" | "negative";
}) {
  const t = useTranslations();
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={styles.progressWrap}>
      {label ? <div className={styles.progressLabel}><span>{label}</span><span>{Math.round(percent)}%</span></div> : null}
      <div
        className={styles.progressTrack}
        role="progressbar"
        aria-label={label ?? t("common.controls.progress")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <span className={styles[`progress_${tone}`]} style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

export function MonthStepper({ value, onChange }: { value: string; onChange: (month: string) => void }) {
  const t = useTranslations();
  const date = useMemo(() => new Date(`${value}-01T12:00:00`), [value]);
  const move = (amount: number) => {
    const next = new Date(date);
    next.setMonth(next.getMonth() + amount);
    onChange(`${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`);
  };
  return (
    <div className={styles.monthStepper}>
      <IconButton label={t("common.controls.month.previous")} onClick={() => move(-1)}><ChevronLeft size={18} /></IconButton>
      <strong>{new Intl.DateTimeFormat(workspaceLocale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(date)}</strong>
      <IconButton label={t("common.controls.month.next")} onClick={() => move(1)}><ChevronRight size={18} /></IconButton>
    </div>
  );
}

export function useSubmit(onSubmit: () => Promise<void>) {
  const t = useTranslations();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit();
    } catch (caught) {
      if (mountedRef.current) {
        setSubmitError(
          caught instanceof Error && caught.message
            ? caught.message
            : t("common.request.saveFailed"),
        );
      }
    } finally {
      submittingRef.current = false;
      if (mountedRef.current) setSubmitting(false);
    }
  };
  return { submit, submitting, submitError, setSubmitError };
}

export function Page({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx(styles.page, className)}>{children}</div>;
}

export { styles as featureStyles };
