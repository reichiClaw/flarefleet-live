import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AuditEntry, Damage, Loan, MediaItem, Protocol, Severity, Vehicle } from "@shared/types";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { fmtDate, fmtDateTime, fmtNum } from "../lib/format";
import { Badge, Button, Card, EmptyState, ErrorBox, Field, Input, KeyValue, Loading, Modal, PageHeader, Select, StatusBadge, Textarea, Toggle, cx, errorMessage, useToast } from "../components/ui";
import { PhotoCapture } from "../components/PhotoCapture";
import { ProtocolCard } from "./Documents";
import { ReserveModal, VehicleReservations, useVehicleReservations } from "./Reservations";

type Tab = "overview" | "history" | "damages" | "photos" | "loans" | "reservations";

export function useVehicle(id: string | undefined) {
  return useQuery<Vehicle>({ queryKey: ["vehicle", id], queryFn: () => api.get(`/api/vehicles/${id}`), enabled: !!id });
}

export function invalidateVehicle(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ["vehicle", id] });
  qc.invalidateQueries({ queryKey: ["vehicle-timeline", id] });
  qc.invalidateQueries({ queryKey: ["vehicle-damages", id] });
  qc.invalidateQueries({ queryKey: ["vehicle-loans", id] });
  qc.invalidateQueries({ queryKey: ["vehicle-reservations", id] });
  qc.invalidateQueries({ queryKey: ["vehicles"] });
  qc.invalidateQueries({ queryKey: ["dashboard"] });
  qc.invalidateQueries({ queryKey: ["protocols"] });
}

