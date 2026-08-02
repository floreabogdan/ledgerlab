"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";
import { useTranslations } from "@/i18n/client";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leading?: ReactNode;
}

export function Input({ className, leading, ...props }: InputProps) {
  if (leading) {
    return (
      <span className="input-wrap">
        <span className="input-leading" aria-hidden="true">{leading}</span>
        <input className={clsx("input", className)} {...props} />
      </span>
    );
  }

  return <input className={clsx("input", className)} {...props} />;
}

export interface FieldProps {
  label: ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Field({ label, htmlFor, required, hint, error, action, className, children }: FieldProps) {
  const t = useTranslations();
  const hintId = htmlFor ? `${htmlFor}-hint` : undefined;
  const errorId = htmlFor ? `${htmlFor}-error` : undefined;
  return (
    <div className={clsx("field", className)}>
      <div className="field-label-row">
        <label className="field-label" htmlFor={htmlFor}>
          {label} {required && <><span className="field-required" aria-hidden="true">*</span><span className="sr-only"> ({t("common.controls.required")})</span></>}
        </label>
        {action}
      </div>
      {children}
      {error ? <FieldError id={errorId}>{error}</FieldError> : hint ? <FieldHint id={hintId}>{hint}</FieldHint> : null}
    </div>
  );
}

function FieldHint({ children, id }: { children: ReactNode; id?: string }) {
  return <p className="field-hint" id={id}>{children}</p>;
}

function FieldError({ children, id }: { children: ReactNode; id?: string }) {
  return <p className="field-error" id={id} role="alert">{children}</p>;
}
