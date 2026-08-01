"use client";

import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";

function Tooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; placement: "top" | "bottom" } | null>(null);

  const cancelScheduledHide = useCallback(() => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const hide = useCallback(() => {
    cancelScheduledHide();
    setPosition(null);
  }, [cancelScheduledHide]);

  const scheduleHide = useCallback(() => {
    cancelScheduledHide();
    closeTimerRef.current = window.setTimeout(() => setPosition(null), 100);
  }, [cancelScheduledHide]);

  const show = useCallback(() => {
    cancelScheduledHide();
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) {
      setPosition(null);
      return;
    }
    const placement = rect.top < 84 ? "bottom" : "top";
    const bubbleHalfWidth = Math.min(135, Math.max(0, window.innerWidth / 2 - 12));
    const minimumLeft = bubbleHalfWidth + 12;
    const maximumLeft = Math.max(minimumLeft, window.innerWidth - bubbleHalfWidth - 12);
    setPosition({
      left: Math.min(maximumLeft, Math.max(minimumLeft, rect.left + rect.width / 2)),
      top: placement === "bottom" ? rect.bottom + 8 : rect.top - 8,
      placement,
    });
  }, [cancelScheduledHide]);

  const visible = position !== null;

  useEffect(() => {
    if (!visible) return;
    const reposition = () => show();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [show, visible]);

  useEffect(() => {
    if (!visible) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [hide, visible]);

  useEffect(() => () => cancelScheduledHide(), [cancelScheduledHide]);

  const describedChild = isValidElement<{ "aria-describedby"?: string }>(children)
    ? cloneElement(children, {
        "aria-describedby": visible
          ? [children.props["aria-describedby"], id].filter(Boolean).join(" ")
          : children.props["aria-describedby"],
      })
    : children;

  return (
    <span
      ref={anchorRef}
      className="tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      onFocus={show}
      onBlur={scheduleHide}
    >
      {describedChild}
      {position && typeof document !== "undefined" && createPortal(
        <span
          className="tooltip-bubble"
          id={id}
          role="tooltip"
          onMouseEnter={cancelScheduledHide}
          onMouseLeave={scheduleHide}
          style={{
            left: position.left,
            top: position.top,
            transform: position.placement === "bottom" ? "translate(-50%, 0)" : "translate(-50%, -100%)",
          }}
        >
          {content}
        </span>,
        document.body,
      )}
    </span>
  );
}

export function InfoTooltip({ content, label = "How this is calculated" }: { content: ReactNode; label?: string }) {
  return (
    <Tooltip content={content}>
      <button type="button" className="info-button" aria-label={label}>
        <Info size={13} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}
