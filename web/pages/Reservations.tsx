import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Company, Driver, Paginated, Reservation, VehicleSummary } from "@shared/types";
import { api, qs } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { fmtDateTime, fromLocalInputDateTime, toLocalInputDateTime } from "../lib/format";
import { useDebouncedParam } from "../lib/hooks";
import { Badge, Button, EmptyState, ErrorBox, Field, Input, Loading, Modal, PageHeader, Pagination, SegmentedControl, Select, StatusBadge, Textarea, errorMessage, useToast } from "../components/ui";

type Scope = "upcoming" | "all";

const TONES: Record<Reservation["status"], "blue" | "green" | "slate" | "amber"> = {
  planned: "blue",
  fulfilled: "green",
  cancelled: "slate",
  expired: "amber",
};

export function useVehicleReservations(vehicleId: string | undefined, onlyPlanned = true) {
  return useQuery<{ results: Reservation[] }>({
    queryKey: ["vehicle-reservations", vehicleId, onlyPlanned],
    queryFn: () => api.get(`/api/vehicles/${vehicleId}/reservations${onlyPlanned ? "?scope=planned" : ""}`),
    enabled: !!vehicleId,
  });
}

export function invalidateReservations(qc: ReturnType<typeof useQueryClient>, vehicleId?: string) {
  qc.invalidateQueries({ queryKey: ["reservations"] });
  qc.invalidateQueries({ queryKey: ["vehicle-reservations", vehicleId] });
  qc.invalidateQueries({ queryKey: ["dashboard"] });
}

/** Default window: tomorrow morning to tomorrow evening — the usual "next week, two days" case starts from here. */
function defaultWindow(): { from: string; to: string } {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(7, 0, 0, 0);
  const end = new Date(start);
  end.setHours(17, 0, 0, 0);
  return { from: toLocalInputDateTime(start.toISOString()), to: toLocalInputDateTime(end.toISOString()) };
}

export function ReservationCard({ r, hideVehicle, onCancel }: { r: Reservation; hideVehicle?: boolean; onCancel?: (r: Reservation) => void }) {
  const { t, lang } = useT();
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {!hideVehicle && r.vehicle && (
            <Link to={`/vehicles/${r.vehicle.id}`} className="flex items-center gap-2 text-sm">
              <span className="font-mono font-semibold">{r.vehicle.internal_number}</span>
              <span className="truncate text-slate-700">
                {r.vehicle.manufacturer} {r.vehicle.model}
              </span>
              <StatusBadge status={r.vehicle.status} />
            </Link>
          )}
          <div className="text-sm font-medium text-slate-900">
            {r.borrower_name}
            {r.company_name ? ` · ${r.company_name}` : ""}
          </div>
          <div className="text-xs text-slate-600">
            {fmtDateTime(r.starts_at, lang)} → {fmtDateTime(r.ends_at, lang)}
          </div>
          {r.notes && <p className="mt-1 whitespace-pre-wrap text-xs text-slate-500">{r.notes}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={TONES[r.status]}>{t(`res.status.${r.status}`)}</Badge>
          {r.due && <Badge tone="amber">{t("res.due_now")}</Badge>}
        </div>
      </div>
      {r.status === "planned" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Link to={`/vehicles/${r.vehicle_id}/loan?reservation=${r.id}`} className="inline-flex items-center rounded-full bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white">
            {t("res.loan_now")}
          </Link>
          {onCancel && (
            <Button size="sm" variant="secondary" onClick={() => onCancel(r)}>
              {t("res.cancel")}
            </Button>
          )}
        </div>
      )}
      {r.status === "cancelled" && r.close_reason && <p className="mt-1 text-xs text-slate-500">{r.close_reason}</p>}
    </div>
  );
}

