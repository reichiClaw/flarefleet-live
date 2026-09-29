import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Category, Company, Vehicle } from "@shared/types";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { Button, Card, ErrorBox, Field, Input, Loading, PageHeader, Select, Textarea, errorMessage, useToast } from "../components/ui";

interface FormState {
  internal_number: string;
  external_key: string;
  category_id: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  license_plate: string;
  location: string;
  notes: string;
  supplier_id: string;
  expected_arrival: string;
  return_due: string;
  odometer_km: string;
  operating_hours: string;
}

// A half-typed or comma-separated number must not reach the API as NaN.
function numberOrNull(raw: string): number | null {
  const n = Number(raw.trim().replace(",", "."));
  return raw.trim() === "" || !Number.isFinite(n) ? null : n;
}

const empty: FormState = {
  internal_number: "",
  external_key: "",
  category_id: "",
  manufacturer: "",
  model: "",
  serial_number: "",
  license_plate: "",
  location: "",
  notes: "",
  supplier_id: "",
  expected_arrival: "",
  return_due: "",
  odometer_km: "",
  operating_hours: "",
};

export function VehicleFormPage() {
  const { t } = useT();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { id } = useParams();
  const editing = !!id;
  const [form, setForm] = useState<FormState>(empty);

  const categories = useQuery<{ results: Category[] }>({ queryKey: ["categories"], queryFn: () => api.get("/api/categories") });
  const suppliers = useQuery<{ results: Company[] }>({ queryKey: ["companies", "supplier"], queryFn: () => api.get("/api/companies?type=supplier") });
  const vehicle = useQuery<Vehicle>({ queryKey: ["vehicle", id], queryFn: () => api.get(`/api/vehicles/${id}`), enabled: editing });

  useEffect(() => {
    if (vehicle.data) {
      const v = vehicle.data;
      setForm({
        internal_number: v.internal_number,
        external_key: v.external_key ?? "",
        category_id: v.category_id,
        manufacturer: v.manufacturer,
        model: v.model,
        serial_number: v.serial_number,
        license_plate: v.license_plate,
        location: v.location,
        notes: v.notes,
        supplier_id: v.supplier_id ?? "",
        expected_arrival: v.expected_arrival ?? "",
        return_due: v.return_due ?? "",
        odometer_km: v.odometer_km?.toString() ?? "",
        operating_hours: v.operating_hours?.toString() ?? "",
      });
    }
  }, [vehicle.data]);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        external_key: form.external_key || null,
        supplier_id: form.supplier_id || null,
        expected_arrival: form.expected_arrival || null,
        return_due: form.return_due || null,
        odometer_km: numberOrNull(form.odometer_km),
        operating_hours: numberOrNull(form.operating_hours),
      };
      if (editing) return api.patch<Vehicle>(`/api/vehicles/${id}`, payload);
      const { return_due: _rd, ...createPayload } = payload;
      return api.post<Vehicle>("/api/vehicles", createPayload);
    },
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ["vehicles"] });
      qc.invalidateQueries({ queryKey: ["vehicle", v.id] });
      toast.push(t("common.saved"));
      nav(`/vehicles/${v.id}`, { replace: true });
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });

  if (editing && vehicle.isLoading) return <Loading />;
  if (editing && vehicle.error) return <ErrorBox error={vehicle.error} />;

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm({ ...form, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };
  const details = mutation.error && "details" in (mutation.error as object) ? ((mutation.error as { details?: Record<string, string> }).details ?? {}) : {};

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl">
      <PageHeader title={editing ? t("action.edit") : t("vehicles.new")} back={() => nav(-1)} />
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("vehicle.category")} required error={details.category_id} className="sm:col-span-2">
            <Select required value={form.category_id} onChange={set("category_id")}>
              <option value="">–</option>
              {categories.data?.results
                .filter((c) => c.is_active || c.id === form.category_id)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t("vehicle.manufacturer")} required error={details.manufacturer}>
            <Input required value={form.manufacturer} onChange={set("manufacturer")} />
          </Field>
          <Field label={t("vehicle.model")} required error={details.model}>
            <Input required value={form.model} onChange={set("model")} />
          </Field>
          <Field label={t("vehicle.internal_number")} hint={editing ? undefined : t("vehicle.internal_number_hint")} error={details.internal_number}>
            <Input value={form.internal_number} onChange={set("internal_number")} />
          </Field>
          <Field label={t("vehicle.external_key")} error={details.external_key}>
            <Input value={form.external_key} onChange={set("external_key")} />
          </Field>
          <Field label={t("vehicle.serial_number")} error={details.serial_number}>
            <Input value={form.serial_number} onChange={set("serial_number")} />
          </Field>
          <Field label={t("vehicle.license_plate")} error={details.license_plate}>
            <Input value={form.license_plate} onChange={set("license_plate")} />
          </Field>
          <Field label={t("vehicle.supplier")}>
            <Select value={form.supplier_id} onChange={set("supplier_id")}>
              <option value="">–</option>
              {suppliers.data?.results.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("vehicle.location")}>
            <Input value={form.location} onChange={set("location")} />
          </Field>
          <Field label={t("vehicle.expected_arrival")}>
            <Input type="date" value={form.expected_arrival} onChange={set("expected_arrival")} />
          </Field>
          {editing && (
            <Field label={t("vehicle.return_due")}>
              <Input type="date" value={form.return_due} onChange={set("return_due")} />
            </Field>
          )}
          <Field label={t("vehicle.odometer")}>
            <Input type="number" inputMode="numeric" min={0} value={form.odometer_km} onChange={set("odometer_km")} />
          </Field>
          <Field label={t("vehicle.hours")}>
            <Input type="number" inputMode="decimal" step="0.1" min={0} value={form.operating_hours} onChange={set("operating_hours")} />
          </Field>
          <Field label={t("common.notes")} className="sm:col-span-2">
            <Textarea value={form.notes} onChange={set("notes")} />
          </Field>
        </div>
        <div className="mt-5 flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={() => nav(-1)}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" className="flex-[2]" loading={mutation.isPending}>
            {t("common.save")}
          </Button>
        </div>
      </Card>
    </form>
  );
}
