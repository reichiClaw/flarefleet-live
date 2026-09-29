import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Language, Role } from "@shared/types";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { fmtDateTime } from "../lib/format";
import { Badge, Button, EmptyState, Field, Input, Loading, Modal, PageHeader, Select, Toggle, errorMessage, useToast } from "../components/ui";

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  language: Language;
  must_change_password: boolean;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
}

interface NewUser {
  email: string;
  name: string;
  role: Role;
  language: Language;
  send_invite: boolean;
}

export function UsersPage() {
  const { t, lang } = useT();
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState<NewUser | null>(null);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [secret, setSecret] = useState<{ password: string | null; invited: boolean } | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  const q = useQuery<{ results: UserRow[] }>({ queryKey: ["users"], queryFn: () => api.get("/api/users") });
  const emailEnabled = !!me?.settings.email_enabled;

  const create = useMutation({
    mutationFn: (u: NewUser) => api.post<UserRow & { temporary_password: string | null; invited: boolean }>("/api/users", u),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setCreating(null);
      setSecret({ password: r.temporary_password, invited: r.invited });
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });
  const update = useMutation({
    mutationFn: (u: UserRow) => api.patch(`/api/users/${u.id}`, { name: u.name, role: u.role, language: u.language, is_active: u.is_active }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setEditing(null);
      toast.push(t("common.saved"));
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });
  const reset = useMutation({
    mutationFn: (id: string) => api.post<{ emailed: boolean; temporary_password: string | null }>(`/api/users/${id}/reset-password`),
    onSuccess: (r) => {
      setEditing(null);
      setSecret({ password: r.temporary_password, invited: r.emailed });
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete<{ mode: "removed" | "anonymized" }>(`/api/users/${id}`),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["users"] });
      setDeleting(null);
      setEditing(null);
      toast.push(r.mode === "removed" ? t("users.deleted") : t("users.deleted_anonymized"));
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });

  const roleOptions: Role[] = me?.role === "super_admin" ? ["user", "admin", "super_admin"] : ["user", "admin"];
  const canDelete = (u: UserRow) => u.id !== me?.id && (u.role !== "super_admin" || me?.role === "super_admin");

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("users.title")} action={<Button size="sm" onClick={() => setCreating({ email: "", name: "", role: "user", language: lang, send_invite: emailEnabled })}>+ {t("common.new")}</Button>} />
      {q.isLoading ? (
        <Loading />
      ) : !q.data?.results.length ? (
        <EmptyState text={t("common.empty")} />
      ) : (
        <div className="space-y-2">
          {q.data.results.map((u) => (
            <button key={u.id} type="button" onClick={() => setEditing({ ...u })} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-left shadow-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900">{u.name}</span>
                  <Badge tone={u.role === "super_admin" ? "red" : u.role === "admin" ? "blue" : "slate"}>{t(`role.${u.role}`)}</Badge>
                  {!u.is_active && <Badge>{t("common.inactive")}</Badge>}
                  {u.must_change_password && <Badge tone="amber">{t("users.must_change")}</Badge>}
                </div>
                <div className="truncate text-xs text-slate-500">
                  {u.email} · {t("users.last_login")}: {fmtDateTime(u.last_login_at, lang)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      <Modal
        open={!!creating}
        onClose={() => setCreating(null)}
        title={t("users.new")}
        footer={
          <Button className="w-full" onClick={() => creating && create.mutate(creating)} loading={create.isPending} disabled={!creating?.email || !creating?.name}>
            {t("common.save")}
          </Button>
        }
      >
        {creating && (
          <div className="space-y-3">
            <Field label={t("common.name")} required>
              <Input value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} autoFocus />
            </Field>
            <Field label={t("common.email")} required>
              <Input type="email" value={creating.email} onChange={(e) => setCreating({ ...creating, email: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("common.role")}>
                <Select value={creating.role} onChange={(e) => setCreating({ ...creating, role: e.target.value as Role })}>
                  {roleOptions.map((r) => (
                    <option key={r} value={r}>
                      {t(`role.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("common.language")}>
                <Select value={creating.language} onChange={(e) => setCreating({ ...creating, language: e.target.value as Language })}>
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </Select>
              </Field>
            </div>
            {emailEnabled && <Toggle checked={creating.send_invite} onChange={(v) => setCreating({ ...creating, send_invite: v })} label={t("users.send_invite")} />}
          </div>
        )}
      </Modal>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.email}
        footer={
          <div className="space-y-2">
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => editing && reset.mutate(editing.id)} loading={reset.isPending}>
                {t("users.reset_password")}
              </Button>
              <Button className="flex-1" onClick={() => editing && update.mutate(editing)} loading={update.isPending}>
                {t("common.save")}
              </Button>
            </div>
            {editing && canDelete(editing) && (
              <Button variant="ghost" className="w-full text-red-700" onClick={() => setDeleting(editing)}>
                {t("users.delete")}
              </Button>
            )}
          </div>
        }
      >
        {editing && (
          <div className="space-y-3">
            <Field label={t("common.name")}>
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("common.role")}>
                <Select value={editing.role} onChange={(e) => setEditing({ ...editing, role: e.target.value as Role })} disabled={editing.role === "super_admin" && me?.role !== "super_admin"}>
                  {[...new Set([...roleOptions, editing.role])].map((r) => (
                    <option key={r} value={r}>
                      {t(`role.${r}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("common.language")}>
                <Select value={editing.language} onChange={(e) => setEditing({ ...editing, language: e.target.value as Language })}>
                  <option value="de">Deutsch</option>
                  <option value="en">English</option>
                </Select>
              </Field>
            </div>
            <Toggle checked={editing.is_active} onChange={(v) => setEditing({ ...editing, is_active: v })} label={t("common.active")} />
          </div>
        )}
      </Modal>

      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t("users.delete")}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setDeleting(null)}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" className="flex-1" onClick={() => deleting && remove.mutate(deleting.id)} loading={remove.isPending}>
              {t("users.delete")}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-slate-700">{t("users.delete_confirm", { name: deleting?.name ?? "", email: deleting?.email ?? "" })}</p>
        <p className="mt-2 text-xs text-slate-500">{t("users.delete_hint")}</p>
      </Modal>

      <Modal open={!!secret} onClose={() => setSecret(null)} title={t("users.reset_password")} footer={<Button className="w-full" onClick={() => setSecret(null)}>{t("common.close")}</Button>}>
        {secret?.invited && !secret.password ? (
          <p className="text-sm text-slate-700">{t("users.invited")}</p>
        ) : (
          <div>
            <p className="text-sm text-slate-700">{t("users.temp_password")}</p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 rounded-xl bg-slate-100 px-3 py-2 font-mono text-lg">{secret?.password}</code>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  navigator.clipboard?.writeText(secret?.password ?? "");
                  toast.push(t("common.copied"), "info");
                }}
              >
                {t("common.copy")}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
