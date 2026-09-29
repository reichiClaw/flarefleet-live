import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Paginated, Protocol, ProtocolType } from "@shared/types";
import { api, qs } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { useDebouncedParam } from "../lib/hooks";
import { fmtDateTime, fmtNum } from "../lib/format";
import { Badge, Button, Card, EmptyState, ErrorBox, Input, KeyValue, Loading, PageHeader, Pagination, Select, StatusBadge, cx, errorMessage, useToast } from "../components/ui";

const TYPES: ProtocolType[] = ["check_in", "loan_checkout", "loan_return", "check_out", "maintenance_start", "maintenance_end", "damage_resolved", "status_correction"];

const TYPE_TONE: Record<ProtocolType, string> = {
  check_in: "bg-sky-100 text-sky-800",
  loan_checkout: "bg-amber-100 text-amber-800",
  loan_return: "bg-emerald-100 text-emerald-800",
  check_out: "bg-slate-200 text-slate-800",
  maintenance_start: "bg-violet-100 text-violet-800",
  maintenance_end: "bg-violet-100 text-violet-800",
  damage_resolved: "bg-emerald-100 text-emerald-800",
  status_correction: "bg-red-100 text-red-800",
};

export function ProtocolCard({ p, hideVehicle }: { p: Protocol; hideVehicle?: boolean }) {
  const { t, lang } = useT();
  return (
    <Link to={`/documents/${p.id}`} className="block rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className={cx("rounded-full px-2.5 py-0.5 text-xs font-semibold", TYPE_TONE[p.type])}>{t(`protocol.${p.type}`)}</span>
        <span className="font-mono text-xs text-slate-500">{p.number}</span>
      </div>
      {!hideVehicle && p.vehicle && (
        <div className="mt-1 text-sm text-slate-900">
          <span className="font-mono font-semibold">{p.vehicle.internal_number}</span> · {p.vehicle.manufacturer} {p.vehicle.model}
        </div>
      )}
      <div className="mt-1 flex items-center justify-between text-xs text-slate-500">
        <span>
          {fmtDateTime(p.performed_at, lang)} · {p.performed_by_name}
        </span>
        {p.pdf_status === "pending" && <Badge tone="amber">{t("docs.pdf_pending")}</Badge>}
        {p.pdf_status === "failed" && <Badge tone="red">{t("docs.pdf_failed")}</Badge>}
      </div>
      {p.notes && <p className="mt-1 line-clamp-2 text-xs text-slate-600">{p.notes}</p>}
    </Link>
  );
}

