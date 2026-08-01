"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Eye, EyeOff, LoaderCircle, LockKeyhole, Mail, UserRound } from "lucide-react";
import { Button } from "./ui/button";
import { CurrencyCombobox } from "./ui/currency-combobox";
import { Field, Input } from "./ui/input";
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
  const [registrationState, setRegistrationState] = useState<RegistrationState>(registering ? "checking" : "available");
  const formRef = useRef<HTMLFormElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    let active = true;
    if (registering) {
      queueMicrotask(() => {
        if (!active) return;
        try {
          const browserLocale = new Intl.Locale(navigator.language || DEFAULT_LOCALE).toString();
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
    void fetch("/api/auth/registration", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as { available?: boolean } | null;
        if (!response.ok || typeof payload?.available !== "boolean") throw new Error("Registration status is unavailable");
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

    const validation = validate({ name, email, password, confirmPassword, currency }, registering);
    setErrors(validation);
    if (Object.keys(validation).length > 0) {
      queueMicrotask(() => formRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(registering
          ? { name: name.trim(), email: email.trim(), password, currency, locale, timeZone }
          : { email: email.trim(), password }),
      });
      const payload = await response.json().catch(() => null) as { error?: string; message?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? payload?.message ?? "We could not complete that request. Please try again.");
      }
      window.location.assign("/");
    } catch (error) {
      if (controller.signal.aborted) return;
      setServerError(error instanceof Error ? error.message : "We could not complete that request. Please try again.");
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }

  return (
    <div className="auth-form-wrap">
      <h1 className="auth-title">{registering ? "Create your workspace" : "Welcome back"}</h1>
      <p className="auth-subtitle">
        {registering
          ? "Start with an empty, private ledger. You can add optional demo data later."
          : "Sign in to continue to your personal finance dashboard."}
      </p>

      {registering && registrationState === "checking" ? (
        <div className="notice" role="status">
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
          Checking whether this installation accepts new accounts…
        </div>
      ) : registering && registrationState === "closed" ? (
        <div className="notice" role="status">
          Registration is closed for this installation. Ask its administrator for access, or sign in with an existing account.
        </div>
      ) : registering && registrationState === "error" ? (
        <div className="notice notice-error" role="alert">
          Registration status could not be checked. Reload the page to try again.
        </div>
      ) : (
        <form ref={formRef} className="auth-form" onSubmit={handleSubmit} noValidate>
          {serverError && <div className="notice notice-error" role="alert">{serverError}</div>}

        {registering && (
          <Field label="Name" htmlFor="name" required error={errors.name}>
            <Input
              id="name"
              name="name"
              type="text"
              required
              minLength={2}
              autoComplete="name"
              leading={<UserRound size={15} />}
              value={name}
              onChange={(event) => { setName(event.target.value); clearFieldError("name"); }}
              aria-invalid={Boolean(errors.name)}
              aria-describedby={errors.name ? "name-error" : undefined}
              placeholder="Your name"
              disabled={submitting}
            />
          </Field>
        )}

        <Field label="Email address" htmlFor="email" required error={errors.email}>
          <Input
            id="email"
            name="email"
            type="email"
            required
            inputMode="email"
            autoComplete="email"
            leading={<Mail size={15} />}
            value={email}
            onChange={(event) => { setEmail(event.target.value); clearFieldError("email"); }}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "email-error" : undefined}
            placeholder="you@example.com"
            disabled={submitting}
          />
        </Field>

        {registering && (
          <Field
            label="Workspace currency"
            htmlFor="workspace-currency"
            required
            error={errors.currency}
            hint={`Used for balances, budgets, and reports. Dates will use ${timeZone}.`}
          >
            <CurrencyCombobox
              id="workspace-currency"
              value={currency}
              locale={locale}
              required
              invalid={Boolean(errors.currency)}
              describedBy={errors.currency ? "workspace-currency-error" : "workspace-currency-hint"}
              disabled={submitting}
              onChange={(value) => {
                setCurrency(value);
                clearFieldError("currency");
              }}
            />
          </Field>
        )}

        <Field
          label="Password"
          htmlFor="password"
          required
          error={errors.password}
          hint={registering ? "Use at least 10 characters." : undefined}
          action={
            <button className="auth-text-button" type="button" disabled={submitting} onClick={() => setShowPassword((shown) => !shown)}>
              {showPassword ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
              {showPassword ? "Hide" : "Show"}
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
            onChange={(event) => { setPassword(event.target.value); clearFieldError("password"); }}
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? "password-error" : registering ? "password-hint" : undefined}
            placeholder="Enter your password"
            disabled={submitting}
          />
        </Field>

        {registering && (
          <Field label="Confirm password" htmlFor="confirm-password" required error={errors.confirmPassword}>
            <Input
              id="confirm-password"
              name="confirmPassword"
              type={showPassword ? "text" : "password"}
              required
              minLength={10}
              autoComplete="new-password"
              leading={<LockKeyhole size={15} />}
              value={confirmPassword}
              onChange={(event) => { setConfirmPassword(event.target.value); clearFieldError("confirmPassword"); }}
              aria-invalid={Boolean(errors.confirmPassword)}
              aria-describedby={errors.confirmPassword ? "confirm-password-error" : undefined}
              placeholder="Repeat your password"
              disabled={submitting}
            />
          </Field>
        )}

          <Button type="submit" size="lg" fullWidth loading={submitting}>
            {registering ? "Create workspace" : "Sign in"}
          </Button>
        </form>
      )}

      <p className="auth-switch">
        {registering ? "Already have an account?" : "New to LedgerLab?"}{" "}
        <Link href={registering ? "/login" : "/register"}>{registering ? "Sign in" : "Create an account"}</Link>
      </p>
    </div>
  );
}

function validate(
  values: { name: string; email: string; password: string; confirmPassword: string; currency: string },
  registering: boolean,
) {
  const errors: FormErrors = {};
  if (registering && values.name.trim().length < 2) errors.name = "Enter at least 2 characters.";
  if (registering && !isSupportedCurrency(values.currency)) errors.currency = "Choose a supported currency.";
  if (!/^\S+@\S+\.\S+$/.test(values.email.trim())) errors.email = "Enter a valid email address.";
  if (values.password.length < 10) errors.password = "Password must contain at least 10 characters.";
  if (registering && values.password !== values.confirmPassword) errors.confirmPassword = "Passwords do not match.";
  return errors;
}