export function VehicleDetailPage() {
  const { t, lang } = useT();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) || "overview";
  const q = useVehicle(id);
  const reservations = useVehicleReservations(id);
  const [qrOpen, setQrOpen] = useState(false);
  const [damageOpen, setDamageOpen] = useState(false);
  const [resolveDamage, setResolveDamage] = useState<Damage | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [dueOpen, setDueOpen] = useState(false);
  const [reserveOpen, setReserveOpen] = useState(false);
  const unarchive = useMutation({
    mutationFn: () => api.post(`/api/vehicles/${id}/unarchive`),
    onSuccess: () => invalidateVehicle(qc, id!),
    onError: (e) => toast.push(errorMessage(e), "error"),
  });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const v = q.data;
  const cap = v.capabilities;
  const planned = reservations.data?.results ?? [];

  const primaryActions = [
    cap.check_in && { to: `/vehicles/${v.id}/check-in`, label: t("action.check_in"), desc: t("action.check_in_desc"), tone: "bg-sky-600" },
    cap.loan && { to: `/vehicles/${v.id}/loan`, label: t("action.loan"), desc: t("action.loan_desc"), tone: "bg-amber-600" },
    cap.return && { to: `/vehicles/${v.id}/return`, label: t("action.return"), desc: t("action.return_desc"), tone: "bg-emerald-600" },
    cap.check_out && { to: `/vehicles/${v.id}/check-out`, label: t("action.check_out"), desc: t("action.check_out_desc"), tone: "bg-slate-700" },
  ].filter(Boolean) as { to: string; label: string; desc: string; tone: string }[];

  const secondaryActions = [
    cap.maintenance_start && { to: `/vehicles/${v.id}/maintenance/start`, label: t("action.maintenance_start") },
    cap.maintenance_end && { to: `/vehicles/${v.id}/maintenance/end`, label: t("action.maintenance_end") },
    cap.reserve && { onClick: () => setReserveOpen(true), label: t("res.new") },
    cap.report_damage && { onClick: () => setDamageOpen(true), label: t("action.report_damage") },
    cap.edit && { to: `/vehicles/${v.id}/edit`, label: t("action.edit") },
    cap.correct && { to: `/vehicles/${v.id}/correct`, label: t("action.correct") },
    v.status !== "archived" && v.status !== "checked_out" && { onClick: () => setDueOpen(true), label: t("action.set_return_due") },
    cap.archive && { onClick: () => setArchiveOpen(true), label: t("action.archive") },
    cap.unarchive && { onClick: () => unarchive.mutate(), label: t("action.unarchive") },
  ].filter(Boolean) as { to?: string; onClick?: () => void; label: string }[];

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: t("vehicle.tab.overview") },
    { key: "history", label: t("vehicle.tab.history") },
    { key: "damages", label: `${t("vehicle.tab.damages")}${v.open_damage_count ? ` (${v.open_damage_count})` : ""}` },
    { key: "photos", label: t("vehicle.tab.photos") },
    { key: "loans", label: t("vehicle.tab.loans") },
    { key: "reservations", label: `${t("res.title")}${planned.length ? ` (${planned.length})` : ""}` },
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{v.internal_number}</span>
            <StatusBadge status={v.status} />
          </span>
        }
        subtitle={`${v.manufacturer} ${v.model} · ${v.category_name}${v.license_plate ? ` · ${v.license_plate}` : ""}`}
        back={() => nav(-1)}
        action={
          <button type="button" onClick={() => setQrOpen(true)} className="rounded-xl border border-slate-300 bg-white p-2 text-slate-700" aria-label={t("vehicle.qr")}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" />
            </svg>
          </button>
        }
      />

      {v.active_loan && (
        <div className={cx("mb-4 rounded-2xl border px-4 py-3 text-sm", v.active_loan.overdue ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50")}>
          <div className="font-semibold text-slate-900">
            {t("vehicle.active_loan")}: {v.active_loan.borrower_name}
            {v.active_loan.company_name ? ` · ${v.active_loan.company_name}` : ""}
          </div>
          <div className="text-slate-700">
            {t("vehicle.since")} {fmtDateTime(v.active_loan.checked_out_at, lang)} · {t("vehicle.expected_return")} {fmtDateTime(v.active_loan.expected_return_at, lang)}
            {v.active_loan.overdue && <span className="ml-2 font-semibold text-red-700">{t("common.overdue")}</span>}
          </div>
          {v.active_loan.borrower_phone && (
            <a href={`tel:${v.active_loan.borrower_phone}`} className="mt-1 inline-block text-blue-700 underline">
              {v.active_loan.borrower_phone}
            </a>
          )}
        </div>
      )}

      {planned.length > 0 && (
        <button type="button" onClick={() => setParams({ tab: "reservations" })} className="mb-4 block w-full rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-left text-sm">
          <div className="font-semibold text-blue-900">{t("res.vehicle_reserved", { count: planned.length })}</div>
          <div className="text-blue-800">
            {planned[0].borrower_name} · {fmtDateTime(planned[0].starts_at, lang)} → {fmtDateTime(planned[0].ends_at, lang)}
          </div>
        </button>
      )}

      {primaryActions.length > 0 && (
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          {primaryActions.map((a) => (
            <Link key={a.to} to={a.to} className={cx("rounded-2xl px-4 py-3 text-white shadow-sm active:opacity-90", a.tone)}>
              <div className="text-base font-semibold">{a.label}</div>
              <div className="text-xs opacity-90">{a.desc}</div>
            </Link>
          ))}
        </div>
      )}

      {secondaryActions.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {secondaryActions.map((a) =>
            a.to ? (
              <Link key={a.label} to={a.to} className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700">
                {a.label}
              </Link>
            ) : (
              <button key={a.label} type="button" onClick={a.onClick} className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700">
                {a.label}
              </button>
            ),
          )}
        </div>
      )}

      <div className="-mx-4 mb-4 flex gap-1 overflow-x-auto border-b border-slate-200 px-4 lg:mx-0 lg:px-0">
        {tabs.map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setParams({ tab: tb.key }, { replace: true })}
            className={cx("shrink-0 border-b-2 px-3 py-2 text-sm font-medium", tab === tb.key ? "border-blue-600 text-blue-700" : "border-transparent text-slate-500")}
          >
            {tb.label}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview v={v} />}
      {tab === "history" && <History id={v.id} />}
      {tab === "damages" && <Damages id={v.id} canResolve={cap.resolve_damage} onResolve={setResolveDamage} />}
      {tab === "photos" && <Photos id={v.id} />}
      {tab === "loans" && <Loans id={v.id} />}
      {tab === "reservations" && <VehicleReservations vehicleId={v.id} canReserve={cap.reserve} />}

      <QrModal v={v} open={qrOpen} onClose={() => setQrOpen(false)} />
      <ReportDamageModal v={v} open={damageOpen} onClose={() => setDamageOpen(false)} />
      <ResolveDamageModal v={v} damage={resolveDamage} onClose={() => setResolveDamage(null)} />
      <ArchiveModal v={v} open={archiveOpen} onClose={() => setArchiveOpen(false)} />
      <ReturnDueModal v={v} open={dueOpen} onClose={() => setDueOpen(false)} />
      <ReserveModal open={reserveOpen} onClose={() => setReserveOpen(false)} vehicle={v} />
    </div>
  );
}

