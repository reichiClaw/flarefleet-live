import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Company, Condition, Damage, Driver, MediaItem, ProtocolType, Vehicle, VehicleStatus } from "@shared/types";
import { VEHICLE_STATUSES } from "@shared/types";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { fmtDateTime, fmtNum, fromLocalInputDateTime, toLocalInputDateTime, todayPlusDays } from "../lib/format";
import { Button, Card, ErrorBox, Field, Input, Loading, Select, StatusBadge, Textarea, Toggle, errorMessage, useToast } from "../components/ui";
import { PhotoCapture } from "../components/PhotoCapture";
import { SignaturePad } from "../components/SignaturePad";
import { ConditionPicker, DamagesEditor, ReadingsFields, StatusPreview, SummaryList, Wizard, readingsToPayload, validateReadings, type DamageDraft, type ReadingsState } from "../components/Wizard";
import { invalidateVehicle, useVehicle } from "./VehicleDetail";

interface WorkflowResult {
  vehicle: Vehicle;
  protocol_id: string;
  protocol_number: string;
}

function useWorkflow(vehicleId: string | undefined, path: string, type: ProtocolType) {
  const qc = useQueryClient();
  const toast = useToast();
  const [result, setResult] = useState<WorkflowResult | null>(null);
  const mutation = useMutation({
    mutationFn: (payload: unknown) => api.post<WorkflowResult>(`/api/vehicles/${vehicleId}/${path}`, payload),
    onSuccess: (r) => {
      invalidateVehicle(qc, vehicleId!);
      setResult(r);
    },
    onError: (e) => toast.push(errorMessage(e), "error"),
  });
  return { mutation, result, type };
}

function Success({ result, type }: { result: WorkflowResult; type: ProtocolType }) {
  const { t } = useT();
  return (
    <div className="mx-auto max-w-md pt-8 text-center">
      <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="m5 13 4 4L19 7" />
        </svg>
      </div>
      <h1 className="mt-4 text-xl font-bold text-slate-900">{t("wf.success", { type: t(`protocol.${type}`), number: result.protocol_number })}</h1>
      <p className="mt-1 text-sm text-slate-500">{t("wf.success_pdf")}</p>
      <div className="mt-3 flex justify-center">
        <StatusBadge status={result.vehicle.status} />
      </div>
      <div className="mt-6 space-y-2">
        <Link to={`/vehicles/${result.vehicle.id}`} className="block">
          <Button className="w-full">{t("wf.open_vehicle")}</Button>
        </Link>
        <Link to={`/documents/${result.protocol_id}`} className="block">
          <Button variant="secondary" className="w-full">
            {t("wf.open_protocol")}
          </Button>
        </Link>
        <Link to="/scan" className="block">
          <Button variant="ghost" className="w-full">
            {t("wf.another_scan")}
          </Button>
        </Link>
      </div>
    </div>
  );
}

function damagesPayload(damages: DamageDraft[]) {
  return damages.filter((d) => d.description.trim()).map((d) => ({ description: d.description.trim(), severity: d.severity, photo_ids: d.photos.map((p) => p.id) }));
}

function conditionStatus(condition: Condition): VehicleStatus {
  return condition === "damaged" ? "damaged" : condition === "maintenance" ? "maintenance" : "available";
}

