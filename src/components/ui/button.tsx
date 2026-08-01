import type { ButtonHTMLAttributes, ReactNode } from "react";
import clsx from "clsx";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "soft";
type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  fullWidth = false,
  loading = false,
  leadingIcon,
  trailingIcon,
  className,
  disabled,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        "button",
        `button-${variant}`,
        size !== "md" && `button-${size}`,
        fullWidth && "button-full",
        className,
      )}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <span className="button-spinner" aria-hidden="true" /> : leadingIcon}
      {children}
      {!loading && trailingIcon}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonProps, "children" | "aria-label"> {
  label: string;
  children: ReactNode;
}

export function IconButton({ label, className, children, variant = "ghost", ...props }: IconButtonProps) {
  return (
    <Button
      variant={variant}
      className={clsx("icon-button", className)}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </Button>
  );
}
