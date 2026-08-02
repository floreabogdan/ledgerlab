"use client";

import { Bell, KeyRound, Save, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CurrencyCombobox } from "@/components/ui/currency-combobox";
import { defaultLanguage, languageManifests } from "@/i18n/generated";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";

import {
  Button,
  DataState,
  Field,
  FormMessage,
  Input,
  Page,
  readRecord,
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
type SaveSettings = (body: Row, success: string, options?: SaveOptions) => Promise<void>;

const tabs: Array<{ id: ProfileTab; label: string; icon: React.ReactNode }> = [
  { id: "profile", label: "Profile & preferences", icon: <UserRound size={16} /> },
  { id: "reminders", label: "Reminders", icon: <Bell size={16} /> },
  { id: "security", label: "Security", icon: <KeyRound size={16} /> },
];

const COMMON_LOCALES = [
  ["en-US", "English (United States)"],
  ["en-GB", "English (United Kingdom)"],
  ["de-DE", "Deutsch (Deutschland)"],
  ["es-ES", "Español (España)"],
  ["fr-FR", "Français (France)"],
  ["it-IT", "Italiano (Italia)"],
  ["nl-NL", "Nederlands (Nederland)"],
  ["pl-PL", "Polski (Polska)"],
  ["pt-BR", "Português (Brasil)"],
  ["pt-PT", "Português (Portugal)"],
  ["ro-RO", "Română (România)"],
  ["cs-CZ", "Čeština (Česko)"],
  ["hu-HU", "Magyar (Magyarország)"],
  ["tr-TR", "Türkçe (Türkiye)"],
  ["ja-JP", "日本語 (日本)"],
  ["ko-KR", "한국어 (대한민국)"],
  ["zh-CN", "中文 (中国)"],
] as const;

const TIME_ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((zone) => zone !== "UTC")];
const LOCALE_SUGGESTIONS = COMMON_LOCALES.map(([value, description]) => ({
  value,
  label: value,
  description,
}));
const TIME_ZONE_SUGGESTIONS = TIME_ZONES.map((zone) => ({
  value: zone,
  label: zone,
  description: zone === "UTC"
    ? "Coordinated Universal Time"
    : zone.replaceAll("_", " ").replace("/", " · "),
}));

function supportedUiLanguage(value: unknown) {
  const candidate = stringFrom(value, defaultLanguage);
  return languageManifests.some((manifest) => manifest.tag === candidate)
    ? candidate
    : defaultLanguage;
}