export function DocumentsPage() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const type = params.get("type") ?? "";
  const pdfStatus = params.get("pdf_status") ?? "";
  const q = params.get("q") ?? "";
  const [search, setSearch] = useDebouncedParam("q");
  const page = Number(params.get("page") ?? 1);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  const query = useQuery<Paginated<Protocol>>({
    queryKey: ["protocols", params.toString()],
    queryFn: () => api.get(`/api/protocols${qs({ type, pdf_status: pdfStatus, q, page })}`),
    placeholderData: (prev) => prev,
  });

  return (
    <div>
      <PageHeader title={t("docs.title")} subtitle={query.data ? t("common.results", { count: query.data.count }) : undefined} />
      {/* The controls carry w-full, so the row sizes them through wrappers. */}
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <Input type="search" placeholder={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="w-44 shrink-0">
          <Select value={type} onChange={(e) => set("type", e.target.value)}>
            <option value="">{t("docs.filter_type")}: {t("common.all")}</option>
            {TYPES.map((tp) => (
              <option key={tp} value={tp}>
                {t(`protocol.${tp}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="mt-4">
        {query.isLoading ? (
          <Loading />
        ) : query.error ? (
          <ErrorBox error={query.error} onRetry={() => query.refetch()} />
        ) : !query.data?.results.length ? (
          <EmptyState text={t("docs.empty")} />
        ) : (
          <div className="space-y-2">
            {query.data.results.map((p) => (
              <ProtocolCard key={p.id} p={p} />
            ))}
          </div>
        )}
        {query.data && <Pagination page={query.data.page} pageSize={query.data.page_size} count={query.data.count} onPage={(p) => set("page", String(p))} />}
      </div>
    </div>
  );
}

export function ProtocolDetailPage() {
  const { t, lang } = useT();
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery<Protocol & { damages: { id: string; description: string; severity: string }[] }>({
    queryKey: ["protocol", id],
    queryFn: () => api.get(`/api/protocols/${id}`),
    refetchInterval: (query) => (query.state.data?.pdf_status === "pending" ? 4000 : false),
  });
  const regen = useMutation({
    mutationFn: () => api.post(`/api/protocols/${id}/regenerate-pdf`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["protocol", id] }),
    onError: (e) => toast.push(errorMessage(e), "error"),
  });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const p = q.data;
  const snap = p.snapshot;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className={cx("rounded-full px-2.5 py-0.5 text-sm font-semibold", TYPE_TONE[p.type])}>{t(`protocol.${p.type}`)}</span>
            <span className="font-mono text-base">{p.number}</span>
          </span>
        }
        subtitle={`${fmtDateTime(p.performed_at, lang)} · ${p.performed_by_name}`}
        back={() => nav(-1)}
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {p.pdf_status === "generated" ? (
          <>
            <a href={`/api/protocols/${p.id}/pdf`} target="_blank" rel="noreferrer">
              <Button>{t("docs.open_pdf")}</Button>
            </a>
            <a href={`/api/protocols/${p.id}/pdf?download=1`}>
              <Button variant="secondary">{t("common.download")}</Button>
            </a>
          </>
        ) : p.pdf_status === "failed" ? (
          <>
            <Badge tone="red">{t("docs.pdf_failed")}</Badge>
            {can("admin") && (
              <Button size="sm" variant="secondary" onClick={() => regen.mutate()} loading={regen.isPending}>
                {t("docs.regenerate")}
              </Button>
            )}
          </>
        ) : (
          <Badge tone="amber">{t("docs.pdf_pending")}</Badge>
        )}
        {p.vehicle && (
          <Link to={`/vehicles/${p.vehicle_id}`}>
            <Button variant="ghost">
              {p.vehicle.internal_number} →
            </Button>
          </Link>
        )}
      </div>

      <div className="space-y-4">
        {snap && (
          <Card title={t("vehicle.master_data")}>
            <KeyValue
              items={[
                [t("vehicle.internal_number"), <span className="font-mono">{snap.vehicle.internal_number}</span>],
                [t("vehicle.category"), snap.vehicle.category_name],
                [t("vehicle.manufacturer"), `${snap.vehicle.manufacturer} ${snap.vehicle.model}`],
                [t("vehicle.serial_number"), snap.vehicle.serial_number || "–"],
                [t("vehicle.license_plate"), snap.vehicle.license_plate || "–"],
                [t("vehicle.location"), snap.vehicle.location || "–"],
                [
                  t("docs.status_change"),
                  <span className="flex items-center gap-1">
                    {p.status_before && <StatusBadge status={p.status_before} />} → {p.status_after && <StatusBadge status={p.status_after} />}
                  </span>,
                ],
              ]}
            />
          </Card>
        )}

        {snap?.party && (snap.party.name || snap.party.company) && (
          <Card title={t("docs.party")}>
            <KeyValue
              items={[
                [t("common.name"), snap.party.name],
                [t("partners.company"), snap.party.company ?? "–"],
                [t("common.phone"), snap.party.phone ?? "–"],
                [t("common.email"), snap.party.email ?? "–"],
                ...(snap.loan ? ([[t("vehicle.since"), fmtDateTime(snap.loan.checked_out_at, lang)], [t("vehicle.expected_return"), fmtDateTime(snap.loan.expected_return_at, lang)]] as [string, React.ReactNode][]) : []),
                ...(snap.loan?.actual_return_at ? ([[t("loans.returned"), fmtDateTime(snap.loan.actual_return_at, lang)]] as [string, React.ReactNode][]) : []),
              ]}
            />
          </Card>
        )}

        {(p.odometer_km != null || p.operating_hours != null || p.condition) && (
          <Card title={t("wf.readings")}>
            <KeyValue
              items={[
                [t("vehicle.odometer"), fmtNum(p.odometer_km, lang, "km")],
                [t("vehicle.hours"), fmtNum(p.operating_hours, lang, "h")],
                [t("wf.condition"), p.condition ? t(`condition.${p.condition}`) : "–"],
              ]}
            />
          </Card>
        )}

        {!!p.damages?.length && (
          <Card title={t("wf.damages")}>
            <ul className="space-y-1 text-sm">
              {p.damages.map((d) => (
                <li key={d.id}>
                  <Badge tone={d.severity === "critical" ? "red" : d.severity === "major" ? "amber" : "slate"}>{t(`severity.${d.severity}`)}</Badge> {d.description}
                </li>
              ))}
            </ul>
          </Card>
        )}

        {p.notes && (
          <Card title={t("common.notes")}>
            <p className="whitespace-pre-wrap text-sm text-slate-800">{p.notes}</p>
          </Card>
        )}

        {(!!p.photos?.length || p.signature) && (
          <Card title={t("docs.evidence")}>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {p.photos?.map((m) => (
                <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="block">
                  <img src={m.url} alt={m.caption} className="aspect-square w-full rounded-xl object-cover" loading="lazy" />
                  <span className="mt-0.5 block truncate font-mono text-[10px] text-slate-400" title={m.sha256}>
                    {m.sha256.slice(0, 12)}…
                  </span>
                </a>
              ))}
            </div>
            {p.signature && (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-slate-500">{t("wf.signature")}</p>
                <img src={p.signature.url} alt="signature" className="h-28 rounded-xl border border-slate-200 bg-white object-contain" />
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
