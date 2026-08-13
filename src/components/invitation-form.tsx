"use client";

import { CheckCircle2, LoaderCircle, LockKeyhole, Mail, UserRound, UsersRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";

import { useTranslator } from "@/i18n/client";
import { parseApiError, translateApiError } from "@/lib/api-error";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";

import { Button } from "./ui/button";
import { CurrencyCombobox } from "./ui/currency-combobox";
import { Field, Input } from "./ui/input";

type InvitationDetails = {
  workspaceName: string;
  emailHint: string;
  expiresAt: string;
  role: "owner" | "member";
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function InvitationForm({ token }: { token: string }) {
  const translator = useTranslator();
  const t = translator.translate;
  const [details, setDetails] = useState<InvitationDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [locale, setLocale] = useState(DEFAULT_LOCALE);
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let detectedLocale = DEFAULT_LOCALE;
    try {
      detectedLocale = new Intl.Locale(navigator.language || DEFAULT_LOCALE).toString();
    } catch {
      detectedLocale = DEFAULT_LOCALE;
    }
    const detectedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLocale(detectedLocale);
      if (detectedTimeZone) setTimeZone(detectedTimeZone);
    });

    void Promise.all([
      fetch(`/api/invitations/${encodeURIComponent(token)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      }).then(async (response) => {
        const body = await response.json().catch(() => null) as unknown;
        if (!response.ok) throw new Error(translateApiError(translator, parseApiError(body)));
        const payload = record(body);
        const source = record(payload.invitation ?? record(payload.data).invitation ?? payload.data ?? payload);
        setDetails({
          workspaceName: typeof source.workspaceName === "string" ? source.workspaceName : "",
          emailHint: typeof source.emailHint === "string" ? source.emailHint : "",
          expiresAt: typeof source.expiresAt === "string" ? source.expiresAt : "",
          role: source.role === "owner" ? "owner" : "member",
        });
      }),
      fetch("/api/auth/session", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal,
      }).then((response) => setSignedIn(response.ok)),
    ]).catch((caught: unknown) => {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(caught instanceof Error ? caught.message : t("auth.invitation.errors.loadFailed"));
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [t, token, translator]);

  async function request(url: string, init: RequestInit) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw new Error(translateApiError(translator, parseApiError(body)));
    return record(body);
  }

  async function finishAcceptance(body: Record<string, unknown>) {
    const data = record(body.data);
    const workspace = record(body.workspace ?? data.workspace);
    const workspaceId = typeof workspace.id === "string" ? workspace.id : null;
    if (workspaceId) {
      await request(`/api/workspaces/${encodeURIComponent(workspaceId)}/activate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    }
    setJoined(true);
    window.setTimeout(() => window.location.assign("/"), 350);
  }

  async function acceptSignedIn() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const body = await request(`/api/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await finishAcceptance(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.invitation.errors.acceptFailed"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    setError(null);
    if (mode === "register") {
      if (name.trim().length < 2) {
        setError(t("auth.validation.nameMinimum", { count: 2 }));
        return;
      }
      if (password.length < 10) {
        setError(t("auth.validation.passwordMinimum", { count: 10 }));
        return;
      }
      if (password !== confirmPassword) {
        setError(t("auth.validation.passwordsMismatch"));
        return;
      }
    }
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError(t("auth.validation.emailInvalid"));
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (mode === "login") {
        await request("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ email: email.trim(), password }),
        });
        const accepted = await request(`/api/invitations/${encodeURIComponent(token)}/accept`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        await finishAcceptance(accepted);
      } else {
        const registered = await request("/api/auth/invitation-register", {
          method: "POST",
          body: JSON.stringify({
            invitationToken: token,
            name: name.trim(),
            email: email.trim(),
            password,
            currency,
            locale,
            timeZone,
            uiLanguage: translator.language,
          }),
        });
        await finishAcceptance(registered);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.invitation.errors.acceptFailed"));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="auth-form-wrap">
        <div className="notice" role="status">
          <LoaderCircle className="spin" size={16} aria-hidden="true" />
          {t("auth.invitation.loading")}
        </div>
      </div>
    );
  }

  if (!details) {
    return (
      <div className="auth-form-wrap">
        <h1 className="auth-title">{t("auth.invitation.unavailableTitle")}</h1>
        <div className="notice notice-error" role="alert">
          {error ?? t("auth.invitation.errors.loadFailed")}
        </div>
      </div>
    );
  }

  if (joined) {
    return (
      <div className="auth-form-wrap">
        <CheckCircle2 size={34} aria-hidden="true" />
        <h1 className="auth-title">{t("auth.invitation.joinedTitle")}</h1>
        <p className="auth-subtitle">{t("auth.invitation.joinedDescription", { name: details.workspaceName })}</p>
      </div>
    );
  }

  return (
    <div className="auth-form-wrap">
      <UsersRound size={34} aria-hidden="true" />
      <h1 className="auth-title">{t("auth.invitation.title", { name: details.workspaceName })}</h1>
      <p className="auth-subtitle">
        {t("auth.invitation.description", { email: details.emailHint })}
      </p>
      {error ? <div className="notice notice-error" role="alert">{error}</div> : null}

      {signedIn ? (
        <Button size="lg" fullWidth loading={submitting} onClick={() => void acceptSignedIn()}>
          {t("auth.invitation.acceptSignedIn")}
        </Button>
      ) : (
        <>
          <div className="auth-switch" role="group" aria-label={t("auth.invitation.accountChoice") }>
            <button className="auth-text-button" type="button" aria-pressed={mode === "login"} onClick={() => setMode("login")}>
              {t("auth.invitation.existingAccount")}
            </button>
            {" · "}
            <button className="auth-text-button" type="button" aria-pressed={mode === "register"} onClick={() => setMode("register")}>
              {t("auth.invitation.newAccount")}
            </button>
          </div>
          <form className="auth-form" onSubmit={submit} noValidate>
            {mode === "register" ? (
              <Field label={t("auth.fields.displayName")} htmlFor="invite-name" required>
                <Input id="invite-name" autoComplete="name" minLength={2} maxLength={80} required leading={<UserRound size={15} />} value={name} onChange={(event) => setName(event.target.value)} />
              </Field>
            ) : null}
            <Field label={t("auth.fields.email")} htmlFor="invite-email" required hint={t("auth.invitation.emailHelp") }>
              <Input id="invite-email" type="email" autoComplete="email" maxLength={254} required leading={<Mail size={15} />} value={email} onChange={(event) => setEmail(event.target.value)} />
            </Field>
            {mode === "register" ? (
              <Field label={t("auth.fields.workspaceCurrency")} htmlFor="invite-currency" required hint={t("auth.workspaceCurrencyHelp", { timeZone })}>
                <CurrencyCombobox id="invite-currency" value={currency} locale={locale} required disabled={submitting} onChange={setCurrency} />
              </Field>
            ) : null}
            <Field label={t("auth.fields.password")} htmlFor="invite-password" required hint={mode === "register" ? t("auth.passwordHelp") : undefined}>
              <Input id="invite-password" type="password" autoComplete={mode === "register" ? "new-password" : "current-password"} minLength={mode === "register" ? 10 : 1} required leading={<LockKeyhole size={15} />} value={password} onChange={(event) => setPassword(event.target.value)} />
            </Field>
            {mode === "register" ? (
              <Field label={t("auth.fields.confirmPassword")} htmlFor="invite-confirm-password" required>
                <Input id="invite-confirm-password" type="password" autoComplete="new-password" minLength={10} required leading={<LockKeyhole size={15} />} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
              </Field>
            ) : null}
            <Button type="submit" size="lg" fullWidth loading={submitting}>
              {mode === "login" ? t("auth.invitation.signInAndAccept") : t("auth.invitation.registerAndAccept")}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
