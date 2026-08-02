"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  Eye,
  EyeOff,
  LoaderCircle,
  LockKeyhole,
  Mail,
  UserRound,
} from "lucide-react";
import { Button } from "./ui/button";
import { CurrencyCombobox } from "./ui/currency-combobox";
import { Field, Input } from "./ui/input";
import { useTranslator } from "@/i18n/client";
import type { Translator } from "@/i18n/runtime";
import { parseApiError, translateApiError } from "@/lib/api-error";
import type { ApiErrorDescriptor } from "@/lib/api-response";
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
  isSupportedCurrency,
} from "@/lib/currencies";

type AuthMode = "login" | "register";
type RegistrationState = "checking" | "available" | "closed" | "error";

interface FormErrors {
  name?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  currency?: string;
}

export function AuthForm({ mode }: { mode: AuthMode }) {
  const translator = useTranslator();
  const { language: uiLanguage, translate: t } = translator;
  const registering = mode === "register";
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [locale, setLocale] = useState(DEFAULT_LOCALE);
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registrationState, setRegistrationState] = useState<RegistrationState>(
    registering ? "checking" : "available",
  );
  const formRef = useRef<HTMLFormElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    let active = true;
    if (registering) {
      queueMicrotask(() => {
        if (!active) return;
        try {
          const browserLocale = new Intl.Locale(
            navigator.language || DEFAULT_LOCALE,
          ).toString();
          setLocale(browserLocale);
        } catch {
          setLocale(DEFAULT_LOCALE);
        }
        const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (browserTimeZone) setTimeZone(browserTimeZone);
      });
    }
    return () => {
      active = false;
      requestRef.current?.abort();
    };
  }, [registering]);

  useEffect(() => {
    if (!registering) return;
    const controller = new AbortController();
    void fetch("/api/auth/registration", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as {
          available?: boolean;
        } | null;
        if (!response.ok || typeof payload?.available !== "boolean") {
          setRegistrationState("error");
          return;
        }
        setRegistrationState(payload.available ? "available" : "closed");
      })
      .catch(() => {
        if (!controller.signal.aborted) setRegistrationState("error");
      });
    return () => controller.abort();
  }, [registering]);

  function clearFieldError(field: keyof FormErrors) {
    setServerError(null);
    setErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    setServerError(null);

    const validation = validate(
      { name, email, password, confirmPassword, currency },
      registering,
      t,
    );
    setErrors(validation);
    if (Object.keys(validation).length > 0) {
      queueMicrotask(() =>
        formRef.current
          ?.querySelector<HTMLElement>("[aria-invalid='true']")
          ?.focus(),
      );
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    let requestError = t("auth.errors.requestFailed");
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(
          registering
            ? {
                name: name.trim(),
                email: email.trim(),
                password,
                currency,
                locale,
                timeZone,
                uiLanguage,
              }
            : { email: email.trim(), password },
        ),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const apiError = parseApiError(payload);
        requestError = translateApiError(translator, apiError);
        const issueErrors = fieldErrorsFromApi(apiError, translator);
        if (Object.keys(issueErrors).length > 0) setErrors(issueErrors);
        throw new Error("auth_request_rejected");
      }
      window.location.assign("/");
    } catch {
      if (controller.signal.aborted) return;
      setServerError(requestError);
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return (
    <div className="auth-form-wrap">
      <h1 className="auth-title">
        {registering ? t("auth.register.title") : t("auth.login.title")}
      </h1>
      <p className="auth-subtitle">
        {registering
          ? t("auth.register.subtitle")
          : t("auth.login.subtitle")}
      </p>

      {registering && registrationState === "checking" ? (
        <div className="notice" role="status">
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
          {t("auth.registration.checking")}
        </div>
      ) : registering && registrationState === "closed" ? (
        <div className="notice" role="status">
          {t("auth.registration.closed")}
        </div>
      ) : registering && registrationState === "error" ? (
        <div className="notice notice-error" role="alert">
          {t("auth.registration.unavailable")}
        </div>
      ) : (
        <form
          ref={formRef}
          className="auth-form"
          onSubmit={handleSubmit}
          noValidate
        >
          {serverError && (
            <div className="notice notice-error" role="alert">
              {serverError}
            </div>
          )}

          {registering && (
            <Field
              label={t("auth.fields.displayName")}
              htmlFor="name"
              required
              error={errors.name}
            >
              <Input
                id="name"
                name="name"
                type="text"
                required
                minLength={2}
                autoComplete="name"
                leading={<UserRound size={15} />}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  clearFieldError("name");
                }}
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? "name-error" : undefined}
                placeholder={t("auth.placeholders.displayName")}
                disabled={submitting}
              />
            </Field>
          )}

          <Field
            label={t("auth.fields.email")}
            htmlFor="email"
            required
            error={errors.email}
          >
            <Input
              id="email"
              name="email"
              type="email"
              required
              inputMode="email"
              autoComplete="email"
              leading={<Mail size={15} />}
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
                clearFieldError("email");
              }}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "email-error" : undefined}
              placeholder={t("auth.placeholders.email")}
              disabled={submitting}
            />
          </Field>

          {registering && (
            <Field
              label={t("auth.fields.workspaceCurrency")}
              htmlFor="workspace-currency"
              required
              error={errors.currency}
              hint={t("auth.workspaceCurrencyHelp", { timeZone })}
            >
              <CurrencyCombobox
                id="workspace-currency"
                value={currency}
                locale={locale}
                required
                invalid={Boolean(errors.currency)}
                describedBy={
                  errors.currency
                    ? "workspace-currency-error"
                    : "workspace-currency-hint"
                }
                disabled={submitting}
                onChange={(value) => {
                  setCurrency(value);
                  clearFieldError("currency");
                }}
              />
            </Field>
          )}

          <Field
            label={t("auth.fields.password")}
            htmlFor="password"
            required
            error={errors.password}
            hint={registering ? t("auth.passwordHelp") : undefined}
            action={
              <button
                className="auth-text-button"
                type="button"
                disabled={submitting}
                onClick={() => setShowPassword((shown) => !shown)}
              >
                {showPassword ? (
                  <EyeOff size={13} aria-hidden="true" />
                ) : (
                  <Eye size={13} aria-hidden="true" />
                )}
                {showPassword
                  ? t("auth.password.hide")
                  : t("auth.password.show")}
              </button>
            }
          >
            <Input
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              required
              minLength={10}
              autoComplete={registering ? "new-password" : "current-password"}
              leading={<LockKeyhole size={15} />}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                clearFieldError("password");
              }}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={
                errors.password
                  ? "password-error"
                  : registering
                    ? "password-hint"
                    : undefined
              }
              placeholder={t("auth.placeholders.password")}
              disabled={submitting}
            />
          </Field>

          {registering && (
            <Field
              label={t("auth.fields.confirmPassword")}
              htmlFor="confirm-password"
              required
              error={errors.confirmPassword}
            >
              <Input
                id="confirm-password"
                name="confirmPassword"
                type={showPassword ? "text" : "password"}
                required
                minLength={10}
                autoComplete="new-password"
                leading={<LockKeyhole size={15} />}
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value);
                  clearFieldError("confirmPassword");
                }}
                aria-invalid={Boolean(errors.confirmPassword)}
                aria-describedby={
                  errors.confirmPassword
                    ? "confirm-password-error"
                    : undefined
                }
                placeholder={t("auth.placeholders.confirmPassword")}
                disabled={submitting}
              />
            </Field>
          )}

          <Button type="submit" size="lg" fullWidth loading={submitting}>
            {registering ? t("auth.register.submit") : t("auth.login.submit")}
          </Button>
        </form>
      )}

      <p className="auth-switch">
        {registering
          ? t("auth.register.switchPrompt")
          : t("auth.login.switchPrompt")}{" "}
        <Link href={registering ? "/login" : "/register"}>
          {registering
            ? t("auth.register.switchAction")
            : t("auth.login.switchAction")}
        </Link>
      </p>
    </div>
  );
}