// ---------------------------------------------------------------------------
export function CheckInPage() {
  const { t, lang } = useT();
  const { me } = useAuth();
  const { id } = useParams();
  const q = useVehicle(id);
  const wf = useWorkflow(id, "check-in", "check_in");
  const suppliers = useQuery<{ results: Company[] }>({ queryKey: ["companies", "supplier"], queryFn: () => api.get("/api/companies?type=supplier") });
  const [readings, setReadings] = useState<ReadingsState>({ odometer_km: "", operating_hours: "" });
  const [location, setLocation] = useState("");
  const [plate, setPlate] = useState<string | null>(null);
  const [serial, setSerial] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState<string | null>(null);
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [condition, setCondition] = useState<Condition>("ok");
  const [damages, setDamages] = useState<DamageDraft[]>([]);
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState<MediaItem | null>(null);
  const [copyTo, setCopyTo] = useState("");

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  if (wf.result) return <Success result={wf.result} type={wf.type} />;
  const v = q.data;
  const s = me!.settings;
  const minPhotos = s.min_photos_check_in;
  const sigRequired = s.signature_required_check_in;

  const submit = () =>
    wf.mutation.mutate({
      ...readingsToPayload(readings, v.meter_mode),
      location: location || undefined,
      supplier_id: supplierId === null ? undefined : supplierId || null,
      license_plate: plate ?? undefined,
      serial_number: serial ?? undefined,
      condition,
      damages: damagesPayload(damages),
      notes,
      photo_ids: photos.map((p) => p.id),
      signature_id: signature?.id ?? null,
      send_copy_to: copyTo,
    });

  return (
    <Wizard
      title={t("action.check_in")}
      vehicle={v}
      submitting={wf.mutation.isPending}
      onSubmit={submit}
      steps={[
        {
          key: "details",
          title: t("wf.step_details"),
          validate: () => validateReadings(readings, v, false, t),
          content: (
            <Card>
              <div className="space-y-4">
                <ReadingsFields vehicle={v} value={readings} onChange={setReadings} />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("vehicle.license_plate")}>
                    <Input value={plate ?? v.license_plate} onChange={(e) => setPlate(e.target.value)} />
                  </Field>
                  <Field label={t("vehicle.serial_number")}>
                    <Input value={serial ?? v.serial_number} onChange={(e) => setSerial(e.target.value)} />
                  </Field>
                  <Field label={t("vehicle.location")}>
                    <Input value={location} placeholder={v.location} onChange={(e) => setLocation(e.target.value)} />
                  </Field>
                  <Field label={t("vehicle.supplier")}>
                    <Select value={supplierId ?? v.supplier_id ?? ""} onChange={(e) => setSupplierId(e.target.value)}>
                      <option value="">–</option>
                      {suppliers.data?.results.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>
            </Card>
          ),
        },
        {
          key: "photos",
          title: t("wf.step_photos"),
          validate: () => (photos.length < minPhotos ? t("wf.photos_min", { count: minPhotos }) : null),
          content: (
            <Card>
              <p className="mb-3 text-sm text-slate-600">{t("wf.photos_hint")}</p>
              <PhotoCapture photos={photos} onChange={setPhotos} min={minPhotos} />
            </Card>
          ),
        },
        {
          key: "condition",
          title: t("wf.step_condition"),
          validate: () => (condition === "damaged" && damagesPayload(damages).length === 0 ? t("wf.damage_required") : null),
          content: (
            <Card>
              <div className="space-y-4">
                <ConditionPicker value={condition} onChange={setCondition} />
                {condition !== "ok" && <DamagesEditor damages={damages} onChange={setDamages} />}
                <Field label={t("common.notes")}>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
              </div>
            </Card>
          ),
        },
        {
          key: "confirm",
          title: t("wf.step_confirm"),
          validate: () => (sigRequired && !signature ? t("wf.signature_required") : null),
          content: (
            <>
              <Card>
                <StatusPreview from={v.status} to={conditionStatus(condition)} />
                <div className="mt-3">
                  <SummaryList
                    items={[
                      [t("vehicle.odometer"), readings.odometer_km ? fmtNum(Number(readings.odometer_km), lang, "km") : ""],
                      [t("vehicle.hours"), readings.operating_hours ? fmtNum(Number(readings.operating_hours), lang, "h") : ""],
                      [t("common.photos"), photos.length],
                      [t("wf.condition"), t(`condition.${condition}`)],
                      [t("wf.damages"), damagesPayload(damages).length || ""],
                      [t("common.notes"), notes],
                    ]}
                  />
                </div>
              </Card>
              <Card>
                <SignaturePad value={signature} onChange={setSignature} required={sigRequired} />
              </Card>
              {s.email_enabled && (
                <Card>
                  <Field label={t("wf.send_copy")}>
                    <Input type="email" value={copyTo} onChange={(e) => setCopyTo(e.target.value)} placeholder="name@example.com" />
                  </Field>
                </Card>
              )}
              <p className="text-center text-xs text-slate-500">{t("wf.confirm_hint")}</p>
            </>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
export function LoanPage() {
  const { t, lang } = useT();
  const { me } = useAuth();
  const { id } = useParams();
  const q = useVehicle(id);
  const wf = useWorkflow(id, "loan", "loan_checkout");
  const companies = useQuery<{ results: Company[] }>({ queryKey: ["companies", "borrowers"], queryFn: () => api.get("/api/companies") });
  const drivers = useQuery<{ results: Driver[] }>({ queryKey: ["drivers"], queryFn: () => api.get("/api/drivers") });
  const [readings, setReadings] = useState<ReadingsState>({ odometer_km: "", operating_hours: "" });
  const [companyId, setCompanyId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [returnAt, setReturnAt] = useState(() => toLocalInputDateTime(todayPlusDays(me?.settings.default_loan_days ?? 7)));
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState<MediaItem | null>(null);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  if (wf.result) return <Success result={wf.result} type={wf.type} />;
  const v = q.data;
  const minPhotos = me!.settings.min_photos_loan;
  const borrowerCompanies = companies.data?.results.filter((c) => c.company_type !== "supplier") ?? [];
  const driverList = (drivers.data?.results ?? []).filter((d) => !companyId || d.company_id === companyId || !d.company_id);

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

  const submit = () =>
    wf.mutation.mutate({
      ...readingsToPayload(readings, v.meter_mode),
      company_id: companyId || null,
      driver_id: driverId || null,
      borrower_name: name,
      borrower_phone: phone,
      borrower_email: email,
      expected_return_at: fromLocalInputDateTime(returnAt),
      notes,
      photo_ids: photos.map((p) => p.id),
      signature_id: signature?.id ?? null,
    });

  const quickDays = [1, 3, 7, 14, 30];

  return (
    <Wizard
      title={t("action.loan")}
      vehicle={v}
      submitting={wf.mutation.isPending}
      onSubmit={submit}
      steps={[
        {
          key: "details",
          title: t("wf.step_details"),
          validate: () => {
            if (!name.trim()) return `${t("wf.borrower_name")}: ${t("common.required")}`;
            if (!returnAt || new Date(returnAt).getTime() <= Date.now()) return t("wf.expected_return_at");
            return validateReadings(readings, v, true, t);
          },
          content: (
            <Card>
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
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
                <div>
                  <Field label={t("wf.expected_return_at")} required>
                    <Input type="datetime-local" value={returnAt} onChange={(e) => setReturnAt(e.target.value)} />
                  </Field>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {quickDays.map((d) => (
                      <button key={d} type="button" onClick={() => setReturnAt(toLocalInputDateTime(todayPlusDays(d)))} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700">
                        {t("wf.loan_days", { days: d })}
                      </button>
                    ))}
                  </div>
                </div>
                <ReadingsFields vehicle={v} value={readings} onChange={setReadings} required />
              </div>
            </Card>
          ),
        },
        {
          key: "photos",
          title: t("wf.step_photos"),
          validate: () => (photos.length < minPhotos ? t("wf.photos_min", { count: minPhotos }) : null),
          content: (
            <Card>
              <p className="mb-3 text-sm text-slate-600">{t("wf.photos_hint")}</p>
              <PhotoCapture photos={photos} onChange={setPhotos} min={minPhotos} />
              <Field label={t("common.notes")} className="mt-4">
                <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </Card>
          ),
        },
        {
          key: "confirm",
          title: t("wf.step_confirm"),
          content: (
            <>
              <Card>
                <StatusPreview from={v.status} to="loaned" />
                <div className="mt-3">
                  <SummaryList
                    items={[
                      [t("wf.borrower_name"), name],
                      [t("partners.company"), borrowerCompanies.find((c) => c.id === companyId)?.name ?? ""],
                      [t("common.phone"), phone],
                      [t("common.email"), email],
                      [t("wf.expected_return_at"), fmtDateTime(fromLocalInputDateTime(returnAt), lang)],
                      [t("vehicle.odometer"), readings.odometer_km ? fmtNum(Number(readings.odometer_km), lang, "km") : ""],
                      [t("vehicle.hours"), readings.operating_hours ? fmtNum(Number(readings.operating_hours), lang, "h") : ""],
                      [t("common.photos"), photos.length],
                    ]}
                  />
                </div>
              </Card>
              <Card>
                <SignaturePad value={signature} onChange={setSignature} />
              </Card>
              <p className="text-center text-xs text-slate-500">{t("wf.confirm_hint")}</p>
            </>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
export function ReturnPage() {
  const { t, lang } = useT();
  const { me } = useAuth();
  const { id } = useParams();
  const q = useVehicle(id);
  const wf = useWorkflow(id, "return", "loan_return");
  const [readings, setReadings] = useState<ReadingsState>({ odometer_km: "", operating_hours: "" });
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [condition, setCondition] = useState<Condition>("ok");
  const [damages, setDamages] = useState<DamageDraft[]>([]);
  const [notes, setNotes] = useState("");
  const [signature, setSignature] = useState<MediaItem | null>(null);
  const [copyTo, setCopyTo] = useState("");

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  if (wf.result) return <Success result={wf.result} type={wf.type} />;
  const v = q.data;
  const loan = v.active_loan;
  const s = me!.settings;
  const minPhotos = s.min_photos_return;
  const sigRequired = s.signature_required_return;

  const submit = () =>
    wf.mutation.mutate({
      ...readingsToPayload(readings, v.meter_mode),
      condition,
      damages: damagesPayload(damages),
      notes,
      photo_ids: photos.map((p) => p.id),
      signature_id: signature?.id ?? null,
      send_copy_to: copyTo,
    });

  return (
    <Wizard
      title={t("action.return")}
      vehicle={v}
      submitting={wf.mutation.isPending}
      onSubmit={submit}
      steps={[
        {
          key: "details",
          title: t("wf.step_details"),
          validate: () => validateReadings(readings, v, true, t),
          content: (
            <Card>
              {loan && (
                <div className="mb-4 rounded-xl bg-slate-50 p-3 text-sm">
                  <div className="font-medium text-slate-900">
                    {loan.borrower_name}
                    {loan.company_name ? ` · ${loan.company_name}` : ""}
                  </div>
                  <div className="text-slate-600">
                    {fmtDateTime(loan.checked_out_at, lang)} → {fmtDateTime(loan.expected_return_at, lang)}
                  </div>
                  {loan.overdue && <div className="mt-1 font-semibold text-red-700">{t("wf.loan_return_overdue")}</div>}
                  {(loan.checkout_odometer_km != null || loan.checkout_operating_hours != null) && (
                    <div className="mt-1 text-xs text-slate-500">
                      {t("wf.previous_readings", {
                        value: [loan.checkout_odometer_km != null ? fmtNum(loan.checkout_odometer_km, lang, "km") : null, loan.checkout_operating_hours != null ? fmtNum(loan.checkout_operating_hours, lang, "h") : null]
                          .filter(Boolean)
                          .join(" / "),
                      })}
                    </div>
                  )}
                </div>
              )}
              <ReadingsFields vehicle={v} value={readings} onChange={setReadings} required />
            </Card>
          ),
        },
        {
          key: "photos",
          title: t("wf.step_photos"),
          validate: () => (photos.length < minPhotos ? t("wf.photos_min", { count: minPhotos }) : null),
          content: (
            <Card>
              <p className="mb-3 text-sm text-slate-600">{t("wf.photos_hint")}</p>
              <PhotoCapture photos={photos} onChange={setPhotos} min={minPhotos} />
            </Card>
          ),
        },
        {
          key: "condition",
          title: t("wf.step_condition"),
          validate: () => (condition === "damaged" && damagesPayload(damages).length === 0 ? t("wf.damage_required") : null),
          content: (
            <Card>
              <div className="space-y-4">
                <ConditionPicker value={condition} onChange={setCondition} />
                {condition !== "ok" && <DamagesEditor damages={damages} onChange={setDamages} />}
                <Field label={t("common.notes")}>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
              </div>
            </Card>
          ),
        },
        {
          key: "confirm",
          title: t("wf.step_confirm"),
          validate: () => (sigRequired && !signature ? t("wf.signature_required") : null),
          content: (
            <>
              <Card>
                <StatusPreview from={v.status} to={conditionStatus(condition)} />
                <div className="mt-3">
                  <SummaryList
                    items={[
                      [t("vehicle.borrower"), loan?.borrower_name ?? ""],
                      [t("vehicle.odometer"), readings.odometer_km ? fmtNum(Number(readings.odometer_km), lang, "km") : ""],
                      [t("vehicle.hours"), readings.operating_hours ? fmtNum(Number(readings.operating_hours), lang, "h") : ""],
                      [t("common.photos"), photos.length],
                      [t("wf.condition"), t(`condition.${condition}`)],
                      [t("wf.damages"), damagesPayload(damages).length || ""],
                    ]}
                  />
                </div>
              </Card>
              <Card>
                <SignaturePad value={signature} onChange={setSignature} required={sigRequired} />
              </Card>
              {s.email_enabled && (
                <Card>
                  <Field label={t("wf.send_copy")} hint={loan?.borrower_email ? `+ ${loan.borrower_email}` : undefined}>
                    <Input type="email" value={copyTo} onChange={(e) => setCopyTo(e.target.value)} />
                  </Field>
                </Card>
              )}
            </>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
export function CheckOutPage() {
  const { t, lang } = useT();
  const { me } = useAuth();
  const { id } = useParams();
  const q = useVehicle(id);
  const wf = useWorkflow(id, "check-out", "check_out");
  const suppliers = useQuery<{ results: Company[] }>({ queryKey: ["companies", "supplier"], queryFn: () => api.get("/api/companies?type=supplier") });
  const [readings, setReadings] = useState<ReadingsState>({ odometer_km: "", operating_hours: "" });
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [recipient, setRecipient] = useState("");
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [condition, setCondition] = useState<Condition>("ok");
  const [damages, setDamages] = useState<DamageDraft[]>([]);
  const [notes, setNotes] = useState("");
  const [archive, setArchive] = useState(false);
  const [signature, setSignature] = useState<MediaItem | null>(null);
  const [copyTo, setCopyTo] = useState("");

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  if (wf.result) return <Success result={wf.result} type={wf.type} />;
  const v = q.data;
  const s = me!.settings;
  const minPhotos = s.min_photos_check_out;
  const sigRequired = s.signature_required_check_out;
  const effectiveCompany = companyId ?? v.supplier_id ?? "";

  const submit = () =>
    wf.mutation.mutate({
      ...readingsToPayload(readings, v.meter_mode),
      company_id: effectiveCompany || null,
      recipient_name: recipient,
      condition,
      damages: damagesPayload(damages),
      notes,
      archive,
      photo_ids: photos.map((p) => p.id),
      signature_id: signature?.id ?? null,
      send_copy_to: copyTo,
    });

  return (
    <Wizard
      title={t("action.check_out")}
      vehicle={v}
      submitting={wf.mutation.isPending}
      onSubmit={submit}
      steps={[
        {
          key: "details",
          title: t("wf.step_details"),
          validate: () => validateReadings(readings, v, true, t),
          content: (
            <Card>
              <div className="space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("vehicle.supplier")}>
                    <Select value={effectiveCompany} onChange={(e) => setCompanyId(e.target.value)}>
                      <option value="">–</option>
                      {suppliers.data?.results.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={t("wf.recipient")}>
                    <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} />
                  </Field>
                </div>
                <ReadingsFields vehicle={v} value={readings} onChange={setReadings} required />
                <Toggle checked={archive} onChange={setArchive} label={t("wf.archive_after_checkout")} />
              </div>
            </Card>
          ),
        },
        {
          key: "photos",
          title: t("wf.step_photos"),
          validate: () => (photos.length < minPhotos ? t("wf.photos_min", { count: minPhotos }) : null),
          content: (
            <Card>
              <p className="mb-3 text-sm text-slate-600">{t("wf.photos_hint")}</p>
              <PhotoCapture photos={photos} onChange={setPhotos} min={minPhotos} />
            </Card>
          ),
        },
        {
          key: "condition",
          title: t("wf.step_condition"),
          validate: () => (condition === "damaged" && damagesPayload(damages).length === 0 ? t("wf.damage_required") : null),
          content: (
            <Card>
              <div className="space-y-4">
                <ConditionPicker value={condition} onChange={setCondition} allowMaintenance={false} />
                {condition === "damaged" && <DamagesEditor damages={damages} onChange={setDamages} />}
                <Field label={t("common.notes")}>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
              </div>
            </Card>
          ),
        },
        {
          key: "confirm",
          title: t("wf.step_confirm"),
          validate: () => (sigRequired && !signature ? t("wf.signature_required") : null),
          content: (
            <>
              <Card>
                <StatusPreview from={v.status} to={archive ? "archived" : "checked_out"} />
                <div className="mt-3">
                  <SummaryList
                    items={[
                      [t("vehicle.supplier"), suppliers.data?.results.find((c) => c.id === effectiveCompany)?.name ?? ""],
                      [t("wf.recipient"), recipient],
                      [t("vehicle.odometer"), readings.odometer_km ? fmtNum(Number(readings.odometer_km), lang, "km") : ""],
                      [t("vehicle.hours"), readings.operating_hours ? fmtNum(Number(readings.operating_hours), lang, "h") : ""],
                      [t("common.photos"), photos.length],
                      [t("wf.condition"), t(`condition.${condition}`)],
                    ]}
                  />
                </div>
              </Card>
              <Card>
                <SignaturePad value={signature} onChange={setSignature} required={sigRequired} />
              </Card>
              {s.email_enabled && (
                <Card>
                  <Field label={t("wf.send_copy")}>
                    <Input type="email" value={copyTo} onChange={(e) => setCopyTo(e.target.value)} />
                  </Field>
                </Card>
              )}
            </>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
export function MaintenanceStartPage() {
  const { t } = useT();
  const { id } = useParams();
  const q = useVehicle(id);
  const wf = useWorkflow(id, "maintenance/start", "maintenance_start");
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [readings, setReadings] = useState<ReadingsState>({ odometer_km: "", operating_hours: "" });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  if (wf.result) return <Success result={wf.result} type={wf.type} />;
  const v = q.data;

  return (
    <Wizard
      title={t("action.maintenance_start")}
      vehicle={v}
      submitting={wf.mutation.isPending}
      onSubmit={() => wf.mutation.mutate({ ...readingsToPayload(readings, v.meter_mode), reason, notes, photo_ids: photos.map((p) => p.id) })}
      steps={[
        {
          key: "details",
          title: t("wf.step_details"),
          validate: () => (!reason.trim() ? `${t("wf.reason")}: ${t("common.required")}` : validateReadings(readings, v, false, t)),
          content: (
            <Card>
              <div className="space-y-4">
                <StatusPreview from={v.status} to="maintenance" />
                <Field label={t("wf.reason")} required>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
                </Field>
                <ReadingsFields vehicle={v} value={readings} onChange={setReadings} />
                <Field label={t("common.notes")}>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
                <PhotoCapture photos={photos} onChange={setPhotos} />
              </div>
            </Card>
          ),
        },
      ]}
    />
  );
}

export function MaintenanceEndPage() {
  const { t } = useT();
  const { id } = useParams();
  const q = useVehicle(id);
  const damagesQ = useQuery<{ results: Damage[] }>({ queryKey: ["vehicle-damages", id], queryFn: () => api.get(`/api/vehicles/${id}/damages`), enabled: !!id });
  const wf = useWorkflow(id, "maintenance/end", "maintenance_end");
  const [notes, setNotes] = useState("");
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [resolved, setResolved] = useState<string[]>([]);
  const [readings, setReadings] = useState<ReadingsState>({ odometer_km: "", operating_hours: "" });

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  if (wf.result) return <Success result={wf.result} type={wf.type} />;
  const v = q.data;
  const open = (damagesQ.data?.results ?? []).filter((d) => !d.resolved_at);
  const remaining = open.length - resolved.length;

  return (
    <Wizard
      title={t("action.maintenance_end")}
      vehicle={v}
      submitting={wf.mutation.isPending}
      onSubmit={() => wf.mutation.mutate({ ...readingsToPayload(readings, v.meter_mode), notes, photo_ids: photos.map((p) => p.id), resolved_damage_ids: resolved })}
      steps={[
        {
          key: "details",
          title: t("wf.step_details"),
          validate: () => validateReadings(readings, v, false, t),
          content: (
            <Card>
              <div className="space-y-4">
                <StatusPreview from={v.status} to={remaining > 0 ? "damaged" : "available"} />
                {open.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-semibold text-slate-800">{t("wf.resolved_damages")}</h3>
                    <div className="space-y-2">
                      {open.map((d) => (
                        <label key={d.id} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
                          <input type="checkbox" className="mt-1" checked={resolved.includes(d.id)} onChange={(e) => setResolved(e.target.checked ? [...resolved, d.id] : resolved.filter((x) => x !== d.id))} />
                          <span>
                            <span className="font-medium">[{t(`severity.${d.severity}`)}]</span> {d.description}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
                <Field label={t("wf.resolution_notes")}>
                  <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
                </Field>
                <ReadingsFields vehicle={v} value={readings} onChange={setReadings} />
                <PhotoCapture photos={photos} onChange={setPhotos} />
              </div>
            </Card>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
export function CorrectionPage() {
  const { t } = useT();
  const { id } = useParams();
  const nav = useNavigate();
  const q = useVehicle(id);
  const wf = useWorkflow(id, "correct-status", "status_correction");
  const [status, setStatus] = useState<VehicleStatus | "">("");
  const [reason, setReason] = useState("");
  const [cancelLoan, setCancelLoan] = useState(false);

  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  if (wf.result) return <Success result={wf.result} type={wf.type} />;
  const v = q.data;

  return (
    <Wizard
      title={t("action.correct")}
      vehicle={v}
      submitting={wf.mutation.isPending}
      onSubmit={() => wf.mutation.mutate({ status, reason, cancel_active_loan: cancelLoan })}
      steps={[
        {
          key: "details",
          title: t("wf.step_details"),
          validate: () => (!status ? t("wf.new_status") : reason.trim().length < 3 ? `${t("wf.reason")}: ${t("common.required")}` : null),
          content: (
            <Card>
              <div className="space-y-4">
                <p className="text-sm text-slate-600">{t("wf.correction_hint")}</p>
                <Field label={t("wf.new_status")} required>
                  <Select value={status} onChange={(e) => setStatus(e.target.value as VehicleStatus)}>
                    <option value="">–</option>
                    {VEHICLE_STATUSES.filter((s) => s !== v.status).map((s) => (
                      <option key={s} value={s}>
                        {t(`status.${s}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                {status && <StatusPreview from={v.status} to={status} />}
                {v.active_loan && status && status !== "loaned" && <Toggle checked={cancelLoan} onChange={setCancelLoan} label={t("wf.cancel_loan")} description={v.active_loan.borrower_name} />}
                <Field label={t("wf.reason")} required>
                  <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <Button variant="ghost" onClick={() => nav(-1)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </Card>
          ),
        },
      ]}
    />
  );
}
