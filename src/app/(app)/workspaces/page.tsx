"use client";

import {
  ArrowRightLeft,
  Copy,
  Crown,
  DoorOpen,
  History,
  Plus,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { useState } from "react";

import { CurrencyCombobox } from "@/components/ui/currency-combobox";
import { useTranslator } from "@/i18n/client";
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIME_ZONE } from "@/lib/currencies";

import {
  Button,
  DataState,
  Field,
  FormMessage,
  Input,
  Modal,
  Page,
  Pill,
  readRecord,
  RequestError,
  requestJson,
  ResponsiveTable,
  Section,
  useJson,
  ViewHeader,
} from "../_components/feature-kit";
import styles from "./workspaces.module.css";

type Role = "owner" | "member";
type Workspace = {
  id: string;
  type: "personal" | "household";
  name: string;
  defaultCurrency: string;
  timeZone: string;
  role: Role;
};
type Member = {
  userId: string;
  displayName: string;
  email: string;
  role: Role;
  joinedAt: string;
};
type Invitation = {
  id: string;
  email: string;
  role: Role;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
};
type Activity = {
  id: string;
  actorDisplayName: string | null;
  entityType: string;
  action: string;
  createdAt: string;
};
type ManagementPayload = {
  actorUserId?: string;
  workspace?: Workspace;
  members?: Member[];
  invitations?: Invitation[];
  activity?: Activity[];
};

const emptyPayload: ManagementPayload = {};

function dateTime(value: string, locale: string, timeZone?: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(parsed);
}

const activityActionKeys = {
  create: "settings.workspaces.activity.actions.create",
  create_default: "settings.workspaces.activity.actions.createDefault",
  update: "settings.workspaces.activity.actions.update",
  archive: "settings.workspaces.activity.actions.archive",
  restore: "settings.workspaces.activity.actions.restore",
  clear: "settings.workspaces.activity.actions.clear",
  void: "settings.workspaces.activity.actions.void",
  pay: "settings.workspaces.activity.actions.pay",
  partial_pay: "settings.workspaces.activity.actions.partialPay",
  skip: "settings.workspaces.activity.actions.skip",
  cancel: "settings.workspaces.activity.actions.cancel",
  undo: "settings.workspaces.activity.actions.undo",
  upload: "settings.workspaces.activity.actions.upload",
  delete: "settings.workspaces.activity.actions.delete",
  save: "settings.workspaces.activity.actions.save",
  copy: "settings.workspaces.activity.actions.copy",
  promote: "settings.workspaces.activity.actions.promote",
  demote: "settings.workspaces.activity.actions.demote",
  transfer_ownership: "settings.workspaces.activity.actions.transferOwnership",
  remove: "settings.workspaces.activity.actions.remove",
  leave: "settings.workspaces.activity.actions.leave",
  accept: "settings.workspaces.activity.actions.accept",
  revoke: "settings.workspaces.activity.actions.revoke",
  preferences: "settings.workspaces.activity.actions.update",
  reminders: "settings.workspaces.activity.actions.update",
} as const;

const activityEntityKeys = {
  workspace: "settings.workspaces.activity.entities.workspace",
  workspace_invitation: "settings.workspaces.activity.entities.invitation",
  workspace_member: "settings.workspaces.activity.entities.member",
  account: "settings.workspaces.activity.entities.account",
  category: "settings.workspaces.activity.entities.category",
  tag: "settings.workspaces.activity.entities.tag",
  merchant: "settings.workspaces.activity.entities.merchant",
  transaction: "settings.workspaces.activity.entities.transaction",
  planned_payment: "settings.workspaces.activity.entities.plannedPayment",
  planned_occurrence: "settings.workspaces.activity.entities.plannedOccurrence",
  attachment: "settings.workspaces.activity.entities.attachment",
  budget: "settings.workspaces.activity.entities.budget",
  month_plan: "settings.workspaces.activity.entities.monthPlan",
  month_plan_scenario: "settings.workspaces.activity.entities.monthPlanScenario",
  credit_card_profile: "settings.workspaces.activity.entities.creditCard",
  credit_card_statement: "settings.workspaces.activity.entities.creditCardStatement",
  credit_card_payment: "settings.workspaces.activity.entities.creditCardPayment",
  loan_profile: "settings.workspaces.activity.entities.loan",
  loan_rate_period: "settings.workspaces.activity.entities.loanRate",
  loan_payment: "settings.workspaces.activity.entities.loanPayment",
  loan_disbursement: "settings.workspaces.activity.entities.loanDisbursement",
  user_settings: "settings.workspaces.activity.entities.settings",
} as const;

