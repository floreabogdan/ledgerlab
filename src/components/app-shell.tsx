"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  BarChart3,
  CalendarClock,
  CalendarRange,
  Check,
  ChevronDown,
  Command,
  DatabaseBackup,
  FileUp,
  FolderTree,
  LayoutDashboard,
  Landmark,
  LogOut,
  ReceiptText,
  Search,
  Settings2,
  Store,
  Tags,
  WalletCards,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Dialog } from "./ui/dialog";
import { IconButton } from "./ui/button";
import { Input } from "./ui/input";
import {
  DATE_RANGE_QUICK_PICKS,
  DateRangeProvider,
  useDateRange,
  type DateRangeQuickPickId,
} from "./date-range-context";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";

interface NavigationItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

const primaryNavigation: NavigationItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Transactions", href: "/transactions", icon: ReceiptText },
  { label: "Planned payments", href: "/planned", icon: CalendarClock },
  { label: "Monthly forecast", href: "/planning", icon: CalendarRange },
  { label: "Budgets", href: "/budgets", icon: WalletCards },
  { label: "Statistics", href: "/statistics", icon: BarChart3 },
];

const manageNavigation: NavigationItem[] = [
  { label: "Accounts", href: "/accounts", icon: Landmark },
  { label: "Categories", href: "/categories", icon: FolderTree },
  { label: "Tags", href: "/tags", icon: Tags },
  { label: "Merchants", href: "/merchants", icon: Store },
  { label: "Import transactions", href: "/import", icon: FileUp },
];

const utilityNavigation: NavigationItem[] = [
  { label: "Profile settings", href: "/settings", icon: Settings2 },
  { label: "Data & backups", href: "/import-export", icon: DatabaseBackup },
];

const mobileNavigation = [
  primaryNavigation[0],
  primaryNavigation[1],
  primaryNavigation[2],
  primaryNavigation[3],
  primaryNavigation[5],
];

const allNavigation = [...primaryNavigation, ...manageNavigation, ...utilityNavigation];
const authPaths = ["/login", "/register"];

interface ShellUser {
  displayName: string;
  email: string;
  defaultCurrency: string;
  locale: string;
  timeZone: string;
}

type OpenPopover = "desktop-range" | "desktop-account" | "mobile-range" | "mobile-account" | null;