function Overview({ v }: { v: Vehicle }) {
  const { t, lang } = useT();
  return (
    <Card title={t("vehicle.master_data")}>
      <KeyValue
        items={[
          [t("vehicle.internal_number"), <span className="font-mono">{v.internal_number}</span>],
          [t("vehicle.qr"), <span className="font-mono">{v.qr_code}</span>],
          [t("vehicle.category"), v.category_name],
          [t("vehicle.manufacturer"), v.manufacturer],
          [t("vehicle.model"), v.model],
          [t("vehicle.serial_number"), v.serial_number || "–"],
          [t("vehicle.license_plate"), v.license_plate || "–"],
          [t("vehicle.location"), v.location || "–"],
          [t("vehicle.supplier"), v.supplier_name || "–"],
          [t("vehicle.external_key"), v.external_key || "–"],
          [t("vehicle.odometer"), v.meter_mode === "odometer" || v.meter_mode === "both" ? fmtNum(v.odometer_km, lang, "km") : "–"],
          [t("vehicle.hours"), v.meter_mode === "hours" || v.meter_mode === "both" ? fmtNum(v.operating_hours, lang, "h") : "–"],
          [t("vehicle.expected_arrival"), fmtDate(v.expected_arrival, lang)],
          [t("vehicle.return_due"), fmtDate(v.return_due, lang)],
          [t("vehicle.created"), fmtDateTime(v.created_at, lang)],
          [t("vehicle.updated"), fmtDateTime(v.updated_at, lang)],
          ...(v.archived_at ? ([[t("vehicle.archived_at"), `${fmtDateTime(v.archived_at, lang)} ${v.archive_reason ? `(${v.archive_reason})` : ""}`]] as [string, React.ReactNode][]) : []),
        ]}
      />
      {v.notes && <p className="mt-4 whitespace-pre-wrap rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{v.notes}</p>}
    </Card>
  );
}

interface TimelineItem {
  kind: "protocol" | "audit";
  at: string;
  protocol?: Protocol;
  audit?: AuditEntry;
}

function History({ id }: { id: string }) {
  const { t, lang } = useT();
  const q = useQuery<{ items: TimelineItem[] }>({ queryKey: ["vehicle-timeline", id], queryFn: () => api.get(`/api/vehicles/${id}/timeline`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const items = q.data?.items ?? [];
  if (!items.length) return <EmptyState text={t("vehicle.no_history")} />;
  return (
    <ol className="relative space-y-3 border-l-2 border-slate-200 pl-4">
      {items.map((it, i) => (
        <li key={i} className="relative">
          <span className={cx("absolute -left-[23px] top-3 h-3 w-3 rounded-full border-2 border-white", it.kind === "protocol" ? "bg-blue-600" : "bg-slate-400")} />
          {it.kind === "protocol" && it.protocol ? (
            <ProtocolCard p={it.protocol} hideVehicle />
          ) : (
            <div className="rounded-xl bg-white px-3 py-2 text-sm shadow-sm">
              <div className="flex justify-between gap-2">
                <span className="text-slate-700">
                  <span className="font-medium">{it.audit?.actor_label}</span> · {it.audit?.action}
                </span>
                <span className="shrink-0 text-xs text-slate-400">{fmtDateTime(it.at, lang)}</span>
              </div>
              {!!it.audit?.details?.changes && <pre className="mt-1 overflow-x-auto text-xs text-slate-500">{JSON.stringify(it.audit.details.changes)}</pre>}
              {typeof it.audit?.details?.description === "string" && <p className="mt-1 text-xs text-slate-600">{it.audit.details.description}</p>}
              {typeof it.audit?.details?.reason === "string" && <p className="mt-1 text-xs text-slate-600">{it.audit.details.reason}</p>}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function Damages({ id, canResolve, onResolve }: { id: string; canResolve: boolean; onResolve: (d: Damage) => void }) {
  const { t, lang } = useT();
  const q = useQuery<{ results: Damage[] }>({ queryKey: ["vehicle-damages", id], queryFn: () => api.get(`/api/vehicles/${id}/damages`) });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const list = q.data?.results ?? [];
  if (!list.length) return <EmptyState text={t("vehicle.no_open_damages")} />;
  return (
    <div className="space-y-2">
      {list.map((d) => (
        <div key={d.id} className={cx("rounded-2xl border bg-white p-4 shadow-sm", d.resolved_at ? "border-slate-200 opacity-70" : "border-red-200")}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <Badge tone={d.severity === "critical" ? "red" : d.severity === "major" ? "amber" : "slate"}>{t(`severity.${d.severity}`)}</Badge>
                {d.resolved_at && <Badge tone="green">✓ {fmtDate(d.resolved_at, lang)}</Badge>}
              </div>
              <p className="mt-1 text-sm text-slate-900">{d.description}</p>
              <p className="text-xs text-slate-500">
                {fmtDateTime(d.reported_at, lang)} · {d.reported_by_name}
              </p>
              {d.resolution_notes && <p className="mt-1 text-xs text-slate-600">→ {d.resolution_notes}</p>}
            </div>
            {!d.resolved_at && canResolve && (
              <Button size="sm" variant="secondary" onClick={() => onResolve(d)}>
                {t("action.resolve_damage")}
              </Button>
            )}
          </div>
          {!!d.photos?.length && (
            <div className="mt-2 flex gap-2 overflow-x-auto">
              {d.photos.map((p) => (
                <a key={p.id} href={p.url} target="_blank" rel="noreferrer">
                  <img src={p.url} alt="" className="h-20 w-20 rounded-lg object-cover" loading="lazy" />
                </a>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Photos({ id }: { id: string }) {
  const { t, lang } = useT();
  const q = useQuery<{ photos: MediaItem[] }>({ queryKey: ["vehicle-timeline", id], queryFn: () => api.get(`/api/vehicles/${id}/timeline`) });
  if (q.isLoading) return <Loading />;
  const photos = q.data?.photos ?? [];
  if (!photos.length) return <EmptyState text={t("vehicle.no_photos")} />;
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
      {photos.map((p) => (
        <a key={p.id} href={p.url} target="_blank" rel="noreferrer" className="group relative aspect-square overflow-hidden rounded-xl bg-slate-100">
          <img src={p.url} alt={p.caption} className="h-full w-full object-cover" loading="lazy" />
          <span className="absolute inset-x-0 bottom-0 bg-slate-900/60 px-1 py-0.5 text-[10px] text-white">{fmtDate(p.created_at, lang)}</span>
        </a>
      ))}
    </div>
  );
}

function Loans({ id }: { id: string }) {
  const { t, lang } = useT();
  const q = useQuery<{ results: Loan[] }>({ queryKey: ["vehicle-loans", id], queryFn: () => api.get(`/api/vehicles/${id}/loans`) });
  if (q.isLoading) return <Loading />;
  const list = q.data?.results ?? [];
  if (!list.length) return <EmptyState text={t("vehicle.no_loans")} />;
  return (
    <div className="space-y-2">
      {list.map((l) => (
        <div key={l.id} className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-900">
              {l.borrower_name}
              {l.company_name ? ` · ${l.company_name}` : ""}
            </span>
            <Badge tone={l.status === "active" ? (l.overdue ? "red" : "amber") : l.status === "returned" ? "green" : "slate"}>{l.status === "active" ? t("loans.active") : l.status === "returned" ? t("loans.returned") : t("loans.cancelled")}</Badge>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {fmtDateTime(l.checked_out_at, lang)} → {l.actual_return_at ? fmtDateTime(l.actual_return_at, lang) : `${t("vehicle.expected_return")} ${fmtDateTime(l.expected_return_at, lang)}`}
          </div>
          <div className="mt-1 flex gap-3 text-xs">
            {l.checkout_protocol_id && (
              <Link to={`/documents/${l.checkout_protocol_id}`} className="text-blue-700 hover:underline">
                {t("protocol.loan_checkout")} →
              </Link>
            )}
            {l.return_protocol_id && (
              <Link to={`/documents/${l.return_protocol_id}`} className="text-blue-700 hover:underline">
                {t("protocol.loan_return")} →
              </Link>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function QrModal({ v, open, onClose }: { v: Vehicle; open: boolean; onClose: () => void }) {
  const { t } = useT();
  const { me } = useAuth();
  const url = `${me?.settings.public_base_url || window.location.origin}/q/${v.qr_code}`;
  return (
    <Modal open={open} onClose={onClose} title={t("vehicle.qr")}>
      <div className="print-area flex flex-col items-center gap-3 text-center">
        <img src={`/api/vehicles/${v.id}/qr.svg`} alt="QR" className="h-56 w-56" />
        <div className="font-mono text-2xl font-bold">{v.internal_number}</div>
        <div className="text-sm text-slate-700">
          {v.manufacturer} {v.model}
          {v.license_plate ? ` · ${v.license_plate}` : ""}
        </div>
        <div className="font-mono text-xs text-slate-500">{v.qr_code}</div>
        <div className="break-all text-xs text-slate-400">{url}</div>
      </div>
      <div className="mt-4 flex gap-2 print:hidden">
        <Button variant="secondary" className="flex-1" onClick={() => navigator.clipboard?.writeText(url)}>
          {t("common.copy")}
        </Button>
        <Button className="flex-1" onClick={() => window.print()}>
          {t("vehicle.qr_print")}
        </Button>
      </div>
    </Modal>
  );
}

function ReportDamageModal({ v, open, onClose }: { v: Vehicle; open: boolean; onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Severity>("minor");
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [mark, setMark] = useState(true);
  const m = useMutation({
    mutationFn: () => api.post(`/api/vehicles/${v.id}/damages`, { description, severity, photo_ids: photos.map((p) => p.id), mark_vehicle_damaged: mark }),
    onSuccess: () => {
      invalidateVehicle(qc, v.id);
      toast.push(t("common.saved"));
      setDescription("");
      setPhotos([]);
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("action.report_damage")}
      footer={
        <Button className="w-full" onClick={() => m.mutate()} loading={m.isPending} disabled={!description.trim()}>
          {t("common.save")}
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label={t("wf.damage_description")} required>
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} autoFocus />
        </Field>
        <Field label={t("wf.damage_severity")}>
          <Select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
            <option value="minor">{t("severity.minor")}</option>
            <option value="major">{t("severity.major")}</option>
            <option value="critical">{t("severity.critical")}</option>
          </Select>
        </Field>
        <PhotoCapture photos={photos} onChange={setPhotos} max={6} />
        {v.status === "available" && <Toggle checked={mark} onChange={setMark} label={t("wf.mark_damaged")} />}
      </div>
    </Modal>
  );
}

function ResolveDamageModal({ v, damage, onClose }: { v: Vehicle; damage: Damage | null; onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const m = useMutation({
    mutationFn: () => api.post(`/api/vehicles/${v.id}/damages/${damage!.id}/resolve`, { resolution_notes: notes, photo_ids: photos.map((p) => p.id) }),
    onSuccess: () => {
      invalidateVehicle(qc, v.id);
      toast.push(t("common.saved"));
      setNotes("");
      setPhotos([]);
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });
  return (
    <Modal
      open={!!damage}
      onClose={onClose}
      title={t("action.resolve_damage")}
      footer={
        <Button className="w-full" variant="success" onClick={() => m.mutate()} loading={m.isPending}>
          {t("common.confirm")}
        </Button>
      }
    >
      {damage && (
        <div className="space-y-3">
          <p className="rounded-xl bg-slate-50 p-3 text-sm text-slate-700">{damage.description}</p>
          <Field label={t("wf.resolution_notes")}>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <PhotoCapture photos={photos} onChange={setPhotos} max={6} />
        </div>
      )}
    </Modal>
  );
}

function ArchiveModal({ v, open, onClose }: { v: Vehicle; open: boolean; onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/api/vehicles/${v.id}/archive`, { reason }),
    onSuccess: () => {
      invalidateVehicle(qc, v.id);
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });
  return (
    <Modal open={open} onClose={onClose} title={t("action.archive")} footer={<Button className="w-full" onClick={() => m.mutate()} loading={m.isPending}>{t("common.confirm")}</Button>}>
      <Field label={t("wf.reason")}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ReturnDueModal({ v, open, onClose }: { v: Vehicle; open: boolean; onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [date, setDate] = useState(v.return_due ?? "");
  const m = useMutation({
    mutationFn: () => api.post(`/api/vehicles/${v.id}/return-due`, { return_due: date || null }),
    onSuccess: () => {
      invalidateVehicle(qc, v.id);
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });
  return (
    <Modal open={open} onClose={onClose} title={t("action.set_return_due")} footer={<Button className="w-full" onClick={() => m.mutate()} loading={m.isPending}>{t("common.save")}</Button>}>
      <Field label={t("vehicle.return_due")}>
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
    </Modal>
  );
}
