"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./button";
import { useTranslations } from "@/i18n/client";

const focusableSelector = [
  "button:not([disabled]):not([hidden])",
  "input:not([disabled]):not([hidden])",
  "select:not([disabled]):not([hidden])",
  "textarea:not([disabled]):not([hidden])",
  "a[href]:not([hidden])",
  "[tabindex]:not([tabindex='-1']):not([hidden])",
].join(", ");

let bodyLockCount = 0;
let bodyOverflowBeforeLock = "";
const dialogStack: symbol[] = [];

function lockBodyScroll() {
  if (bodyLockCount === 0) bodyOverflowBeforeLock = document.body.style.overflow;
  bodyLockCount += 1;
  document.body.style.overflow = "hidden";
}

function unlockBodyScroll() {
  bodyLockCount = Math.max(0, bodyLockCount - 1);
  if (bodyLockCount === 0) document.body.style.overflow = bodyOverflowBeforeLock;
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) =>
      element.getClientRects().length > 0 &&
      !element.matches(":disabled") &&
      !element.closest("[inert], [aria-hidden='true']"),
    );
}

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  closeLabel?: string;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  closeLabel,
}: DialogProps) {
  const t = useTranslations();
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const dialogKeyRef = useRef(Symbol("dialog"));
  const onOpenChangeRef = useRef(onOpenChange);

  useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;

    const previousFocus = document.activeElement as HTMLElement | null;
    const dialogKey = dialogKeyRef.current;
    dialogStack.push(dialogKey);
    lockBodyScroll();

    const frame = window.requestAnimationFrame(() => {
      const focusable = panelRef.current ? focusableElements(panelRef.current) : [];
      const autoFocusTarget = focusable.find((element) => element.hasAttribute("autofocus"));
      const firstFocusable = autoFocusTarget ?? focusable[0];
      (firstFocusable ?? panelRef.current)?.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (dialogStack[dialogStack.length - 1] !== dialogKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChangeRef.current(false);
      }

      if (event.key === "Tab" && panelRef.current) {
        const focusable = focusableElements(panelRef.current);
        if (focusable.length === 0) {
          event.preventDefault();
          panelRef.current.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const activeElement = document.activeElement;
        if (!panelRef.current.contains(activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
      const stackIndex = dialogStack.lastIndexOf(dialogKey);
      if (stackIndex >= 0) dialogStack.splice(stackIndex, 1);
      unlockBodyScroll();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        ref={panelRef}
        className={`dialog-panel${size === "md" ? "" : ` dialog-${size}`}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
      >
        <header className="dialog-header">
          <div>
            <h2 className="dialog-title" id={titleId}>{title}</h2>
            {description && <p className="dialog-description" id={descriptionId}>{description}</p>}
          </div>
          <IconButton label={closeLabel ?? t("common.controls.dialogClose")} size="sm" onClick={() => onOpenChange(false)}>
            <X size={17} aria-hidden="true" />
          </IconButton>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