export default function WorkspacesPage() {
  const translator = useTranslator();
  const t = translator.translate;
  const { data, loading, error, reload } = useJson<ManagementPayload>(
    "/api/workspaces/current",
    emptyPayload,
  );
  const workspace = data.workspace;
  const members = data.members ?? [];
  const invitations = data.invitations ?? [];
  const activity = data.activity ?? [];
  const owner = workspace?.role === "owner";
  const household = workspace?.type === "household";
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  async function perform(
    url: string,
    init: RequestInit,
    success: string,
  ) {
    setWorking(true);
    setMessage(null);
    setActionError(null);
    try {
      const result = await requestJson(url, init, translator);
      setMessage(success);
      await reload();
      return result;
    } catch (caught) {
      setActionError(
        caught instanceof RequestError
          ? caught.message
          : t("settings.workspaces.messages.actionFailed"),
      );
      return null;
    } finally {
      setWorking(false);
    }
  }

  async function changeRole(member: Member, nextRole: Role) {
    await perform(
      `/api/workspaces/current/members/${encodeURIComponent(member.userId)}`,
      { method: "PATCH", body: JSON.stringify({ role: nextRole }) },
      nextRole === "owner"
        ? t("settings.workspaces.messages.promoted", { name: member.displayName })
        : t("settings.workspaces.messages.demoted", { name: member.displayName }),
    );
  }

  async function removeMember(member: Member) {
    if (!window.confirm(t("settings.workspaces.members.removeConfirm", { name: member.displayName }))) return;
    await perform(
      `/api/workspaces/current/members/${encodeURIComponent(member.userId)}`,
      { method: "DELETE" },
      t("settings.workspaces.messages.removed", { name: member.displayName }),
    );
  }

  async function transfer(member: Member) {
    if (!window.confirm(t("settings.workspaces.members.transferConfirm", { name: member.displayName }))) return;
    const result = await perform(
      "/api/workspaces/current/transfer",
      { method: "POST", body: JSON.stringify({ userId: member.userId }) },
      t("settings.workspaces.messages.transferred", { name: member.displayName }),
    );
    if (result) window.location.assign("/workspaces");
  }

  return (
    <Page>
      <ViewHeader
        eyebrow={t("settings.workspaces.eyebrow")}
        title={t("settings.workspaces.title")}
        description={t("settings.workspaces.description")}
        actions={
          <Button icon={<Plus size={16} />} onClick={() => setCreateOpen(true)}>
            {t("settings.workspaces.create.action")}
          </Button>
        }
      />

      <FormMessage error={actionError} success={message} />
      <DataState loading={loading} error={error} onRetry={reload} empty={!workspace}>
        {workspace ? (
          <>
            <Section
              title={workspace.name}
              description={household
                ? t("settings.workspaces.current.householdDescription")
                : t("settings.workspaces.current.personalDescription")}
            >
              <div className={styles.summaryGrid}>
                <div className={styles.summaryItem}>
                  <span>{t("settings.workspaces.current.type")}</span>
                  <strong>{household
                    ? t("settings.workspaces.types.household")
                    : t("settings.workspaces.types.personal")}</strong>
                </div>
                <div className={styles.summaryItem}>
                  <span>{t("settings.workspaces.current.role")}</span>
                  <strong>{workspace.role === "owner"
                    ? t("settings.workspaces.roles.owner")
                    : t("settings.workspaces.roles.member")}</strong>
                </div>
                <div className={styles.summaryItem}>
                  <span>{t("settings.workspaces.current.financialContext")}</span>
                  <strong>{t("common.app.workspaceDetails", {
                    currency: workspace.defaultCurrency,
                    timeZone: workspace.timeZone,
                  })}</strong>
                </div>
              </div>
            </Section>

            {!household ? (
              <Section
                title={t("settings.workspaces.personal.title")}
                description={t("settings.workspaces.personal.description")}
                action={
                  <Button variant="secondary" icon={<UsersRound size={16} />} onClick={() => setCreateOpen(true)}>
                    {t("settings.workspaces.create.action")}
                  </Button>
                }
              >
                <div className={styles.sectionBody}>
                  <p>{t("settings.workspaces.personal.help")}</p>
                </div>
              </Section>
            ) : (
              <>
                <Section
                  title={t("settings.workspaces.members.title")}
                  description={t("settings.workspaces.members.description")}
                >
                  <ResponsiveTable label={t("settings.workspaces.members.tableLabel")}>
                    <thead>
                      <tr>
                        <th>{t("settings.workspaces.members.person")}</th>
                        <th>{t("settings.workspaces.members.role")}</th>
                        <th>{t("settings.workspaces.members.joined")}</th>
                        <th><span className="sr-only">{t("entities.shared.table.actions")}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => {
                        const self = member.userId === data.actorUserId;
                        return (
                          <tr key={member.userId}>
                            <td>
                              <div className={styles.memberIdentity}>
                                <strong>{member.displayName}{self ? ` ${t("settings.workspaces.members.you")}` : ""}</strong>
                                <small>{member.email}</small>
                              </div>
                            </td>
                            <td>
                              <Pill tone={member.role === "owner" ? "info" : "neutral"}>
                                {member.role === "owner"
                                  ? t("settings.workspaces.roles.owner")
                                  : t("settings.workspaces.roles.member")}
                              </Pill>
                            </td>
                            <td>{dateTime(member.joinedAt, translator.formattingLocale, workspace.timeZone)}</td>
                            <td>
                              {owner && !self ? (
                                <div className={styles.actions}>
                                  <Button
                                    variant="ghost"
                                    disabled={working}
                                    icon={member.role === "owner" ? <ShieldCheck size={15} /> : <Crown size={15} />}
                                    onClick={() => void changeRole(member, member.role === "owner" ? "member" : "owner")}
                                  >
                                    {member.role === "owner"
                                      ? t("settings.workspaces.members.demote")
                                      : t("settings.workspaces.members.promote")}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    disabled={working}
                                    icon={<ArrowRightLeft size={15} />}
                                    onClick={() => void transfer(member)}
                                  >
                                    {t("settings.workspaces.members.transfer")}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    disabled={working}
                                    icon={<UserMinus size={15} />}
                                    onClick={() => void removeMember(member)}
                                  >
                                    {t("settings.workspaces.members.remove")}
                                  </Button>
                                </div>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </ResponsiveTable>
                </Section>

                {owner ? (
                  <Section
                    title={t("settings.workspaces.invitations.title")}
                    description={t("settings.workspaces.invitations.description")}
                    action={
                      <Button variant="secondary" icon={<UserPlus size={16} />} onClick={() => setInviteOpen(true)}>
                        {t("settings.workspaces.invitations.action")}
                      </Button>
                    }
                  >
                    <div className={styles.sectionBody}>
                      {inviteUrl ? (
                        <div className={styles.inviteResult} role="status">
                          <div>
                            <strong>{t("settings.workspaces.invitations.linkReady")}</strong>
                            <code>{inviteUrl}</code>
                          </div>
                          <Button
                            variant="secondary"
                            icon={<Copy size={15} />}
                            onClick={() => void navigator.clipboard.writeText(inviteUrl).then(() => {
                              setMessage(t("settings.workspaces.messages.linkCopied"));
                            })}
                          >
                            {t("settings.workspaces.invitations.copy")}
                          </Button>
                        </div>
                      ) : null}
                      {invitations.length ? (
                        <ResponsiveTable label={t("settings.workspaces.invitations.tableLabel")}>
                          <thead>
                            <tr>
                              <th>{t("settings.workspaces.invitations.email")}</th>
                              <th>{t("settings.workspaces.invitations.role")}</th>
                              <th>{t("settings.workspaces.invitations.status")}</th>
                              <th>{t("settings.workspaces.invitations.expires")}</th>
                              <th><span className="sr-only">{t("entities.shared.table.actions")}</span></th>
                            </tr>
                          </thead>
                          <tbody>
                            {invitations.map((invitation) => (
                              <tr key={invitation.id}>
                                <td><div className={styles.invitationIdentity}><strong>{invitation.email}</strong></div></td>
                                <td>{invitation.role === "owner"
                                  ? t("settings.workspaces.roles.owner")
                                  : t("settings.workspaces.roles.member")}</td>
                                <td><Pill tone={invitation.status === "pending" ? "info" : "neutral"}>
                                  {t(`settings.workspaces.invitationStatus.${invitation.status}` as
                                    | "settings.workspaces.invitationStatus.pending"
                                    | "settings.workspaces.invitationStatus.accepted"
                                    | "settings.workspaces.invitationStatus.revoked"
                                    | "settings.workspaces.invitationStatus.expired")}
                                </Pill></td>
                                <td>{dateTime(invitation.expiresAt, translator.formattingLocale, workspace.timeZone)}</td>
                                <td>{invitation.status === "pending" ? (
                                  <Button
                                    variant="ghost"
                                    disabled={working}
                                    onClick={() => void perform(
                                      `/api/workspaces/current/invitations/${encodeURIComponent(invitation.id)}`,
                                      { method: "DELETE" },
                                      t("settings.workspaces.messages.invitationRevoked"),
                                    )}
                                  >
                                    {t("settings.workspaces.invitations.revoke")}
                                  </Button>
                                ) : null}</td>
                              </tr>
                            ))}
                          </tbody>
                        </ResponsiveTable>
                      ) : (
                        <p>{t("settings.workspaces.invitations.empty")}</p>
                      )}
                    </div>
                  </Section>
                ) : null}

                <Section
                  title={t("settings.workspaces.activity.title")}
                  description={t("settings.workspaces.activity.description")}
                >
                  <div className={styles.sectionBody}>
                    {activity.length ? (
                      <ResponsiveTable label={t("settings.workspaces.activity.tableLabel")}>
                        <thead>
                          <tr>
                            <th>{t("settings.workspaces.activity.actor")}</th>
                            <th>{t("settings.workspaces.activity.action")}</th>
                            <th>{t("settings.workspaces.activity.entity")}</th>
                            <th>{t("settings.workspaces.activity.time")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activity.map((event) => (
                            <tr key={event.id}>
                              <td><div className={styles.activityActor}><History size={15} aria-hidden="true" /><strong>{event.actorDisplayName ?? t("settings.workspaces.activity.deletedActor")}</strong></div></td>
                              <td>{t(activityActionKeys[event.action as keyof typeof activityActionKeys] ?? "settings.workspaces.activity.actions.other")}</td>
                              <td>{t(activityEntityKeys[event.entityType as keyof typeof activityEntityKeys] ?? "settings.workspaces.activity.entities.other")}</td>
                              <td>{dateTime(event.createdAt, translator.formattingLocale, workspace.timeZone)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </ResponsiveTable>
                    ) : <p>{t("settings.workspaces.activity.empty")}</p>}
                  </div>
                </Section>

                <Section
                  title={t("settings.workspaces.danger.title")}
                  description={t("settings.workspaces.danger.description")}
                >
                  <div className={styles.sectionBody}>
                    <div className={styles.dangerZone}>
                      <div>
                        <strong>{owner
                          ? t("settings.workspaces.danger.deleteTitle")
                          : t("settings.workspaces.danger.leaveTitle")}</strong>
                        <p>{owner
                          ? t("settings.workspaces.danger.deleteHelp")
                          : t("settings.workspaces.danger.leaveHelp")}</p>
                      </div>
                      <Button
                        variant="danger"
                        icon={owner ? <Trash2 size={16} /> : <DoorOpen size={16} />}
                        onClick={() => owner ? setDeleteOpen(true) : setLeaveOpen(true)}
                      >
                        {owner
                          ? t("settings.workspaces.danger.deleteAction")
                          : t("settings.workspaces.danger.leaveAction")}
                      </Button>
                    </div>
                  </div>
                </Section>
              </>
            )}
          </>
        ) : null}
      </DataState>

      <CreateHouseholdDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        working={working}
        onCreate={async (input) => {
          const result = await perform(
            "/api/workspaces",
            { method: "POST", body: JSON.stringify(input) },
            t("settings.workspaces.messages.created"),
          );
          const payload = readRecord(result);
          const created = readRecord(payload.workspace ?? readRecord(payload.data).workspace);
          const id = typeof created.id === "string" ? created.id : null;
          if (!id) return;
          await requestJson(`/api/workspaces/${encodeURIComponent(id)}/activate`, {
            method: "POST",
            body: JSON.stringify({}),
          }, translator);
          window.location.assign("/workspaces");
        }}
      />
      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        working={working}
        onInvite={async (input) => {
          const result = await perform(
            "/api/workspaces/current/invitations",
            { method: "POST", body: JSON.stringify(input) },
            t("settings.workspaces.messages.invitationCreated"),
          );
          if (!result) return;
          const payload = readRecord(result);
          const dataRecord = readRecord(payload.data);
          const directUrl = payload.inviteUrl ?? dataRecord.inviteUrl;
          const token = payload.token ?? dataRecord.token;
          if (typeof directUrl === "string") setInviteUrl(directUrl);
          else if (typeof token === "string") setInviteUrl(`${window.location.origin}/invite/${encodeURIComponent(token)}`);
          setInviteOpen(false);
        }}
      />
      <DeleteHouseholdDialog
        open={deleteOpen}
        workspaceName={workspace?.name ?? ""}
        working={working}
        onClose={() => setDeleteOpen(false)}
        onDelete={async (confirmation) => {
          const result = await perform(
            "/api/workspaces/current",
            { method: "DELETE", body: JSON.stringify({ confirmation }) },
            t("settings.workspaces.messages.deleted"),
          );
          if (result) window.location.assign("/");
        }}
      />
      <Modal
        open={leaveOpen}
        onClose={() => setLeaveOpen(false)}
        title={t("settings.workspaces.leaveDialog.title")}
        description={t("settings.workspaces.leaveDialog.description", { name: workspace?.name ?? "" })}
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaveOpen(false)}>{t("common.actions.cancel")}</Button>
            <Button
              variant="danger"
              disabled={working}
              onClick={() => void perform(
                "/api/workspaces/current/leave",
                { method: "POST", body: JSON.stringify({}) },
                t("settings.workspaces.messages.left"),
              ).then((result) => {
                if (result) window.location.assign("/");
              })}
            >
              {t("settings.workspaces.leaveDialog.confirm")}
            </Button>
          </>
        }
      >
        <p>{t("settings.workspaces.leaveDialog.help")}</p>
      </Modal>
    </Page>
  );
}

function CreateHouseholdDialog({
  open,
  onClose,
  working,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  working: boolean;
  onCreate: (input: { name: string; currency: string; timeZone: string }) => Promise<void>;
}) {
  const translator = useTranslator();
  const t = translator.translate;
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [timeZone, setTimeZone] = useState(DEFAULT_TIME_ZONE);
  const valid = name.trim().length > 0 && timeZone.trim().length > 0;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("settings.workspaces.create.title")}
      description={t("settings.workspaces.create.description")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button disabled={working || !valid} onClick={() => void onCreate({ name: name.trim(), currency, timeZone: timeZone.trim() })}>
            {working ? t("settings.workspaces.create.creating") : t("settings.workspaces.create.submit")}
          </Button>
        </>
      }
    >
      <div className={styles.formGrid}>
        <Field label={t("settings.workspaces.create.name")} htmlFor="household-name">
          <Input id="household-name" value={name} maxLength={80} autoFocus onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("settings.workspaces.create.currency")} htmlFor="household-currency">
          <CurrencyCombobox id="household-currency" value={currency} locale={translator.formattingLocale || DEFAULT_LOCALE} onChange={setCurrency} />
        </Field>
        <Field label={t("settings.workspaces.create.timeZone")} htmlFor="household-time-zone" hint={t("settings.workspaces.create.timeZoneHelp")}>
          <Input id="household-time-zone" value={timeZone} maxLength={100} onChange={(event) => setTimeZone(event.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

function InviteDialog({
  open,
  onClose,
  working,
  onInvite,
}: {
  open: boolean;
  onClose: () => void;
  working: boolean;
  onInvite: (input: { email: string; role: Role; expiresInHours: number }) => Promise<void>;
}) {
  const t = useTranslator().translate;
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("settings.workspaces.invitations.dialogTitle")}
      description={t("settings.workspaces.invitations.dialogDescription")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button
            disabled={working || !/^\S+@\S+\.\S+$/.test(email.trim())}
            onClick={() => void onInvite({ email: email.trim(), role, expiresInHours: 24 * 7 })}
          >
            {working ? t("settings.workspaces.invitations.creating") : t("settings.workspaces.invitations.submit")}
          </Button>
        </>
      }
    >
      <div className={styles.formGrid}>
        <Field label={t("settings.workspaces.invitations.email")} htmlFor="invitation-email">
          <Input id="invitation-email" type="email" autoComplete="email" autoFocus value={email} maxLength={254} onChange={(event) => setEmail(event.target.value)} />
        </Field>
        <Field label={t("settings.workspaces.invitations.role")} htmlFor="invitation-role">
          <select id="invitation-role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="member">{t("settings.workspaces.roles.member")}</option>
            <option value="owner">{t("settings.workspaces.roles.owner")}</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function DeleteHouseholdDialog({
  open,
  workspaceName,
  working,
  onClose,
  onDelete,
}: {
  open: boolean;
  workspaceName: string;
  working: boolean;
  onClose: () => void;
  onDelete: (confirmation: string) => Promise<void>;
}) {
  const t = useTranslator().translate;
  const [confirmation, setConfirmation] = useState("");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("settings.workspaces.deleteDialog.title")}
      description={t("settings.workspaces.deleteDialog.description", { name: workspaceName })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("common.actions.cancel")}</Button>
          <Button variant="danger" disabled={working || confirmation !== workspaceName} onClick={() => void onDelete(confirmation)}>
            {working ? t("settings.workspaces.deleteDialog.deleting") : t("settings.workspaces.deleteDialog.confirm")}
          </Button>
        </>
      }
    >
      <Field
        label={t("settings.workspaces.deleteDialog.field", { name: workspaceName })}
        htmlFor="delete-household-confirmation"
        hint={t("settings.workspaces.deleteDialog.help")}
      >
        <Input id="delete-household-confirmation" autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
      </Field>
    </Modal>
  );
}
