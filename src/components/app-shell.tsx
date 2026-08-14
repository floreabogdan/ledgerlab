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
  House,
  LayoutDashboard,
  Landmark,
  LogOut,
  ReceiptText,
  Search,
  Settings2,
  Store,
  Tags,
  UserRound,
  UsersRound,
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
import { useTranslations } from "@/i18n/client";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";

type NavigationId =
  | "dashboard"
  | "transactions"
  | "plannedPayments"
  | "monthlyForecast"
  | "budgets"
  | "statistics"
  | "accounts"
  | "categories"
  | "tags"
  | "merchants"
  | "importTransactions"
  | "workspaces"
  | "profileSettings"
  | "dataBackups";

interface NavigationDefinition {
  id: NavigationId;
  href: string;
  icon: LucideIcon;
}

interface NavigationItem extends NavigationDefinition {
  label: string;
  shortLabel: string;
}

const PRIMARY_NAVIGATION: NavigationDefinition[] = [
  { id: "dashboard", href: "/", icon: LayoutDashboard },
  { id: "transactions", href: "/transactions", icon: ReceiptText },
  { id: "plannedPayments", href: "/planned", icon: CalendarClock },
  { id: "monthlyForecast", href: "/planning", icon: CalendarRange },
  { id: "budgets", href: "/budgets", icon: WalletCards },
  { id: "statistics", href: "/statistics", icon: BarChart3 },
];

const MANAGE_NAVIGATION: NavigationDefinition[] = [
  { id: "accounts", href: "/accounts", icon: Landmark },
  { id: "categories", href: "/categories", icon: FolderTree },
  { id: "tags", href: "/tags", icon: Tags },
  { id: "merchants", href: "/merchants", icon: Store },
  { id: "importTransactions", href: "/import", icon: FileUp },
];

const UTILITY_NAVIGATION: NavigationDefinition[] = [
  { id: "workspaces", href: "/workspaces", icon: UsersRound },
  { id: "profileSettings", href: "/settings", icon: Settings2 },
  { id: "dataBackups", href: "/import-export", icon: DatabaseBackup },
];

const NAVIGATION_MESSAGE_KEYS = {
  dashboard: ["common.navigation.pages.dashboard.label", "common.navigation.pages.dashboard.shortLabel"],
  transactions: ["common.navigation.pages.transactions.label", "common.navigation.pages.transactions.shortLabel"],
  plannedPayments: ["common.navigation.pages.plannedPayments.label", "common.navigation.pages.plannedPayments.shortLabel"],
  monthlyForecast: ["common.navigation.pages.monthlyForecast.label", "common.navigation.pages.monthlyForecast.shortLabel"],
  budgets: ["common.navigation.pages.budgets.label", "common.navigation.pages.budgets.shortLabel"],
  statistics: ["common.navigation.pages.statistics.label", "common.navigation.pages.statistics.shortLabel"],
  accounts: ["common.navigation.pages.accounts.label", "common.navigation.pages.accounts.shortLabel"],
  categories: ["common.navigation.pages.categories.label", "common.navigation.pages.categories.shortLabel"],
  tags: ["common.navigation.pages.tags.label", "common.navigation.pages.tags.shortLabel"],
  merchants: ["common.navigation.pages.merchants.label", "common.navigation.pages.merchants.shortLabel"],
  importTransactions: ["common.navigation.pages.importTransactions.label", "common.navigation.pages.importTransactions.shortLabel"],
  workspaces: ["common.navigation.pages.workspaces.label", "common.navigation.pages.workspaces.shortLabel"],
  profileSettings: ["common.navigation.pages.profileSettings.label", "common.navigation.pages.profileSettings.shortLabel"],
  dataBackups: ["common.navigation.pages.dataBackups.label", "common.navigation.pages.dataBackups.shortLabel"],
} as const;

const MOBILE_NAVIGATION_IDS = new Set<NavigationId>([
  "dashboard",
  "transactions",
  "plannedPayments",
  "monthlyForecast",
  "statistics",
]);

