"use client";

import { Bell, KeyRound, Save, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CurrencyCombobox } from "@/components/ui/currency-combobox";
import { useTranslator, useTranslations } from "@/i18n/client";
import { defaultLanguage, languageManifests } from "@/i18n/generated";
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  DEFAULT_TIME_ZONE,
} from "@/lib/currencies";

import {
  Button,
  DataState,
  Field,
  FormMessage,
  Input,
  Page,
  readRecord,
  RequestError,
  requestJson,
  Section,
  Select,
  stringFrom,
  SuggestionInput,
  Toggle,
  useJson,
  ViewHeader,
} from "../_components/feature-kit";
import ui from "../_components/pages.module.css";

type Row = Record<string, unknown>;
type ProfileTab = "profile" | "reminders" | "security";
type SaveOptions = { refreshLanguage?: boolean };
type SaveSettings = (
  body: Row,
  success: string,
  options?: SaveOptions,
) => Promise<void>;

const COMMON_LOCALES = [
  "en-US",
  "en-GB",
  "de-DE",
  "es-ES",
  "fr-FR",
  "it-IT",
  "nl-NL",
  "pl-PL",
  "pt-BR",
  "pt-PT",
  "ro-RO",
  "cs-CZ",
  "hu-HU",
  "tr-TR",
  "ja-JP",
  "ko-KR",
  "zh-CN",
] as const;

const TIME_ZONES = [
  "UTC",
  ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC"),
];

function supportedUiLanguage(value: unknown) {
  const candidate = stringFrom(value, defaultLanguage);
  return languageManifests.some((manifest) => manifest.tag === candidate)
    ? candidate
    : defaultLanguage;
}