function validate(
  values: {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
    currency: string;
  },
  registering: boolean,
  t: Translator["translate"],
) {
  const errors: FormErrors = {};
  if (registering && values.name.trim().length < 2) {
    errors.name = t("auth.validation.nameMinimum", { count: 2 });
  }
  if (registering && !isSupportedCurrency(values.currency)) {
    errors.currency = t("auth.validation.currencyUnsupported");
  }
  if (!/^\S+@\S+\.\S+$/.test(values.email.trim())) {
    errors.email = t("auth.validation.emailInvalid");
  }
  if (values.password.length < 10) {
    errors.password = t("auth.validation.passwordMinimum", { count: 10 });
  }
  if (registering && values.password !== values.confirmPassword) {
    errors.confirmPassword = t("auth.validation.passwordsMismatch");
  }
  return errors;
}

function fieldErrorsFromApi(
  error: ApiErrorDescriptor | null,
  translator: Translator,
) {
  const result: FormErrors = {};
  const fieldNames = new Set<keyof FormErrors>([
    "name",
    "email",
    "password",
    "confirmPassword",
    "currency",
  ]);

  for (const issue of error?.issues ?? []) {
    const field = issue.path.at(-1);
    if (typeof field !== "string" || !fieldNames.has(field as keyof FormErrors)) {
      continue;
    }
    result[field as keyof FormErrors] = translateApiError(translator, {
      code: issue.code,
      params: issue.params,
    });
  }
  return result;
}