const fallbackUser: ShellUser = {
  displayName: "Personal workspace",
  email: "Local account",
  defaultCurrency: DEFAULT_CURRENCY,
  locale: DEFAULT_LOCALE,
  timeZone: DEFAULT_TIME_ZONE,
};

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [commandOpen, setCommandOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [user, setUser] = useState<ShellUser>(fallbackUser);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const authPage = authPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  function openCommandPalette() {
    setOpenPopover(null);
    setCommandOpen(true);
  }

  useEffect(() => {
    if (authPage) return;
    function handleShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpenPopover(null);
        setQuery("");
        setCommandOpen((current) => !current);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [authPage]);

  useEffect(() => {
    queueMicrotask(() => setOpenPopover(null));
  }, [pathname]);

  useEffect(() => {
    if (authPage) return;
    let controller: AbortController | null = null;
    const loadAccountContext = () => {
      controller?.abort();
      controller = new AbortController();
      void fetch("/api/settings", { signal: controller.signal, headers: { Accept: "application/json" } })
        .then(async (response) => response.ok
          ? response.json() as Promise<{ user?: Partial<ShellUser>; preferences?: { compactTables?: boolean } }>
          : null)
        .then((payload) => {
          if (!payload?.user) return;
          setUser({
            displayName: payload.user.displayName || fallbackUser.displayName,
            email: payload.user.email || fallbackUser.email,
            defaultCurrency: payload.user.defaultCurrency || fallbackUser.defaultCurrency,
            locale: payload.user.locale || fallbackUser.locale,
            timeZone: payload.user.timeZone || fallbackUser.timeZone,
          });
          document.documentElement.dataset.currency = payload.user.defaultCurrency || fallbackUser.defaultCurrency;
          document.documentElement.dataset.locale = payload.user.locale || fallbackUser.locale;
          document.documentElement.dataset.timeZone = payload.user.timeZone || fallbackUser.timeZone;
          document.documentElement.dataset.tableDensity = payload.preferences?.compactTables === false
            ? "comfortable"
            : "compact";
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) console.error("Could not load account context", error);
        });
    };
    loadAccountContext();
    window.addEventListener("ledgerlab:settings-updated", loadAccountContext);
    return () => {
      window.removeEventListener("ledgerlab:settings-updated", loadAccountContext);
      controller?.abort();
    };
  }, [authPage]);

  const currentPage = allNavigation.find((item) => isActive(pathname, item.href));

  if (authPage) {
    return <>{children}</>;
  }

  return (
    <DateRangeProvider locale={user.locale} timeZone={user.timeZone}>
      <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside className="app-sidebar" aria-label="Primary navigation">
        <Link href="/" className="sidebar-brand" aria-label="LedgerLab dashboard">
          <span className="brand-mark" aria-hidden="true">L</span>
          <span className="brand-copy">
            <span className="brand-name">LedgerLab</span>
            <span className="brand-context">Personal finance</span>
          </span>
        </Link>

        <nav className="sidebar-nav">
          <NavigationSection label="Workspace" items={primaryNavigation} pathname={pathname} />
          <NavigationSection label="Manage" items={manageNavigation} pathname={pathname} />
        </nav>

      </aside>

      <header className="mobile-topbar">
        <div className="mobile-topbar-primary">
          <Link className="mobile-brand" href="/">
            <span className="brand-mark" aria-hidden="true">L</span>
            LedgerLab
          </Link>
          <div className="cluster">
            <IconButton label="Search and navigate" onClick={openCommandPalette}>
              <Search size={17} aria-hidden="true" />
            </IconButton>
            <AccountMenu
              compact
              user={user}
              open={openPopover === "mobile-account"}
              onOpenChange={(open) => setOpenPopover(open ? "mobile-account" : null)}
            />
          </div>
        </div>
        <div className="mobile-topbar-context">
          <strong>{currentPage?.label ?? "LedgerLab"}</strong>
          <span aria-hidden="true"> · </span>
          <DateRangePicker
            compact
            open={openPopover === "mobile-range"}
            onOpenChange={(open) => setOpenPopover(open ? "mobile-range" : null)}
          />
        </div>
      </header>

      <main className="app-main" id="main-content" tabIndex={-1}>
        <header className="app-topbar">
          <div className="topbar-context">
            <strong>{currentPage?.label ?? "LedgerLab"}</strong>
            <span aria-hidden="true"> · </span>
            <DateRangePicker
              open={openPopover === "desktop-range"}
              onOpenChange={(open) => setOpenPopover(open ? "desktop-range" : null)}
            />
          </div>
          <div className="topbar-actions">
            <button className="command-button" type="button" onClick={openCommandPalette}>
              <Search size={15} aria-hidden="true" />
              <span>Search or navigate</span>
              <kbd><Command size={9} aria-hidden="true" />K</kbd>
            </button>
            <AccountMenu
              user={user}
              open={openPopover === "desktop-account"}
              onOpenChange={(open) => setOpenPopover(open ? "desktop-account" : null)}
            />
          </div>
        </header>
        <div className="app-content">{children}</div>
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {mobileNavigation.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <Link key={item.href} className="mobile-nav-link" href={item.href} aria-current={active ? "page" : undefined}>
              <Icon size={18} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
              <span>{item.label === "Planned payments" ? "Planned" : item.label === "Monthly forecast" ? "Forecast" : item.label}</span>
            </Link>
          );
        })}
      </nav>

      <CommandPalette
        open={commandOpen}
        onOpenChange={(open) => {
          setCommandOpen(open);
          if (!open) setQuery("");
        }}
        query={query}
        onQueryChange={setQuery}
      />
      </div>
    </DateRangeProvider>
  );
}

function usePopoverDismiss(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLButtonElement | null>,
  onOpenChange: (open: boolean) => void,
) {
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) onOpenChange(false);
    }
    function handleFocusIn(event: FocusEvent) {
      if (!containerRef.current?.contains(event.target as Node)) onOpenChange(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onOpenChange(false);
      triggerRef.current?.focus();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [containerRef, onOpenChange, open, triggerRef]);
}

function focusByKey(
  event: ReactKeyboardEvent<HTMLElement>,
  selector: string,
) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (!items.length) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLElement);
  if (currentIndex === -1 && event.target !== event.currentTarget) return;
  event.preventDefault();
  const nextIndex = event.key === "Home" ? 0
    : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (currentIndex + 1 + items.length) % items.length
        : (currentIndex - 1 + items.length) % items.length;
  items[nextIndex]?.focus();
}

