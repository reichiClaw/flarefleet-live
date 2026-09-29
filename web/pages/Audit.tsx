import { useSearchParams } from "react-router-dom";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { AuditEntry, Paginated } from "@shared/types";
import { api, qs } from "../lib/api";
import { useT } from "../lib/i18n";
import { useDebouncedParam } from "../lib/hooks";
import { fmtDateTime } from "../lib/format";
import { Button, EmptyState, ErrorBox, Input, Loading, PageHeader, Pagination } from "../components/ui";

export function AuditPage() {
  const { t, lang } = useT();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const action = params.get("action") ?? "";
  const [search, setSearch] = useDebouncedParam("q");
  const [actionFilter, setActionFilter] = useDebouncedParam("action");
  const page = Number(params.get("page") ?? 1);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next, { replace: true });
  };
  const query = useQuery<Paginated<AuditEntry>>({
    queryKey: ["audit", params.toString()],
    queryFn: () => api.get(`/api/audit${qs({ q, action, page })}`),
    placeholderData: (prev) => prev,
  });

  return (
    <div>
      <PageHeader
        title={t("audit.title")}
        subtitle={query.data ? t("common.results", { count: query.data.count }) : undefined}
        action={
          <a href={`/api/audit/export.csv${qs({ q, action })}`}>
            <Button size="sm" variant="secondary">
              {t("audit.export")}
            </Button>
          </a>
        }
      />
      {/* The controls carry w-full, so the row sizes them through wrappers. */}
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <Input type="search" placeholder={t("common.search")} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="w-40 shrink-0">
          <Input placeholder={t("audit.action")} value={actionFilter} onChange={(e) => setActionFilter(e.target.value)} list="audit-actions" />
        </div>
        <datalist id="audit-actions">
          {["auth.", "vehicle.", "loan.", "damage.", "maintenance.", "import.", "user.", "settings.", "protocol.", "company.", "driver.", "category."].map((a) => (
            <option key={a} value={a} />
          ))}
        </datalist>
      </div>
      <div className="mt-4">
        {query.isLoading ? (
          <Loading />
        ) : query.error ? (
          <ErrorBox error={query.error} />
        ) : !query.data?.results.length ? (
          <EmptyState text={t("common.empty")} />
        ) : (
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white text-sm">
            {query.data.results.map((a) => (
              <li key={a.id} className="px-4 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    <span className="font-medium text-slate-900">{a.actor_label}</span> <span className="font-mono text-xs text-blue-700">{a.action}</span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-400">{fmtDateTime(a.created_at, lang)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <span>
                    {a.entity_type}
                    {a.entity_id ? ` ${a.entity_id.slice(0, 8)}` : ""}
                  </span>
                  {a.vehicle_id && (
                    <Link to={`/vehicles/${a.vehicle_id}`} className="text-blue-700 hover:underline">
                      {t("nav.vehicles")} →
                    </Link>
                  )}
                  {a.details && <code className="truncate font-mono text-[11px] text-slate-500">{JSON.stringify(a.details).slice(0, 160)}</code>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {query.data && <Pagination page={query.data.page} pageSize={query.data.page_size} count={query.data.count} onPage={(p) => set("page", String(p))} />}
      </div>
    </div>
  );
}