function VehiclePicker({ value, onChange }: { value: VehicleSummary | null; onChange: (v: VehicleSummary | null) => void }) {
  const { t } = useT();
  const [term, setTerm] = useState("");
  const q = useQuery<Paginated<VehicleSummary>>({
    queryKey: ["vehicles", "picker", term],
    queryFn: () => api.get(`/api/vehicles${qs({ q: term, page_size: 20 })}`),
    enabled: !value,
  });
  if (value) {
    return (
      <Field label={t("res.vehicle")} required>
        <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2">
          <span className="min-w-0 truncate text-sm">
            <span className="font-mono font-semibold">{value.internal_number}</span> {value.manufacturer} {value.model}
          </span>
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            {t("common.edit")}
          </Button>
        </div>
      </Field>
    );
  }
  const list = (q.data?.results ?? []).filter((v) => v.status !== "checked_out" && v.status !== "archived");
  return (
    <Field label={t("res.vehicle")} required>
      <Input type="search" placeholder={t("res.vehicle_pick")} value={term} onChange={(e) => setTerm(e.target.value)} />
      <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">
        {q.isLoading && <Loading />}
        {list.map((v) => (
          <button key={v.id} type="button" onClick={() => onChange(v)} className="flex w-full items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50">
            <span className="font-mono font-semibold">{v.internal_number}</span>
            <span className="min-w-0 flex-1 truncate">
              {v.manufacturer} {v.model}
            </span>
            <StatusBadge status={v.status} />
          </button>
        ))}
      </div>
    </Field>
  );
}

