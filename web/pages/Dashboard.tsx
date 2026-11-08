import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { DashboardSummary, Loan } from "@shared/types";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { fmtDate, fmtDateTime, fmtRelative } from "../lib/format";
import { Card, EmptyState, ErrorBox, Loading, PageHeader, cx } from "../components/ui";
import { VehicleCard } from "../components/VehicleCard";
import { ReservationCard } from "./Reservations";

function Stat({ label, value, to, tone }: { label: string; value: number; to: string; tone?: "red" | "amber" | "green" | "blue" | "slate" }) {
  const tones = {
    red: "bg-red-50 text-red-800 border-red-100",
    amber: "bg-amber-50 text-amber-800 border-amber-100",
    green: "bg-emerald-50 text-emerald-800 border-emerald-100",
    blue: "bg-sky-50 text-sky-800 border-sky-100",
    slate: "bg-white text-slate-900 border-slate-200",
  };
  return (
    <Link to={to} className={cx("rounded-2xl border px-4 py-3 shadow-sm", tones[tone ?? "slate"])}>
      <div className="text-2xl font-bold leading-tight">{value}</div>
      <div className="text-xs font-medium opacity-80">{label}</div>
    </Link>
  );
}

export function LoanRow({ loan }: { loan: Loan }) {
  const { t, lang } = useT();
  const v = loan.vehicle!;
  return (
    <Link to={`/vehicles/${v.id}`} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono font-semibold">{v.internal_number}</span>
          <span className="truncate text-slate-700">
            {v.manufacturer} {v.model}
          </span>
        </div>
        <div className="truncate text-xs text-slate-500">
          {loan.borrower_name}
          {loan.company_name ? ` · ${loan.company_name}` : ""}
        </div>
      </div>
      <div className={cx("text-right text-xs", loan.overdue ? "font-semibold text-red-600" : "text-slate-600")}>
        <div>{loan.overdue ? t("common.overdue") : t("common.due")}</div>
        <div>{fmtDateTime(loan.expected_return_at, lang)}</div>
      </div>
    </Link>
  );
}

export function DashboardPage() {
  const { t, lang } = useT();
  const { me } = useAuth();
  const q = useQuery<DashboardSummary>({ queryKey: ["dashboard"], queryFn: () => api.get("/api/dashboard/summary"), refetchInterval: 60_000 });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const nothingToDo = !d.overdue.length && !d.due_soon.length && !d.attention.length && !d.arrivals.length && !d.return_due.length && !d.reservations.length;

  return (
    <div className="space-y-5">
      <PageHeader title={t("dash.title")} subtitle={me?.settings.org_name} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={t("dash.fleet")} value={d.fleet} to="/vehicles" />
        <Stat label={t("dash.available")} value={d.counts.available} to="/vehicles?status=available" tone="green" />
        <Stat label={t("dash.loaned")} value={d.counts.loaned} to="/loans" tone="amber" />
        <Stat label={t("dash.overdue")} value={d.overdue_loans} to="/loans" tone={d.overdue_loans ? "red" : "slate"} />
        <Stat label={t("dash.attention")} value={d.counts.damaged + d.counts.maintenance} to="/vehicles?status=damaged,maintenance" tone={d.counts.damaged + d.counts.maintenance ? "red" : "slate"} />
      </div>

      <Link to="/scan" className="flex items-center gap-4 rounded-2xl bg-blue-600 px-5 py-4 text-white shadow-md active:bg-blue-700 lg:hidden">
        <svg className="h-8 w-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10" />
        </svg>
        <div>
          <div className="text-base font-semibold">{t("nav.scan")}</div>
          <div className="text-xs opacity-90">{t("dash.scan_hint")}</div>
        </div>
      </Link>

      {d.failed_pdfs > 0 && (
        <Link to="/documents?pdf_status=failed" className="block rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
          {t("dash.failed_pdfs", { count: d.failed_pdfs })}
        </Link>
      )}

      {nothingToDo && <EmptyState text={t("dash.all_good")} />}

      {d.overdue.length > 0 && (
        <Section title={t("dash.overdue_loans")} count={d.overdue.length} to="/loans">
          {d.overdue.map((l) => (
            <LoanRow key={l.id} loan={l} />
          ))}
        </Section>
      )}
      {d.due_soon.length > 0 && (
        <Section title={t("dash.due_soon")} count={d.due_soon.length} to="/loans">
          {d.due_soon.map((l) => (
            <LoanRow key={l.id} loan={l} />
          ))}
        </Section>
      )}
      {d.arrivals.length > 0 && (
        <Section title={t("dash.arrivals")} count={d.counts.announced} to="/vehicles?status=announced">
          {d.arrivals.map((v) => (
            <VehicleCard key={v.id} v={v} meta={v.expected_arrival ? fmtDate(v.expected_arrival, lang) : undefined} />
          ))}
        </Section>
      )}
      {d.attention.length > 0 && (
        <Section title={t("dash.needs_attention")} count={d.attention.length} to="/vehicles?status=damaged,maintenance">
          {d.attention.map((v) => (
            <VehicleCard key={v.id} v={v} />
          ))}
        </Section>
      )}
      {d.reservations.length > 0 && (
        <Section title={t("res.title")} count={d.reservations.length} to="/reservations">
          {d.reservations.map((r) => (
            <ReservationCard key={r.id} r={r} />
          ))}
        </Section>
      )}
      {d.return_due.length > 0 && (
        <Section title={t("dash.return_due")} count={d.return_due.length} to="/vehicles">
          {d.return_due.map((v) => (
            <VehicleCard key={v.id} v={v} meta={v.return_due ? fmtDate(v.return_due, lang) : undefined} />
          ))}
        </Section>
      )}

      <Card title={t("dash.recent")}>
        {d.recent.length === 0 ? (
          <p className="text-sm text-slate-500">{t("common.empty")}</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {d.recent.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <span className="font-medium text-slate-800">{a.actor_label}</span> <span className="text-slate-500">{a.action}</span>
                  {a.vehicle_id && (
                    <Link to={`/vehicles/${a.vehicle_id}`} className="ml-2 text-blue-700 hover:underline">
                      {(a.details?.internal_number as string) ?? (a.details?.number as string) ?? "→"}
                    </Link>
                  )}
                </div>
                <span className="shrink-0 text-xs text-slate-400">{fmtRelative(a.created_at, lang)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Section({ title, count, to, children }: { title: string; count: number; to: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          {title} <span className="ml-1 rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-700">{count}</span>
        </h2>
        <Link to={to} className="text-sm text-blue-700 hover:underline">
          →
        </Link>
      </div>
      <div className="space-y-2">{children}</div>
    </section>
  );
}
