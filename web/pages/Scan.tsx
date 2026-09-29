import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { VehicleStatus } from "@shared/types";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { Button, Card, Input, Loading, PageHeader, StatusBadge } from "../components/ui";
import { QrScanner, parseQrTarget } from "../components/QrScanner";

interface PublicVehicle {
  id?: string;
  org_name: string;
  internal_number: string;
  manufacturer: string;
  model: string;
  category_name: string;
  status: VehicleStatus;
  license_plate: string;
  signed_in: boolean;
}

export function ScanPage() {
  const { t } = useT();
  const nav = useNavigate();
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resolve = useCallback(
    async (code: string) => {
      setBusy(true);
      setError(null);
      try {
        const v = await api.get<PublicVehicle>(`/api/public/qr/${encodeURIComponent(code)}`);
        if (v.id) nav(`/vehicles/${v.id}`, { replace: true });
        else setError(t("scan.not_found"));
      } catch {
        setError(t("scan.not_found"));
      } finally {
        setBusy(false);
      }
    },
    [nav, t],
  );

  const onScan = useCallback(
    (text: string) => {
      const code = parseQrTarget(text);
      if (code) resolve(code);
      else setError(t("scan.not_found"));
    },
    [resolve, t],
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    if (manual.trim()) resolve(manual.trim());
  }

  return (
    <div className="mx-auto max-w-md">
      <PageHeader title={t("scan.title")} subtitle={t("scan.hint")} />
      <QrScanner onResult={onScan} active={!busy} />
      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-center text-sm text-red-700">{error}</p>}
      <form onSubmit={submit} className="mt-4 flex gap-2">
        <Input placeholder={t("scan.manual")} value={manual} onChange={(e) => setManual(e.target.value)} autoCapitalize="characters" />
        <Button type="submit" loading={busy}>
          {t("scan.open")}
        </Button>
      </form>
    </div>
  );
}

/** Landing page for /q/:code (QR sticker). Works without login when enabled. */
export function PublicQrPage() {
  const { t } = useT();
  const { code } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const q = useQuery<PublicVehicle>({ queryKey: ["public-qr", code], queryFn: () => api.get(`/api/public/qr/${encodeURIComponent(code!)}`), retry: false });

  const targetId = me ? q.data?.id : undefined;
  useEffect(() => {
    if (targetId) nav(`/vehicles/${targetId}`, { replace: true });
  }, [targetId, nav]);
  if (targetId) return <Loading />;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-slate-100 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-4 flex items-center justify-center gap-2">
          <img src="/favicon.svg" alt="" className="h-9 w-9" />
          <span className="text-lg font-bold text-slate-900">{q.data?.org_name ?? t("app.name")}</span>
        </div>
        <Card>
          {q.isLoading ? (
            <Loading />
          ) : q.error || !q.data ? (
            <p className="text-center text-sm text-slate-600">{t("scan.not_found")}</p>
          ) : (
            <div className="text-center">
              <div className="font-mono text-3xl font-bold text-slate-900">{q.data.internal_number}</div>
              <div className="mt-1 text-slate-800">
                {q.data.manufacturer} {q.data.model}
              </div>
              <div className="text-sm text-slate-500">
                {q.data.category_name}
                {q.data.license_plate ? ` · ${q.data.license_plate}` : ""}
              </div>
              <div className="mt-3">
                <StatusBadge status={q.data.status} />
              </div>
            </div>
          )}
          <div className="mt-5">
            <Link to={`/login?next=/q/${code}`} className="block">
              <Button className="w-full">{t("auth.login")}</Button>
            </Link>
            <p className="mt-2 text-center text-xs text-slate-500">{t("public.login_hint")}</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