function localizeNavigation(
  definitions: NavigationDefinition[],
  t: ReturnType<typeof useTranslations>,
): NavigationItem[] {
  return definitions.map((definition) => {
    const [labelKey, shortLabelKey] = NAVIGATION_MESSAGE_KEYS[definition.id];
    return {
      ...definition,
      label: t(labelKey),
      shortLabel: t(shortLabelKey),
    };
  });
}

const authPaths = ["/login", "/register", "/invite"];

interface ShellUser {
  displayName: string;
  email: string;
  defaultCurrency: string;
  locale: string;
  timeZone: string;
}

interface ShellWorkspace {
  id: string;
  type: "personal" | "household";
  name: string;
  role: "owner" | "member";
  defaultCurrency: string;
  timeZone: string;
}

type OpenPopover =
  | "desktop-range"
  | "desktop-account"
  | "desktop-workspace"
  | "mobile-range"
  | "mobile-account"
  | "mobile-workspace"
  | null;

const fallbackUser: ShellUser = {
  displayName: "",
  email: "",
  defaultCurrency: DEFAULT_CURRENCY,
  locale: DEFAULT_LOCALE,
  timeZone: DEFAULT_TIME_ZONE,
};

const fallbackWorkspace: ShellWorkspace = {
  id: "",
  type: "personal",
  name: "",
  role: "owner",
  defaultCurrency: DEFAULT_CURRENCY,
  timeZone: DEFAULT_TIME_ZONE,
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function shellWorkspace(value: unknown): ShellWorkspace | null {
  const item = objectValue(value);
  if (typeof item.id !== "string" || typeof item.name !== "string") return null;
  return {
    id: item.id,
    name: item.name,
    type: item.type === "household" ? "household" : "personal",
    role: item.role === "member" ? "member" : "owner",
    defaultCurrency: typeof item.defaultCurrency === "string" ? item.defaultCurrency : DEFAULT_CURRENCY,
    timeZone: typeof item.timeZone === "string" ? item.timeZone : DEFAULT_TIME_ZONE,
  };
}

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const t = useTranslations();
  const pathname = usePathname();
  const [commandOpen, setCommandOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [user, setUser] = useState<ShellUser>(fallbackUser);
  const [workspaces, setWorkspaces] = useState<ShellWorkspace[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<ShellWorkspace>(fallbackWorkspace);
  const [openPopover, setOpenPopover] = useState<OpenPopover>(null);
  const authPage = authPaths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const { primaryNavigation, manageNavigation, utilityNavigation } = useMemo(
    () => ({
      primaryNavigation: localizeNavigation(PRIMARY_NAVIGATION, t),
      manageNavigation: localizeNavigation(MANAGE_NAVIGATION, t),
      utilityNavigation: localizeNavigation(UTILITY_NAVIGATION, t),
    }),
    [t],
  );
  const allNavigation = useMemo(
    () => [...primaryNavigation, ...manageNavigation, ...utilityNavigation],
    [manageNavigation, primaryNavigation, utilityNavigation],
  );
  const mobileNavigation = useMemo(
    () => primaryNavigation.filter((item) => MOBILE_NAVIGATION_IDS.has(item.id)),
    [primaryNavigation],
  );
  const displayUser = {
    ...user,
    displayName: user.displayName || t("common.app.personalWorkspace"),
    email: user.email || t("common.app.localAccount"),
    defaultCurrency: activeWorkspace.defaultCurrency || user.defaultCurrency,
    timeZone: activeWorkspace.timeZone || user.timeZone,
  };
  const displayWorkspace = {
    ...activeWorkspace,
    name: activeWorkspace.name || t("common.app.personalWorkspace"),
    defaultCurrency: activeWorkspace.defaultCurrency || user.defaultCurrency,
    timeZone: activeWorkspace.timeZone || user.timeZone,
  };

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
      void Promise.all([
        fetch("/api/settings", { signal: controller.signal, headers: { Accept: "application/json" } })
          .then(async (response) => response.ok
            ? response.json() as Promise<{ user?: Partial<ShellUser>; preferences?: { compactTables?: boolean } }>
            : null),
        fetch("/api/workspaces", { signal: controller.signal, headers: { Accept: "application/json" }, cache: "no-store" })
          .then(async (response) => response.ok ? response.json() as Promise<unknown> : null),
      ])
        .then(([payload, workspacePayload]) => {
          if (payload?.user) {
          setUser({
            displayName: payload.user.displayName || fallbackUser.displayName,
            email: payload.user.email || fallbackUser.email,
            defaultCurrency: payload.user.defaultCurrency || fallbackUser.defaultCurrency,
            locale: payload.user.locale || fallbackUser.locale,
            timeZone: payload.user.timeZone || fallbackUser.timeZone,
          });
          document.documentElement.dataset.locale = payload.user.locale || fallbackUser.locale;
          document.documentElement.dataset.tableDensity = payload.preferences?.compactTables === false
            ? "comfortable"
            : "compact";
          }
          const workspaceEnvelope = objectValue(workspacePayload);
          const workspaceData = objectValue(workspaceEnvelope.data);
          const rawWorkspaces = Array.isArray(workspaceEnvelope.workspaces)
            ? workspaceEnvelope.workspaces
            : Array.isArray(workspaceData.workspaces)
              ? workspaceData.workspaces
              : [];
          const available = rawWorkspaces.flatMap((item) => {
            const parsed = shellWorkspace(item);
            return parsed ? [parsed] : [];
          });
          const explicitActive = shellWorkspace(
            workspaceEnvelope.activeWorkspace ?? workspaceData.activeWorkspace,
          );
          const selected = explicitActive
            ?? available.find((item) => objectValue(rawWorkspaces.find((raw) => objectValue(raw).id === item.id)).active === true)
            ?? null;
          if (available.length) setWorkspaces(available);
          if (selected) {
            setActiveWorkspace(selected);
            document.documentElement.dataset.currency = selected.defaultCurrency;
            document.documentElement.dataset.timeZone = selected.timeZone;
          } else if (payload?.user) {
            document.documentElement.dataset.currency = payload.user.defaultCurrency || fallbackUser.defaultCurrency;
            document.documentElement.dataset.timeZone = payload.user.timeZone || fallbackUser.timeZone;
          }
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) console.error("account_context_load_failed", error);
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
    <DateRangeProvider locale={user.locale} timeZone={displayWorkspace.timeZone}>
      <div className="app-shell">
      <a className="skip-link" href="#main-content">{t("common.shell.skipToContent")}</a>
      <aside className="app-sidebar" aria-label={t("common.navigation.primaryAria")}>
        <Link href="/" className="sidebar-brand" aria-label={t("common.navigation.dashboardAria")}>
          <span className="brand-mark" aria-hidden="true">L</span>
          <span className="brand-copy">
            <span className="brand-name">{t("common.app.name")}</span>
            <span className="brand-context">{t("common.app.brandContext")}</span>
          </span>
        </Link>

        <WorkspaceSwitcher
          activeWorkspace={displayWorkspace}
          workspaces={workspaces.length ? workspaces : [displayWorkspace]}
          open={openPopover === "desktop-workspace"}
          onOpenChange={(open) => setOpenPopover(open ? "desktop-workspace" : null)}
        />

        <nav className="sidebar-nav">
          <NavigationSection id="workspace" label={t("common.navigation.sections.workspace")} items={primaryNavigation} pathname={pathname} />
          <NavigationSection id="manage" label={t("common.navigation.sections.manage")} items={manageNavigation} pathname={pathname} />
        </nav>

      </aside>

      <header className="mobile-topbar">
        <div className="mobile-topbar-primary">
          <Link className="mobile-brand" href="/">
            <span className="brand-mark" aria-hidden="true">L</span>
            {t("common.app.name")}
          </Link>
          <WorkspaceSwitcher
            compact
            activeWorkspace={displayWorkspace}
            workspaces={workspaces.length ? workspaces : [displayWorkspace]}
            open={openPopover === "mobile-workspace"}
            onOpenChange={(open) => setOpenPopover(open ? "mobile-workspace" : null)}
          />
          <div className="cluster">
            <IconButton label={t("common.shell.searchAndNavigate")} onClick={openCommandPalette}>
              <Search size={17} aria-hidden="true" />
            </IconButton>
            <AccountMenu
              compact
              user={displayUser}
              workspace={displayWorkspace}
              open={openPopover === "mobile-account"}
              onOpenChange={(open) => setOpenPopover(open ? "mobile-account" : null)}
            />
          </div>
        </div>
        <div className="mobile-topbar-context">
          <strong>{currentPage?.label ?? t("common.app.name")}</strong>
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
            <strong>{currentPage?.label ?? t("common.app.name")}</strong>
            <span aria-hidden="true"> · </span>
            <DateRangePicker
              open={openPopover === "desktop-range"}
              onOpenChange={(open) => setOpenPopover(open ? "desktop-range" : null)}
            />
          </div>
          <div className="topbar-actions">
            <button className="command-button" type="button" onClick={openCommandPalette}>
              <Search size={15} aria-hidden="true" />
              <span>{t("common.shell.searchOrNavigate")}</span>
              <kbd><Command size={9} aria-hidden="true" />K</kbd>
            </button>
            <AccountMenu
              user={displayUser}
              workspace={displayWorkspace}
              open={openPopover === "desktop-account"}
              onOpenChange={(open) => setOpenPopover(open ? "desktop-account" : null)}
            />
          </div>
        </header>
        <div className="app-content">{children}</div>
      </main>

      <nav className="mobile-nav" aria-label={t("common.navigation.mobileAria")}>
        {mobileNavigation.map((item) => {
          const Icon = item.icon;
          const active = isActive(pathname, item.href);
          return (
            <Link key={item.href} className="mobile-nav-link" href={item.href} aria-current={active ? "page" : undefined}>
              <Icon size={18} strokeWidth={active ? 2.2 : 1.8} aria-hidden="true" />
              <span>{item.shortLabel}</span>
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
        items={allNavigation}
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

function WorkspaceSwitcher({
  activeWorkspace,
  workspaces,
  open,
  onOpenChange,
  compact = false,
}: {
  activeWorkspace: ShellWorkspace;
  workspaces: ShellWorkspace[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
}) {
  const t = useTranslations();
  const menuId = useId();
  const errorId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ActiveIcon = activeWorkspace.type === "household" ? House : UserRound;

  usePopoverDismiss(open, containerRef, triggerRef, onOpenChange);

  function openAndFocus(position: "first" | "last") {
    setError(null);
    onOpenChange(true);
    requestAnimationFrame(() => {
      const items = containerRef.current?.querySelectorAll<HTMLElement>(
        "[role='menuitemradio'], [role='menuitem']",
      );
      if (!items?.length) return;
      items[position === "first" ? 0 : items.length - 1]?.focus();
    });
  }

  async function chooseWorkspace(workspace: ShellWorkspace) {
    if (workspace.id === activeWorkspace.id) {
      onOpenChange(false);
      triggerRef.current?.focus();
      return;
    }
    setSwitchingId(workspace.id);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.id)}/activate`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error("workspace_switch_failed");
      window.location.reload();
    } catch {
      setError(t("common.workspaceSwitcher.switchFailed"));
      setSwitchingId(null);
    }
  }

  return (
    <div
      className={`workspace-switcher ${compact ? "workspace-switcher-compact" : ""}`}
      ref={containerRef}
    >
      <button
        ref={triggerRef}
        className="workspace-switcher-trigger"
        type="button"
        aria-label={t("common.workspaceSwitcher.triggerAria", { name: activeWorkspace.name })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          if (!open) setError(null);
          onOpenChange(!open);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAndFocus(event.key === "ArrowDown" ? "first" : "last");
          }
        }}
      >
        <span className="workspace-switcher-mark" aria-hidden="true">
          <ActiveIcon size={16} />
        </span>
        <span className="workspace-switcher-copy">
          <small>{t(`common.workspaceSwitcher.types.${activeWorkspace.type}`)}</small>
          <strong>{activeWorkspace.name}</strong>
        </span>
        <ChevronDown className="workspace-switcher-chevron" size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="workspace-switcher-popover"
          id={menuId}
          role="menu"
          aria-label={t("common.workspaceSwitcher.menuAria")}
          aria-describedby={error ? errorId : undefined}
          onKeyDown={(event) => focusByKey(event, "[role='menuitemradio'], [role='menuitem']")}
        >
          <div className="workspace-switcher-header">
            <strong>{t("common.workspaceSwitcher.heading")}</strong>
            <span>{t("common.workspaceSwitcher.description")}</span>
          </div>
          <div className="workspace-switcher-options">
            {workspaces.map((workspace) => {
              const selected = workspace.id === activeWorkspace.id;
              const Icon = workspace.type === "household" ? House : UserRound;
              const switching = switchingId === workspace.id;
              return (
                <button
                  key={workspace.id}
                  className="workspace-switcher-option"
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={switchingId !== null}
                  onClick={() => void chooseWorkspace(workspace)}
                >
                  <span className="workspace-switcher-option-mark" aria-hidden="true"><Icon size={16} /></span>
                  <span className="workspace-switcher-option-copy">
                    <strong>{workspace.name}</strong>
                    <small>
                      {t(`common.workspaceSwitcher.types.${workspace.type}`)}
                      {" · "}
                      {t(`common.workspaceSwitcher.roles.${workspace.role}`)}
                    </small>
                  </span>
                  {switching ? (
                    <span className="workspace-switcher-status">{t("common.workspaceSwitcher.switching")}</span>
                  ) : selected ? <Check size={16} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          {error ? <p className="workspace-switcher-error" id={errorId} role="alert">{error}</p> : null}
          <div className="workspace-switcher-separator" role="separator" />
          <Link
            className="workspace-switcher-manage"
            href="/workspaces"
            role="menuitem"
            onClick={() => onOpenChange(false)}
          >
            <UsersRound size={16} aria-hidden="true" />
            {t("common.workspaceSwitcher.manage")}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

const DATE_RANGE_QUICK_PICK_KEYS = {
  this_month: "common.dateRange.quick.currentMonth",
  month_to_date: "common.dateRange.quick.monthToDate",
  last_month: "common.dateRange.quick.previousMonth",
  next_month: "common.dateRange.quick.nextMonth",
  last_3_months: "common.dateRange.quick.previousThreeMonths",
  last_6_months: "common.dateRange.quick.previousSixMonths",
  this_year: "common.dateRange.quick.yearToDate",
  last_12_months: "common.dateRange.quick.previousTwelveMonths",
} as const;

function DateRangePicker({
  open,
  onOpenChange,
  compact = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
}) {
  const t = useTranslations();
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
        aria-label={t("common.dateRange.triggerAria", { label })}
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
          aria-label={t("common.dateRange.dialogTitle")}
          onKeyDown={(event) => focusByKey(event, "[data-range-option]")}
        >
          <div className="date-range-popover-header">
            <strong>{t("common.dateRange.dialogTitle")}</strong>
            <span>{t("common.dateRange.dialogDescription", { timeZone })}</span>
          </div>
          <div className="date-range-quick-picks" role="group" aria-label={t("common.dateRange.quickGroup")}>
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
                  <span>{t(DATE_RANGE_QUICK_PICK_KEYS[quickPick.id])}</span>
                  {selected ? <Check size={14} aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
          <div className="date-range-custom">
            <strong>{t("common.dateRange.customHeading")}</strong>
            <div className="date-range-fields">
              <label>
                <span>{t("common.dateRange.startDate")}</span>
                <input
                  type="date"
                  value={from}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? errorId : undefined}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label>
                <span>{t("common.dateRange.endDate")}</span>
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
              <button className="button button-ghost" type="button" onClick={cancelCustomRange}>{t("common.actions.cancel")}</button>
              <button className="button button-primary" type="button" onClick={applyCustomRange}>{t("common.actions.applyRange")}</button>
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
  workspace,
  open,
  onOpenChange,
  compact = false,
}: {
  user: ShellUser;
  workspace: ShellWorkspace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  compact?: boolean;
}) {
  const t = useTranslations();
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
        aria-label={t("common.shell.accountMenuFor", { name: user.displayName })}
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
            <span>{t("common.app.reportingCurrency", { currency: user.defaultCurrency })}</span>
          </span>
        ) : null}
        {!compact ? <ChevronDown className="account-menu-chevron" size={14} aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div
          className="account-menu-popover"
          id={menuId}
          role="menu"
          aria-label={t("common.shell.userAccount")}
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
            <span>{workspace.name}</span>
            <strong>{t("common.app.workspaceDetails", { currency: workspace.defaultCurrency, timeZone: workspace.timeZone })}</strong>
          </div>
          <div className="account-menu-separator" role="separator" />
          <Link className="account-menu-item" href="/workspaces" role="menuitem" onClick={() => onOpenChange(false)}>
            <UsersRound size={16} aria-hidden="true" />
            {t("common.navigation.pages.workspaces.label")}
          </Link>
          <Link className="account-menu-item" href="/settings" role="menuitem" onClick={() => onOpenChange(false)}>
            <Settings2 size={16} aria-hidden="true" />
            {t("common.navigation.pages.profileSettings.label")}
          </Link>
          <Link className="account-menu-item" href="/import-export" role="menuitem" onClick={() => onOpenChange(false)}>
            <DatabaseBackup size={16} aria-hidden="true" />
            {t("common.navigation.pages.dataBackups.label")}
          </Link>
          <div className="account-menu-separator" role="separator" />
          <button className="account-menu-item account-menu-signout" type="button" role="menuitem" onClick={() => void logout()}>
            <LogOut size={16} aria-hidden="true" />
            {t("common.actions.signOut")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NavigationSection({ id, label, items, pathname }: { id: string; label: string; items: NavigationItem[]; pathname: string }) {
  return (
    <section className="nav-section" aria-labelledby={`nav-${id}`}>
      <span className="nav-label" id={`nav-${id}`}>{label}</span>
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
  items,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  items: NavigationItem[];
}) {
  const t = useTranslations();
  const router = useRouter();
  const listboxId = useId();
  const listboxRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? items.filter((item) => item.label.toLocaleLowerCase().includes(normalized))
      : items;
  }, [items, query]);
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
      title={t("common.shell.commandTitle")}
      description={t("common.shell.commandDescription")}
      size="sm"
    >
      <div className="command-palette">
        <Input
          autoFocus
          leading={<Search size={15} />}
          aria-label={t("common.shell.commandInputLabel")}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeItem ? `${listboxId}-option-${safeActiveIndex}` : undefined}
          placeholder={t("common.shell.commandInputPlaceholder")}
          value={query}
          onChange={(event) => {
            setActiveIndex(0);
            onQueryChange(event.target.value);
          }}
          onKeyDown={handleSearchKeyDown}
        />
        <div ref={listboxRef} className="command-results" id={listboxId} role="listbox" aria-label={t("common.shell.commandResultsLabel")}>
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
        {!filtered.length ? <p className="command-empty">{t("common.shell.commandNoMatches")}</p> : null}
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