export default function ProfileSettingsPage() {
  const translator = useTranslator();
  const t = translator.translate;
  const router = useRouter();
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(
    "/api/settings",
    {},
  );
  const payload = readRecord(readRecord(raw).data ?? raw);
  const [tab, setTab] = useState<ProfileTab>("profile");
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const tabs: Array<{ id: ProfileTab; label: string; icon: ReactNode }> = [
    {
      id: "profile",
      label: t("settings.tabs.profile"),
      icon: <UserRound size={16} aria-hidden="true" />,
    },
    {
      id: "reminders",
      label: t("settings.tabs.reminders"),
      icon: <Bell size={16} aria-hidden="true" />,
    },
    {
      id: "security",
      label: t("settings.tabs.security"),
      icon: <KeyRound size={16} aria-hidden="true" />,
    },
  ];

  async function performAction(
    body: Row,
    success: string,
    options?: SaveOptions,
  ) {
    setActionError(null);
    setMessage(null);
    try {
      await requestJson(
        "/api/settings",
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        translator,
      );
      if (body.action === "preferences") {
        window.dispatchEvent(new Event("ledgerlab:settings-updated"));
      }
      setMessage(success);
      await reload();
      if (options?.refreshLanguage) router.refresh();
    } catch (caught) {
      setActionError(
        caught instanceof RequestError
          ? caught.message
          : t("settings.messages.actionFailed"),
      );
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("settings.page.eyebrow")}
        title={t("settings.title")}
        description={t("settings.page.description")}
      />
      <FormMessage error={actionError} success={message} />
      <DataState loading={loading} error={error} onRetry={reload}>
        <div className={ui.settingsLayout}>
          <nav
            className={ui.settingsNav}
            aria-label={t("settings.page.sectionsAria")}
            role="tablist"
          >
            {tabs.map((item) => (
              <button
                type="button"
                role="tab"
                id={`profile-settings-tab-${item.id}`}
                aria-controls={`profile-settings-panel-${item.id}`}
                aria-selected={tab === item.id}
                tabIndex={tab === item.id ? 0 : -1}
                onClick={() => {
                  setTab(item.id);
                  setMessage(null);
                  setActionError(null);
                }}
                onKeyDown={(event) => {
                  if (
                    ![
                      "ArrowLeft",
                      "ArrowRight",
                      "ArrowUp",
                      "ArrowDown",
                      "Home",
                      "End",
                    ].includes(event.key)
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const currentIndex = tabs.findIndex(
                    (candidate) => candidate.id === item.id,
                  );
                  const forward =
                    event.key === "ArrowRight" || event.key === "ArrowDown";
                  const nextIndex =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : (currentIndex + (forward ? 1 : -1) + tabs.length) %
                          tabs.length;
                  const next = tabs[nextIndex];
                  if (!next) return;
                  setTab(next.id);
                  document
                    .getElementById(`profile-settings-tab-${next.id}`)
                    ?.focus();
                }}
                key={item.id}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
          <div
            className={ui.settingsPanel}
            id={`profile-settings-panel-${tab}`}
            role="tabpanel"
            aria-labelledby={`profile-settings-tab-${tab}`}
            tabIndex={0}
          >
            {tab === "profile" ? (
              <ProfilePreferences initial={payload} onSave={performAction} />
            ) : null}
            {tab === "reminders" ? (
              <ReminderSettings initial={payload} onSave={performAction} />
            ) : null}
            {tab === "security" ? (
              <SecuritySettings
                user={readRecord(payload.user)}
                onSave={performAction}
              />
            ) : null}
          </div>
        </div>
      </DataState>
    </Page>
  );
}

function ProfilePreferences({
  initial,
  onSave,
}: {
  initial: Row;
  onSave: SaveSettings;
}) {
  const t = useTranslations();
  const preferences = readRecord(initial.preferences ?? initial);
  const user = readRecord(initial.user);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [locale, setLocale] = useState(DEFAULT_LOCALE);
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [uiLanguage, setUiLanguage] = useState<string>(defaultLanguage);
  const [compactTables, setCompactTables] = useState(true);
  const [saving, setSaving] = useState(false);
  const localeSuggestions = useMemo(
    () =>
      COMMON_LOCALES.map((value) => {
        const parsed = new Intl.Locale(value);
        const language =
          new Intl.DisplayNames([value], { type: "language" }).of(
            parsed.language,
          ) ?? parsed.language;
        const region = parsed.region
          ? (new Intl.DisplayNames([value], { type: "region" }).of(
              parsed.region,
            ) ?? parsed.region)
          : null;
        return {
          value,
          label: value,
          description: region
            ? t("settings.preferences.localeDescription", {
                language,
                region,
              })
            : language,
        };
      }),
    [t],
  );
  const timeZoneSuggestions = useMemo(
    () =>
      TIME_ZONES.map((zone) => ({
        value: zone,
        label: zone,
        description:
          zone === "UTC"
            ? t("settings.preferences.utcDescription")
            : zone.replaceAll("_", " ").replaceAll("/", " · "),
      })),
    [t],
  );

  useEffect(() => {
    queueMicrotask(() => {
      setName(
        stringFrom(user.name ?? user.displayName ?? preferences.displayName),
      );
      setCurrency(
        stringFrom(
          user.defaultCurrency ?? preferences.currency,
          DEFAULT_CURRENCY,
        ).toUpperCase(),
      );
      setLocale(
        stringFrom(user.locale ?? preferences.locale, DEFAULT_LOCALE),
      );
      setTimeZone(
        stringFrom(user.timeZone ?? preferences.timeZone, DEFAULT_TIME_ZONE),
      );
      setUiLanguage(supportedUiLanguage(user.uiLanguage));
      setCompactTables(preferences.compactTables !== false);
    });
  }, [
    initial,
    preferences.compactTables,
    preferences.currency,
    preferences.displayName,
    preferences.locale,
    preferences.timeZone,
    user.defaultCurrency,
    user.displayName,
    user.locale,
    user.name,
    user.timeZone,
    user.uiLanguage,
  ]);

  async function save() {
    setSaving(true);
    try {
      const languageChanged =
        uiLanguage !== supportedUiLanguage(user.uiLanguage);
      await onSave(
        {
          action: "preferences",
          displayName: name.trim(),
          uiLanguage,
          locale,
          currency,
          timeZone,
          compactTables,
        },
        t("settings.preferences.saved"),
        { refreshLanguage: languageChanged },
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title={t("settings.preferences.title")}
      description={t("settings.preferences.description")}
    >
      <div className={ui.settingsContent}>
        <div className={ui.settingsGroup}>
          <h3>{t("settings.preferences.profileGroup")}</h3>
          <div className={ui.formGrid}>
            <Field label={t("settings.preferences.displayName")}>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("settings.preferences.displayNamePlaceholder")}
              />
            </Field>
            <Field label={t("settings.preferences.email")}>
              <Input value={stringFrom(user.email)} disabled />
            </Field>
          </div>
        </div>
        <div className={ui.settingsGroup}>
          <h3>{t("settings.preferences.regionGroup")}</h3>
          <div className={`${ui.formGrid} ${ui.settingsDefaultsGrid}`}>
            <Field
              htmlFor="profile-currency"
              label={t("settings.preferences.reportingCurrency")}
              hint={t("settings.preferences.reportingCurrencyHelp")}
            >
              <CurrencyCombobox
                id="profile-currency"
                value={currency}
                locale={locale}
                onChange={setCurrency}
              />
            </Field>
            <Field
              htmlFor="profile-locale"
              label={t("settings.preferences.locale")}
              hint={t("settings.preferences.localeHelp")}
            >
              <SuggestionInput
                id="profile-locale"
                value={locale}
                suggestions={localeSuggestions}
                onValueChange={setLocale}
                placeholder={t("settings.preferences.localePlaceholder")}
                maxLength={35}
                emptyMessage={t("settings.preferences.localeNoMatches")}
              />
            </Field>
            <Field
              htmlFor="profile-time-zone"
              label={t("settings.preferences.timeZone")}
              hint={t("settings.preferences.timeZoneHelp")}
            >
              <SuggestionInput
                id="profile-time-zone"
                value={timeZone}
                suggestions={timeZoneSuggestions}
                onValueChange={setTimeZone}
                placeholder={t("settings.preferences.timeZonePlaceholder")}
                maxLength={100}
                emptyMessage={t("settings.preferences.timeZoneNoMatches")}
              />
            </Field>
          </div>
        </div>
        <div className={ui.settingsGroup}>
          <h3>{t("settings.preferences.interfaceGroup")}</h3>
          <div className={ui.formGrid}>
            <Field
              className={ui.formSpan}
              htmlFor="profile-ui-language"
              label={t("settings.preferences.interfaceLanguage")}
              hint={t("settings.preferences.interfaceLanguageHelp")}
            >
              <Select
                id="profile-ui-language"
                value={uiLanguage}
                onValueChange={setUiLanguage}
              >
                {languageManifests.map((manifest) => (
                  <option value={manifest.tag} key={manifest.tag}>
                    {manifest.nativeName}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Toggle
            checked={compactTables}
            onChange={setCompactTables}
            label={t("settings.preferences.compactTables")}
            description={t("settings.preferences.compactTablesHelp")}
          />
        </div>
        <div className={ui.formActions}>
          <Button
            disabled={saving}
            icon={<Save size={15} />}
            onClick={() => void save()}
          >
            {saving
              ? t("settings.preferences.saving")
              : t("settings.preferences.save")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function ReminderSettings({
  initial,
  onSave,
}: {
  initial: Row;
  onSave: SaveSettings;
}) {
  const t = useTranslations();
  const reminders = readRecord(initial.reminders);
  const [dueSoon, setDueSoon] = useState(true);
  const [overdue, setOverdue] = useState(true);
  const [budgetWarnings, setBudgetWarnings] = useState(true);
  const [daysBefore, setDaysBefore] = useState("3");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      setDueSoon(reminders.dueSoon !== false);
      setOverdue(reminders.overdue !== false);
      setBudgetWarnings(reminders.budgetWarnings !== false);
      setDaysBefore(String(reminders.daysBefore ?? 3));
    });
  }, [
    initial,
    reminders.budgetWarnings,
    reminders.daysBefore,
    reminders.dueSoon,
    reminders.overdue,
  ]);

  async function save() {
    setSaving(true);
    try {
      await onSave(
        {
          action: "reminders",
          dueSoon,
          overdue,
          budgetWarnings,
          daysBefore: Number(daysBefore),
        },
        t("settings.reminders.saved"),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title={t("settings.reminders.title")}
      description={t("settings.reminders.description")}
    >
      <div className={ui.settingsContent}>
        <div className={ui.settingsGroup}>
          <Field label={t("settings.reminders.dueSoonWindow")}>
            <Select
              value={daysBefore}
              onValueChange={(value) => setDaysBefore(value)}
            >
              {[1, 3, 7, 14].map((count) => (
                <option value={String(count)} key={count}>
                  {t("settings.reminders.daysBefore", { count })}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Toggle
          checked={dueSoon}
          onChange={setDueSoon}
          label={t("settings.reminders.dueSoon")}
          description={t("settings.reminders.dueSoonHelp")}
        />
        <Toggle
          checked={overdue}
          onChange={setOverdue}
          label={t("settings.reminders.overdue")}
          description={t("settings.reminders.overdueHelp")}
        />
        <Toggle
          checked={budgetWarnings}
          onChange={setBudgetWarnings}
          label={t("settings.reminders.budgetWarnings")}
          description={t("settings.reminders.budgetWarningsHelp")}
        />
        <div className={`${ui.formActions} ${ui.formOffset}`}>
          <Button
            disabled={saving}
            icon={<Save size={15} />}
            onClick={() => void save()}
          >
            {saving
              ? t("settings.reminders.saving")
              : t("settings.reminders.save")}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function SecuritySettings({
  user,
  onSave,
}: {
  user: Row;
  onSave: SaveSettings;
}) {
  const translator = useTranslator();
  const t = translator.translate;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const identity = stringFrom(user.email, t("settings.security.localUser"));

  async function changePassword() {
    setLocalError(null);
    if (newPassword.length < 10) {
      setLocalError(t("settings.security.validation.passwordMinimum"));
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError(t("settings.security.validation.passwordsMismatch"));
      return;
    }
    setSaving(true);
    try {
      await onSave(
        { action: "password-change", currentPassword, newPassword },
        t("settings.security.saved"),
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      title={t("settings.security.title")}
      description={t("settings.security.description")}
    >
      <div className={ui.settingsContent}>
        <div className={ui.settingsGroup}>
          <div className={ui.inlineNotice}>
            <UserRound size={17} aria-hidden="true" />
            <span>
              {translator.rich<ReactNode, "settings.security.signedInAs">(
                "settings.security.signedInAs",
                { identity },
                {
                  identity: (parts) => <strong>{parts}</strong>,
                },
              )}
            </span>
          </div>
        </div>
        <div className={ui.settingsGroup}>
          <h3>{t("settings.security.changeHeading")}</h3>
          <div className={ui.formGrid}>
            <Field
              label={t("settings.security.currentPassword")}
              className={ui.formSpan}
            >
              <Input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            </Field>
            <Field
              label={t("settings.security.newPassword")}
              hint={t("settings.security.newPasswordHelp")}
            >
              <Input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
              />
            </Field>
            <Field label={t("settings.security.confirmPassword")}>
              <Input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            </Field>
          </div>
          <FormMessage error={localError} />
        </div>
        <div className={ui.formActions}>
          <Button
            disabled={saving || !currentPassword || !newPassword}
            icon={<KeyRound size={15} />}
            onClick={() => void changePassword()}
          >
            {saving
              ? t("settings.security.saving")
              : t("settings.security.save")}
          </Button>
        </div>
      </div>
    </Section>
  );
}