function DateRangePicker({
  open,
  onOpenChange,
  compact = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
}) {
  const pickerId = useId();
  const errorId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { range, label, activeRange, selectQuickPick, setCustomRange, timeZone } = useDateRange();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [error, setError] = useState<string | null>(null);

  usePopoverDismiss(open, containerRef, triggerRef, onOpenChange);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => {
      setFrom(range.from);
      setTo(range.to);
      setError(null);
    });
  }, [open, range.from, range.to]);

  function openAndFocusQuickPick() {
    onOpenChange(true);
    requestAnimationFrame(() => {
      const selected = containerRef.current?.querySelector<HTMLElement>("[data-range-option][aria-pressed='true']");
      (selected ?? containerRef.current?.querySelector<HTMLElement>("[data-range-option]"))?.focus();
    });
  }

  function chooseQuickPick(id: DateRangeQuickPickId) {
    selectQuickPick(id);
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  function applyCustomRange() {
    const result = setCustomRange(from, to);
    if (!result.success) {
      setError(result.error);
      return;
    }
    setError(null);
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  function cancelCustomRange() {
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  return (
    <div className={`date-range-control ${compact ? "date-range-control-compact" : ""}`} ref={containerRef}>
      <button
        ref={triggerRef}
        className="date-range-trigger"
        type="button"
        aria-label={`Date range: ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={pickerId}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openAndFocusQuickPick();
          }
        }}
      >
        <CalendarRange size={15} aria-hidden="true" />
        <span>{label}</span>
        <ChevronDown className="date-range-chevron" size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="date-range-popover"
          id={pickerId}
          role="dialog"
          aria-label="Choose date range"
          onKeyDown={(event) => focusByKey(event, "[data-range-option]")}
        >
          <div className="date-range-popover-header">
            <strong>Choose date range</strong>
            <span>Dates use {timeZone}.</span>
          </div>
          <div className="date-range-quick-picks" role="group" aria-label="Quick date ranges">
            {DATE_RANGE_QUICK_PICKS.map((quickPick) => {
              const selected = activeRange === quickPick.id;
              return (
                <button
                  key={quickPick.id}
                  data-range-option
                  type="button"
                  aria-pressed={selected}
                  onClick={() => chooseQuickPick(quickPick.id)}
                >
                  <span>{quickPick.label}</span>
                  {selected ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          <div className="date-range-custom">
            <strong>Custom range</strong>
            <div className="date-range-fields">
              <label>
                <span>Start date</span>
                <input
                  type="date"
                  value={from}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label>
                <span>End date</span>
                <input
                  type="date"
                  value={to}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
            </div>
            {error ? <p className="date-range-error" id={errorId} role="alert">{error}</p> : null}
            <div className="date-range-actions">
              <button className="button button-ghost" type="button" onClick={cancelCustomRange}>Cancel</button>
              <button className="button button-primary" type="button" onClick={applyCustomRange}>Apply range</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function userInitials(user: ShellUser) {
  const nameParts = user.displayName.trim().split(/\s+/).filter(Boolean);
  if (nameParts.length > 1) return `${nameParts[0]?.[0] ?? ""}${nameParts.at(-1)?.[0] ?? ""}`.toLocaleUpperCase(user.locale);
  return (nameParts[0]?.slice(0, 2) || user.email.slice(0, 2) || "U").toLocaleUpperCase(user.locale);
}

function AccountMenu({
  user,
  open,
  onOpenChange,
  compact = false,
}: {
  user: ShellUser;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
}) {
  const menuId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  usePopoverDismiss(open, containerRef, triggerRef, onOpenChange);

  function openAndFocus(position: "first" | "last") {
    onOpenChange(true);
    requestAnimationFrame(() => {
      const items = containerRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']");
      if (!items?.length) return;
      items[position === "first" ? 0 : items.length - 1]?.focus();
    });
  }

  return (
    <div className={`account-menu ${compact ? "account-menu-compact" : ""}`} ref={containerRef}>
      <button
        ref={triggerRef}
        className="account-menu-trigger"
        type="button"
        aria-label={`Open account menu for ${user.displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAndFocus(event.key === "ArrowDown" ? "first" : "last");
          }
        }}
      >
        <span className="account-menu-avatar" aria-hidden="true">{userInitials(user)}</span>
        {!compact ? (
          <span className="account-menu-trigger-copy">
            <strong>{user.displayName}</strong>
            <span>{user.defaultCurrency} reporting</span>
          </span>
        ) : null}
        {!compact ? <ChevronDown className="account-menu-chevron" size={14} aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div
          className="account-menu-popover"
          id={menuId}
          role="menu"
          aria-label="User account"
          onKeyDown={(event) => focusByKey(event, "[role='menuitem']")}
        >
          <div className="account-menu-identity">
            <span className="account-menu-avatar account-menu-avatar-large" aria-hidden="true">{userInitials(user)}</span>
            <span>
              <strong>{user.displayName}</strong>
              <small>{user.email}</small>
            </span>
          </div>
          <div className="account-menu-context">
            <span>Personal workspace</span>
            <strong>{user.defaultCurrency} · {user.timeZone}</strong>
          </div>
          <div className="account-menu-separator" role="separator" />
          <Link className="account-menu-item" href="/settings" role="menuitem" onClick={() => onOpenChange(false)}>
            <Settings2 size={16} aria-hidden="true" />
            Profile settings
          </Link>
          <Link className="account-menu-item" href="/import-export" role="menuitem" onClick={() => onOpenChange(false)}>
            <DatabaseBackup size={16} aria-hidden="true" />
            Data &amp; backups
          </Link>
          <div className="account-menu-separator" role="separator" />
          <button className="account-menu-item account-menu-signout" type="button" role="menuitem" onClick={() => void logout()}>
            <LogOut size={16} aria-hidden="true" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NavigationSection({ label, items, pathname }: { label: string; items: NavigationItem[]; pathname: string }) {
  return (
    <section className="nav-section" aria-labelledby={`nav-${label.toLowerCase()}`}>
      <span className="nav-label" id={`nav-${label.toLowerCase()}`}>{label}</span>
      <ul className="nav-list">
        {items.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link className="nav-link" href={item.href} aria-current={active ? "page" : undefined}>
                <Icon size={18} strokeWidth={active ? 2.15 : 1.8} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function CommandPalette({
  open,
  onOpenChange,
  query,
  onQueryChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const router = useRouter();
  const listboxId = useId();
  const listboxRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? allNavigation.filter((item) => item.label.toLowerCase().includes(normalized))
      : allNavigation;
  }, [query]);
  const safeActiveIndex = filtered.length ? Math.min(activeIndex, filtered.length - 1) : 0;
  const activeItem = filtered[safeActiveIndex];

  useEffect(() => {
    if (!open || !activeItem) return;
    const activeOption = listboxRef.current?.querySelector<HTMLElement>("[aria-selected='true']");
    activeOption?.scrollIntoView?.({ block: "nearest" });
  }, [activeItem, open]);

  function chooseItem(href: string) {
    onOpenChange(false);
    router.push(href);
  }

  function handleSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (!filtered.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (Math.min(index, filtered.length - 1) + 1) % filtered.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (Math.min(index, filtered.length - 1) - 1 + filtered.length) % filtered.length);
    } else if (event.key === "Home") {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveIndex(filtered.length - 1);
    } else if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      chooseItem(activeItem.href);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Go to"
      description="Search LedgerLab workspaces and actions."
      size="sm"
    >
      <div className="command-palette">
        <Input
          autoFocus
          leading={<Search size={15} />}
          aria-label="Search pages"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeItem ? `${listboxId}-option-${safeActiveIndex}` : undefined}
          placeholder="Transactions, forecast, accounts…"
          value={query}
          onChange={(event) => {
            setActiveIndex(0);
            onQueryChange(event.target.value);
          }}
          onKeyDown={handleSearchKeyDown}
        />
        <div ref={listboxRef} className="command-results" id={listboxId} role="listbox" aria-label="Pages">
          {filtered.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.href}
                id={`${listboxId}-option-${index}`}
                className="command-result"
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === safeActiveIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => chooseItem(item.href)}
              >
                <span className="command-result-icon"><Icon size={16} aria-hidden="true" /></span>
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
        {!filtered.length ? <p className="command-empty">No matching page.</p> : null}
      </div>
    </Dialog>
  );
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.assign("/login");
  }
}