export default function ProfileSettingsPage() {
  const router = useRouter();
  const { data: raw, loading, error, reload } = useJson<Record<string, unknown>>(
    "/api/settings",
    {},
  );
  const payload = readRecord(readRecord(raw).data ?? raw);
  const [tab, setTab] = useState<ProfileTab>("profile");
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function performAction(body: Row, success: string, options?: SaveOptions) {
    setActionError(null);
    setMessage(null);
    try {
      await requestJson("/api/settings", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (body.action === "preferences") window.dispatchEvent(new Event("ledgerlab:settings-updated"));
      setMessage(success);
      await reload();
      if (options?.refreshLanguage) router.refresh();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Could not save this setting");
    }
  }

  return (
    <Page>
      <ViewHeader
        eyebrow="Local account"
        title="Profile settings"
        description="Manage your identity, regional display defaults, in-app reminders and local password. Finance lists and data tools have dedicated workspaces."
      />
      <FormMessage error={actionError} success={message} />
      <DataState loading={loading} error={error} onRetry={reload}>
        <div className={ui.settingsLayout}>
          <nav className={ui.settingsNav} aria-label="Profile settings sections" role="tablist">
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
                  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const currentIndex = tabs.findIndex((candidate) => candidate.id === item.id);
                  const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
                  const nextIndex = event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : (currentIndex + (forward ? 1 : -1) + tabs.length) % tabs.length;
                  const next = tabs[nextIndex];
                  if (!next) return;
                  setTab(next.id);
                  document.getElementById(`profile-settings-tab-${next.id}`)?.focus();
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
            {tab === "profile" ? <ProfilePreferences initial={payload} onSave={performAction} /> : null}
            {tab === "reminders" ? <ReminderSettings initial={payload} onSave={performAction} /> : null}
            {tab === "security" ? <SecuritySettings user={readRecord(payload.user)} onSave={performAction} /> : null}
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
  const preferences = readRecord(initial.preferences ?? initial);
  const user = readRecord(initial.user);
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [locale, setLocale] = useState(DEFAULT_LOCALE);
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE);
  const [uiLanguage, setUiLanguage] = useState<string>(defaultLanguage);
  const [compactTables, setCompactTables] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      setName(stringFrom(user.name ?? user.displayName ?? preferences.displayName));
      setCurrency(stringFrom(user.defaultCurrency ?? preferences.currency, DEFAULT_CURRENCY).toUpperCase());
      setLocale(stringFrom(user.locale ?? preferences.locale, DEFAULT_LOCALE));
      setTimeZone(stringFrom(user.timeZone ?? preferences.timeZone, DEFAULT_TIME_ZONE));
      setUiLanguage(supportedUiLanguage(user.uiLanguage));
      setCompactTables(preferences.compactTables !== false);
    });
  }, [initial, preferences.compactTables, preferences.currency, preferences.displayName, preferences.locale, preferences.timeZone, user.defaultCurrency, user.displayName, user.locale, user.name, user.timeZone, user.uiLanguage]);

  async function save() {
    setSaving(true);
    try {
      const languageChanged = uiLanguage !== supportedUiLanguage(user.uiLanguage);
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
        "Profile preferences saved.",
        { refreshLanguage: languageChanged },
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Profile & preferences" description="Identity, interface language, reporting currency, regional formatting and table density">
      <div className={ui.settingsContent}>
        <div className={ui.settingsGroup}>
          <h3>Profile</h3>
          <div className={ui.formGrid}>
            <Field label="Display name">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
            </Field>
            <Field label="Email">
              <Input value={stringFrom(user.email)} disabled />
            </Field>
          </div>
        </div>
        <div className={ui.settingsGroup}>
          <h3>Reporting & region</h3>
          <div className={`${ui.formGrid} ${ui.settingsDefaultsGrid}`}>
            <Field
              htmlFor="profile-currency"
              label="Reporting currency"
              hint="Used for totals across accounts. Changing it recalculates reports; it never relabels native history. Cross-currency totals require BNR to publish both currencies."
            >
              <CurrencyCombobox id="profile-currency" value={currency} locale={locale} onChange={setCurrency} />
            </Field>
            <Field htmlFor="profile-locale" label="Formatting locale" hint="Controls how dates, numbers, and currencies are formatted. It does not change the interface language.">
              <SuggestionInput
                id="profile-locale"
                value={locale}
                suggestions={LOCALE_SUGGESTIONS}
                onValueChange={setLocale}
                placeholder="e.g. en-US"
                maxLength={35}
                emptyMessage="No matching common locale. You can keep this valid BCP 47 locale code."
              />
            </Field>
            <Field htmlFor="profile-time-zone" label="Time zone" hint="Determines today, monthly boundaries, and due or overdue status.">
              <SuggestionInput
                id="profile-time-zone"
                value={timeZone}
                suggestions={TIME_ZONE_SUGGESTIONS}
                onValueChange={setTimeZone}
                placeholder="e.g. Europe/Bucharest"
                maxLength={100}
                emptyMessage="No matching IANA time zone. You can keep a custom runtime-supported value."
              />
            </Field>
          </div>
        </div>
        <div className={ui.settingsGroup}>
          <h3>Interface</h3>
          <div className={ui.formGrid}>
            <Field
              className={ui.formSpan}
              htmlFor="profile-ui-language"
              label="Interface language"
              hint="Changes the words, labels, and messages shown by LedgerLab. Formatting locale remains a separate setting for dates, numbers, and currencies."
            >
              <Select id="profile-ui-language" value={uiLanguage} onValueChange={setUiLanguage}>
                {languageManifests.map((manifest) => (
                  <option value={manifest.tag} key={manifest.tag}>{manifest.nativeName}</option>
                ))}
              </Select>
            </Field>
          </div>
          <Toggle
            checked={compactTables}
            onChange={setCompactTables}
            label="Compact data tables"
            description="Use tighter rows while retaining readable mobile layouts."
          />
        </div>
        <div className={ui.formActions}>
          <Button disabled={saving} icon={<Save size={15} />} onClick={() => void save()}>
            {saving ? "Saving…" : "Save profile settings"}
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
  }, [initial, reminders.budgetWarnings, reminders.daysBefore, reminders.dueSoon, reminders.overdue]);

  async function save() {
    setSaving(true);
    try {
      await onSave(
        { action: "reminders", dueSoon, overdue, budgetWarnings, daysBefore: Number(daysBefore) },
        "Reminder preferences saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="In-app reminders" description="Shown inside LedgerLab; no external messages are sent">
      <div className={ui.settingsContent}>
        <div className={ui.settingsGroup}>
          <Field label="Due-soon window">
            <Select value={daysBefore} onValueChange={(value) => setDaysBefore(value)}>
              <option value="1">1 day before</option>
              <option value="3">3 days before</option>
              <option value="7">7 days before</option>
              <option value="14">14 days before</option>
            </Select>
          </Field>
        </div>
        <Toggle checked={dueSoon} onChange={setDueSoon} label="Bills due soon" description="Highlight planned occurrences approaching their due date." />
        <Toggle checked={overdue} onChange={setOverdue} label="Overdue obligations" description="Keep unpaid past-due occurrences visible on the dashboard." />
        <Toggle checked={budgetWarnings} onChange={setBudgetWarnings} label="Budget warnings" description="Flag actual spending near or above a category limit." />
        <div className={`${ui.formActions} ${ui.formOffset}`}>
          <Button disabled={saving} icon={<Save size={15} />} onClick={() => void save()}>
            {saving ? "Saving…" : "Save reminders"}
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
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  async function changePassword() {
    setLocalError(null);
    if (newPassword.length < 10) {
      setLocalError("Use at least 10 characters for the new password.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setLocalError("New passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      await onSave(
        { action: "password-change", currentPassword, newPassword },
        "Password changed. Other sessions were revoked.",
      );
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="Local account security" description="Password and persistent session controls">
      <div className={ui.settingsContent}>
        <div className={ui.settingsGroup}>
          <div className={ui.inlineNotice}>
            <UserRound size={17} />
            <span>Signed in as <strong>{stringFrom(user.email, "local user")}</strong>. Session cookies are HttpOnly and stored session tokens are hashed.</span>
          </div>
        </div>
        <div className={ui.settingsGroup}>
          <h3>Change password</h3>
          <div className={ui.formGrid}>
            <Field label="Current password" className={ui.formSpan}>
              <Input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            </Field>
            <Field label="New password" hint="At least 10 characters">
              <Input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </Field>
            <Field label="Confirm new password">
              <Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
            </Field>
          </div>
          <FormMessage error={localError} />
        </div>
        <div className={ui.formActions}>
          <Button disabled={saving || !currentPassword || !newPassword} icon={<KeyRound size={15} />} onClick={() => void changePassword()}>
            {saving ? "Changing…" : "Change password"}
          </Button>
        </div>
      </div>
    </Section>
  );
}
