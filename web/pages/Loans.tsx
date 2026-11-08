import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import type { Loan, Paginated } from "@shared/types";
import { api, qs } from "../lib/api";
import { useT } from "../lib/i18n";
import { Button, EmptyState, ErrorBox, Loading, PageHeader, Pagination, SegmentedControl } from "../components/ui";
import { LoanRow } from "./Dashboard";

export function LoansPage() {
  const { t } = useT();
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") as "active" | "returned" | "all") || "active";
  const page = Number(params.get("page") ?? 1);
  const q = useQuery<Paginated<Loan>>({
    queryKey: ["loans", status, page],
    queryFn: () => api.get(`/api/dashboard/loans${qs({ status, page })}`),
    placeholderData: (prev) => prev,
  });
  return (
    <div>
      <PageHeader
        title={t("loans.title")}
        subtitle={q.data ? t("common.results", { count: q.data.count }) : undefined}
        action={
          <Link to="/reservations">
            <Button size="sm" variant="secondary">
              {t("res.title")}
            </Button>
          </Link>
        }
      />
      <SegmentedControl
        value={status}
        onChange={(v) => setParams({ status: v })}
        options={[
          { value: "active", label: t("loans.active") },
          { value: "returned", label: t("loans.history") },
          { value: "all", label: t("common.all") },
        ]}
      />
      <div className="mt-4">
        {q.isLoading ? (
          <Loading />
        ) : q.error ? (
          <ErrorBox error={q.error} onRetry={() => q.refetch()} />
        ) : !q.data?.results.length ? (
          <EmptyState text={t("loans.empty")} />
        ) : (
          <div className="space-y-2">
            {q.data.results.map((l) => (
              <LoanRow key={l.id} loan={l} />
            ))}
          </div>
        )}
        {q.data && <Pagination page={q.data.page} pageSize={q.data.page_size} count={q.data.count} onPage={(p) => setParams({ status, page: String(p) })} />}
      </div>
    </div>
  );
}
