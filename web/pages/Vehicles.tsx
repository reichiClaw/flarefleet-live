import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Category, Paginated, VehicleSummary } from "@shared/types";
import { VEHICLE_STATUSES } from "@shared/types";
import { api, qs } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { useDebouncedParam } from "../lib/hooks";
import { Button, EmptyState, ErrorBox, Input, Loading, PageHeader, Pagination, Select, cx } from "../components/ui";
import { VehicleCard } from "../components/VehicleCard";

type Item = VehicleSummary & { location: string; open_damage_count: number; expected_arrival: string | null; return_due: string | null };

export function VehiclesPage() {
  const { t } = useT();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") ?? "";
  const category = params.get("category_id") ?? "";
  const page = Number(params.get("page") ?? 1);
  const archived = params.get("include_archived") === "1";
  const [q, setQ] = useDebouncedParam("q");

  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete("page");
    setParams(next);
  };

  const categories = useQuery<{ results: Category[] }>({ queryKey: ["categories"], queryFn: () => api.get("/api/categories"), staleTime: 300_000 });
  const query = useQuery<Paginated<Item>>({
    queryKey: ["vehicles", params.toString()],
    queryFn: () => api.get(`/api/vehicles${qs({ q: params.get("q"), status, category_id: category, page, include_archived: archived ? 1 : undefined })}`),
    placeholderData: (prev) => prev,
  });

  const chips: { value: string; label: string }[] = [{ value: "", label: t("common.all") }, ...VEHICLE_STATUSES.filter((s) => s !== "archived").map((s) => ({ value: s, label: t(`status.${s}`) }))];

  return (
    <div>
      <PageHeader
        title={t("vehicles.title")}
        subtitle={query.data ? t("common.results", { count: query.data.count }) : undefined}
        action={
          can("admin") && (
            <Link to="/vehicles/new">
              <Button size="sm">+ {t("common.new")}</Button>
            </Link>
          )
        }
      />
      <div className="space-y-3">
        <Input type="search" placeholder={t("vehicles.search_hint")} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-wrap lg:px-0">
          {chips.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => set("status", c.value)}
              className={cx("shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium", (status || "") === c.value ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-slate-700")}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <Select value={category} onChange={(e) => set("category_id", e.target.value)}>
              <option value="">{t("vehicles.filter_category")}: {t("common.all")}</option>
              {categories.data?.results.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
          <label className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-700">
            <input type="checkbox" checked={archived} onChange={(e) => set("include_archived", e.target.checked ? "1" : "")} />
            {t("vehicles.include_archived")}
          </label>
        </div>
      </div>

      <div className="mt-4">
        {query.isLoading ? (
          <Loading />
        ) : query.error ? (
          <ErrorBox error={query.error} onRetry={() => query.refetch()} />
        ) : query.data && query.data.results.length === 0 ? (
          <EmptyState text={t("vehicles.empty")} />
        ) : (
          <div className="space-y-2">
            {query.data?.results.map((v) => (
              <VehicleCard key={v.id} v={v} />
            ))}
          </div>
        )}
        {query.data && <Pagination page={query.data.page} pageSize={query.data.page_size} count={query.data.count} onPage={(p) => set("page", String(p))} />}
      </div>
    </div>
  );
}
