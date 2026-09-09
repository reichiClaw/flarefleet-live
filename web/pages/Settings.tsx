import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Language, Settings } from "@shared/types";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, Textarea, Toggle, errorMessage, useToast } from "../components/ui";

interface Payload {
  settings: Settings;
  system: {
    email_binding: boolean;
    email_available: boolean;
    email_from: string;
    email_from_env: string;
    public_base_url_env: string;
    users: number;
    categories: number;
  };
}

function emailErrorHint(code: string | null, t: (k: string, v?: Record<string, string | number>) => string): string {
  switch (code) {
    case "no_binding":
      return t("settings.email_status_no_binding");
    case "no_sender":
      return t("settings.email_status_no_sender");
    case "disabled":
      return t("settings.email_err_disabled");
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return t("settings.email_err_domain");
    case "E_RECIPIENT_NOT_ALLOWED":
      return t("settings.email_err_recipient");
    default:
      return code ? `(${code})` : "";
  }
}

export function SettingsPage() {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery<Payload>({ queryKey: ["settings"], queryFn: () => api.get("/api/settings") });
  const [form, setForm] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setForm(q.data.settings);
  }, [q.data]);

  const save = useMutation({
    mutationFn: (s: Settings) => api.put<{ settings: Settings }>("/api/settings", s),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["me"] });
      toast.push(t("common.saved"));
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error: string | null; from: string }>("/api/settings/test-email"),
    onSuccess: (r) => {
      if (r.ok) toast.push(t("settings.test_sent"), "success");
      else toast.push(`${t("settings.test_failed")} ${emailErrorHint(r.error, t)}`, "error");
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });

  if (q.isLoading || !form) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const sys = q.data!.system;
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: Number(e.target.value) });
  const str = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const bool = (k: keyof Settings) => (v: boolean) => setForm({ ...form, [k]: v });

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader title={t("settings.title")} action={<Button onClick={() => save.mutate(form)} loading={save.isPending}>{t("common.save")}</Button>} />

      <Card title={t("settings.general")}>
        <div className="space-y-3">
          <Field label={t("settings.org_name")}>
            <Input value={form.org_name} onChange={str("org_name")} />
          </Field>
          <Field label={t("settings.default_language")}>
            <Select value={form.default_language} onChange={(e) => setForm({ ...form, default_language: e.target.value as Language })}>
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <Field label={t("settings.public_base_url")} hint={sys.public_base_url_env}>
            <Input value={form.public_base_url} onChange={str("public_base_url")} placeholder="https://fleet.example.com" />
          </Field>
          <Toggle checked={form.public_qr_page} onChange={bool("public_qr_page")} label={t("settings.public_qr_page")} />
          <Field label={t("settings.pdf_footer")}>
            <Textarea value={form.pdf_footer} onChange={str("pdf_footer")} rows={2} />
          </Field>
        </div>
      </Card>

      <Card title={t("settings.workflows")}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("settings.min_photos_check_in")}>
            <Input type="number" min={0} max={10} value={form.min_photos_check_in} onChange={num("min_photos_check_in")} />
          </Field>
          <Field label={t("settings.min_photos_loan")}>
            <Input type="number" min={0} max={10} value={form.min_photos_loan} onChange={num("min_photos_loan")} />
          </Field>
          <Field label={t("settings.min_photos_return")}>
            <Input type="number" min={0} max={10} value={form.min_photos_return} onChange={num("min_photos_return")} />
          </Field>
          <Field label={t("settings.min_photos_check_out")}>
            <Input type="number" min={0} max={10} value={form.min_photos_check_out} onChange={num("min_photos_check_out")} />
          </Field>
          <Field label={t("settings.default_loan_days")} className="col-span-2">
            <Input type="number" min={1} max={365} value={form.default_loan_days} onChange={num("default_loan_days")} />
          </Field>
        </div>
        <div className="mt-3 space-y-2">
          <Toggle checked={form.signature_required_check_in} onChange={bool("signature_required_check_in")} label={t("settings.signature_required_check_in")} />
          <Toggle checked={form.signature_required_return} onChange={bool("signature_required_return")} label={t("settings.signature_required_return")} />
          <Toggle checked={form.signature_required_check_out} onChange={bool("signature_required_check_out")} label={t("settings.signature_required_check_out")} />
        </div>
      </Card>

      <Card title={t("settings.email")}>
        <p className={`mb-3 text-sm ${sys.email_available ? "text-slate-600" : "text-amber-700"}`}>
          {sys.email_binding
            ? sys.email_available
              ? t("settings.email_status_ok", { from: sys.email_from })
              : t("settings.email_status_no_sender")
            : t("settings.email_status_no_binding")}
        </p>
        <div className="space-y-3">
          <Toggle checked={form.email_enabled} onChange={bool("email_enabled")} label={t("settings.email_enabled")} />
          <Field label={t("settings.email_from")} hint={t("settings.email_from_hint", { env: sys.email_from_env || "–" })}>
            <Input type="email" value={form.email_from} onChange={str("email_from")} placeholder="fleet@yourdomain.com" />
          </Field>
          <Field label={t("settings.overdue_digest_recipients")}>
            <Input value={form.overdue_digest_recipients} onChange={str("overdue_digest_recipients")} placeholder="dispo@example.com, chef@example.com" />
          </Field>
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={() => test.mutate()} loading={test.isPending} disabled={!sys.email_binding}>
              {t("settings.test_email")}
            </Button>
            <span className="text-xs text-slate-500">{t("settings.test_email_hint")}</span>
          </div>
          <details className="text-sm text-slate-600">
            <summary className="cursor-pointer font-medium text-slate-700">{t("settings.email_setup_title")}</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5">
              <li>{t("settings.email_setup_1")}</li>
              <li>{t("settings.email_setup_2")}</li>
              <li>{t("settings.email_setup_3")}</li>
              <li>{t("settings.email_setup_4")}</li>
            </ol>
          </details>
        </div>
      </Card>

      <Card title={t("settings.system")}>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-slate-500">{t("users.title")}</dt>
          <dd>{sys.users}</dd>
          <dt className="text-slate-500">{t("cats.title")}</dt>
          <dd>{sys.categories}</dd>
        </dl>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => save.mutate(form)} loading={save.isPending}>
          {t("common.save")}
        </Button>
      </div>
    </div>
  );
}