export function ReserveModal({ open, onClose, vehicle }: { open: boolean; onClose: () => void; vehicle?: VehicleSummary }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [picked, setPicked] = useState<VehicleSummary | null>(vehicle ?? null);
  const [companyId, setCompanyId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [period, setPeriod] = useState(defaultWindow);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const companies = useQuery<{ results: Company[] }>({ queryKey: ["companies", "borrowers"], queryFn: () => api.get("/api/companies"), enabled: open });
  const drivers = useQuery<{ results: Driver[] }>({ queryKey: ["drivers"], queryFn: () => api.get("/api/drivers"), enabled: open });
  const borrowerCompanies = companies.data?.results.filter((c) => c.company_type !== "supplier") ?? [];
  const driverList = (drivers.data?.results ?? []).filter((d) => !companyId || d.company_id === companyId || !d.company_id);
  const target = vehicle ?? picked;

  const m = useMutation({
    mutationFn: () =>
      api.post<Reservation>("/api/reservations", {
        vehicle_id: target!.id,
        company_id: companyId || null,
        driver_id: driverId || null,
        borrower_name: name,
        borrower_phone: phone,
        borrower_email: email,
        starts_at: fromLocalInputDateTime(period.from),
        ends_at: fromLocalInputDateTime(period.to),
        notes,
      }),
    onSuccess: () => {
      invalidateReservations(qc, target!.id);
      toast.push(t("res.created"));
      setName("");
      setPhone("");
      setEmail("");
      setNotes("");
      setPeriod(defaultWindow());
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });

  function pickDriver(did: string) {
    setDriverId(did);
    const d = drivers.data?.results.find((x) => x.id === did);
    if (d) {
      setName(d.name);
      setPhone(d.phone);
      setEmail(d.email);
      if (d.company_id) setCompanyId(d.company_id);
    }
  }

  function submit() {
    setError(null);
    if (!target) return setError(t("res.vehicle_pick"));
    if (!name.trim()) return setError(`${t("wf.borrower_name")}: ${t("common.required")}`);
    if (!period.from || !period.to) return setError(t("res.period"));
    if (new Date(period.to) <= new Date(period.from)) return setError(t("res.end_before_start"));
    m.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("res.new")}
      footer={
        <Button className="w-full" onClick={submit} loading={m.isPending}>
          {t("common.save")}
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">{t("res.hint")}</p>
        {!vehicle && <VehiclePicker value={picked} onChange={setPicked} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("res.from")} required>
            <Input type="datetime-local" value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
          </Field>
          <Field label={t("res.to")} required>
            <Input type="datetime-local" value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
          </Field>
          <Field label={t("wf.borrower_company")}>
            <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">{t("wf.no_company")}</option>
              {borrowerCompanies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({t(`company.${c.company_type}`)})
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("wf.borrower_driver")}>
            <Select value={driverId} onChange={(e) => pickDriver(e.target.value)}>
              <option value="">–</option>
              {driverList.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.company_name ? ` · ${d.company_name}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("wf.borrower_name")} required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </Field>
          <Field label={t("common.phone")}>
            <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label={t("common.email")} className="sm:col-span-2">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <Field label={t("common.notes")}>
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      </div>
    </Modal>
  );
}

export function CancelReservationModal({ reservation, onClose }: { reservation: Reservation | null; onClose: () => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.post(`/api/reservations/${reservation!.id}/cancel`, { reason }),
    onSuccess: () => {
      invalidateReservations(qc, reservation!.vehicle_id);
      toast.push(t("res.cancelled"));
      setReason("");
      onClose();
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });
  return (
    <Modal
      open={!!reservation}
      onClose={onClose}
      title={t("res.cancel")}
      footer={
        <Button className="w-full" variant="danger" onClick={() => m.mutate()} loading={m.isPending}>
          {t("common.confirm")}
        </Button>
      }
    >
      <Field label={t("res.cancel_reason")}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

export function ReservationsPage() {
  const { t } = useT();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const scope = (params.get("scope") as Scope) || "upcoming";
  const page = Number(params.get("page") ?? 1);
  const term = params.get("q") ?? "";
  const [q, setQ] = useDebouncedParam("q");
  const [createOpen, setCreateOpen] = useState(false);
  const [cancelling, setCancelling] = useState<Reservation | null>(null);
  // The search runs on the server, otherwise a match on another page would look like it does not exist.
  const query = useQuery<Paginated<Reservation>>({
    queryKey: ["reservations", scope, page, term],
    queryFn: () => api.get(`/api/reservations${qs({ scope, page, q: term })}`),
    placeholderData: (prev) => prev,
  });
  const results = query.data?.results ?? [];

  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  };

  return (
    <div>
      <PageHeader
        title={t("res.title")}
        subtitle={query.data ? t("common.results", { count: query.data.count }) : undefined}
        action={<Button size="sm" onClick={() => setCreateOpen(true)}>+ {t("res.new")}</Button>}
      />
      <div className="space-y-3">
        <SegmentedControl<Scope>
          value={scope}
          onChange={(v) => set("scope", v)}
          options={[
            { value: "upcoming", label: t("res.upcoming") },
            { value: "all", label: t("res.all") },
          ]}
        />
        <Input type="search" placeholder={t("common.search")} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="mt-4">
        {query.isLoading ? (
          <Loading />
        ) : query.error ? (
          <ErrorBox error={query.error} onRetry={() => query.refetch()} />
        ) : !results.length ? (
          <EmptyState text={t("res.empty")} action={<Button size="sm" onClick={() => setCreateOpen(true)}>+ {t("res.new")}</Button>} />
        ) : (
          <div className="space-y-2">
            {results.map((r) => (
              <ReservationCard key={r.id} r={r} onCancel={can("user") ? setCancelling : undefined} />
            ))}
          </div>
        )}
        {query.data && <Pagination page={query.data.page} pageSize={query.data.page_size} count={query.data.count} onPage={(p) => set("page", String(p))} />}
      </div>

      <ReserveModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <CancelReservationModal reservation={cancelling} onClose={() => setCancelling(null)} />
    </div>
  );
}

/** Planned reservations of one vehicle, shown on its detail page. */
export function VehicleReservations({ vehicleId, canReserve }: { vehicleId: string; canReserve: boolean }) {
  const { t } = useT();
  const [cancelling, setCancelling] = useState<Reservation | null>(null);
  const q = useVehicleReservations(vehicleId, false);
  const list = q.data?.results ?? [];
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  return (
    <>
      {!list.length ? (
        <EmptyState text={t("res.empty_vehicle")} />
      ) : (
        <div className="space-y-2">
          {list.map((r) => (
            <ReservationCard key={r.id} r={r} hideVehicle onCancel={canReserve ? setCancelling : undefined} />
          ))}
        </div>
      )}
      <CancelReservationModal reservation={cancelling} onClose={() => setCancelling(null)} />
    </>
  );
}