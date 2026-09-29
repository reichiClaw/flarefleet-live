import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { Condition, MediaItem, MeterMode, Severity, Vehicle, VehicleStatus } from "@shared/types";
import { meterRequirements } from "@shared/domain";
import { useT } from "../lib/i18n";
import { fmtNum } from "../lib/format";
import { Button, Field, Input, PageHeader, SegmentedControl, Select, StatusBadge, Textarea, cx } from "./ui";
import { PhotoCapture } from "./PhotoCapture";

// ---- Wizard frame -----------------------------------------------------------
export interface WizardStep {
  key: string;
  title: string;
  content: ReactNode;
  /** returns an error message or null */
  validate?: () => string | null;
}

export function Wizard({
  title,
  vehicle,
  steps,
  onSubmit,
  submitting,
  submitLabel,
}: {
  title: string;
  vehicle: Vehicle;
  steps: WizardStep[];
  onSubmit: () => void;
  submitting: boolean;
  submitLabel?: string;
}) {
  const { t } = useT();
  const nav = useNavigate();
  const [idx, setIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const step = steps[idx];
  const last = idx === steps.length - 1;

  function next() {
    const err = step.validate?.() ?? null;
    setError(err);
    if (err) return;
    if (last) onSubmit();
    else setIdx(idx + 1);
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={title}
        subtitle={
          <span className="flex items-center gap-2">
            <span className="font-mono">{vehicle.internal_number}</span> · {vehicle.manufacturer} {vehicle.model} <StatusBadge status={vehicle.status} />
          </span>
        }
        back={() => (idx > 0 ? setIdx(idx - 1) : nav(-1))}
      />
      <ol className="mb-4 flex gap-1.5">
        {steps.map((s, i) => (
          <li key={s.key} className="flex-1">
            <button type="button" onClick={() => i < idx && setIdx(i)} className="w-full text-left">
              <span className={cx("block h-1.5 rounded-full", i <= idx ? "bg-blue-600" : "bg-slate-200")} />
              <span className={cx("mt-1 block truncate text-[11px]", i === idx ? "font-semibold text-blue-700" : "text-slate-500")}>{s.title}</span>
            </button>
          </li>
        ))}
      </ol>
      <div className="space-y-4">{step.content}</div>
      {error && <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <div className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] mt-6 flex gap-2 rounded-2xl bg-white/90 p-2 shadow-[0_-4px_20px_rgba(15,23,42,0.06)] backdrop-blur lg:bottom-4">
        <Button variant="secondary" className="flex-1" onClick={() => (idx > 0 ? setIdx(idx - 1) : nav(-1))} disabled={submitting}>
          {t("common.back")}
        </Button>
        <Button variant={last ? "success" : "primary"} className="flex-[2]" onClick={next} loading={submitting}>
          {last ? submitLabel ?? t("wf.submit") : t("common.next")}
        </Button>
      </div>
    </div>
  );
}

// ---- Shared workflow field groups ---------------------------------------------
export interface ReadingsState {
  odometer_km: string;
  operating_hours: string;
}

// Browsers let some unparseable text through a number input; NaN must never be sent.
export function readingNumber(raw: string): number | null {
  const n = Number(raw.trim().replace(",", "."));
  return raw.trim() === "" || !Number.isFinite(n) ? null : n;
}

export function readingsToPayload(r: ReadingsState, mode: MeterMode) {
  const req = meterRequirements(mode);
  return {
    odometer_km: req.odometer ? readingNumber(r.odometer_km) : null,
    operating_hours: req.hours ? readingNumber(r.operating_hours) : null,
  };
}

export function validateReadings(r: ReadingsState, vehicle: Vehicle, required: boolean, t: (k: string, p?: Record<string, string | number>) => string): string | null {
  const req = meterRequirements(vehicle.meter_mode);
  if (req.odometer) {
    const odo = readingNumber(r.odometer_km);
    if (required && odo == null) return `${t("vehicle.odometer")}: ${t("common.required")}`;
    if (r.odometer_km.trim() !== "" && odo == null) return `${t("vehicle.odometer")}: ${t("common.invalid_number")}`;
    if (odo != null && vehicle.odometer_km != null && odo < vehicle.odometer_km) return `${t("vehicle.odometer")} < ${vehicle.odometer_km}`;
  }
  if (req.hours) {
    const hours = readingNumber(r.operating_hours);
    if (required && hours == null) return `${t("vehicle.hours")}: ${t("common.required")}`;
    if (r.operating_hours.trim() !== "" && hours == null) return `${t("vehicle.hours")}: ${t("common.invalid_number")}`;
    if (hours != null && vehicle.operating_hours != null && hours < vehicle.operating_hours) return `${t("vehicle.hours")} < ${vehicle.operating_hours}`;
  }
  return null;
}

export function ReadingsFields({ vehicle, value, onChange, required }: { vehicle: Vehicle; value: ReadingsState; onChange: (v: ReadingsState) => void; required?: boolean }) {
  const { t, lang } = useT();
  const req = meterRequirements(vehicle.meter_mode);
  if (!req.odometer && !req.hours) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-800">{t("wf.readings")}</h3>
      <div className="grid grid-cols-2 gap-3">
        {req.odometer && (
          <Field label={`${t("vehicle.odometer")} (${t("wf.km")})`} required={required} hint={vehicle.odometer_km != null ? t("wf.reading_previous", { value: fmtNum(vehicle.odometer_km, lang, "km") }) : undefined}>
            <Input type="number" inputMode="numeric" min={vehicle.odometer_km ?? 0} value={value.odometer_km} onChange={(e) => onChange({ ...value, odometer_km: e.target.value })} placeholder={vehicle.odometer_km != null ? String(vehicle.odometer_km) : "0"} />
          </Field>
        )}
        {req.hours && (
          <Field label={`${t("vehicle.hours")} (${t("wf.h")})`} required={required} hint={vehicle.operating_hours != null ? t("wf.reading_previous", { value: fmtNum(vehicle.operating_hours, lang, "h") }) : undefined}>
            <Input type="number" inputMode="decimal" step="0.1" min={vehicle.operating_hours ?? 0} value={value.operating_hours} onChange={(e) => onChange({ ...value, operating_hours: e.target.value })} placeholder={vehicle.operating_hours != null ? String(vehicle.operating_hours) : "0"} />
          </Field>
        )}
      </div>
    </div>
  );
}

export interface DamageDraft {
  description: string;
  severity: Severity;
  photos: MediaItem[];
}

export function ConditionPicker({ value, onChange, allowMaintenance = true }: { value: Condition; onChange: (c: Condition) => void; allowMaintenance?: boolean }) {
  const { t } = useT();
  const options = [
    { value: "ok" as Condition, label: t("condition.ok") },
    { value: "damaged" as Condition, label: t("condition.damaged") },
    ...(allowMaintenance ? [{ value: "maintenance" as Condition, label: t("condition.maintenance") }] : []),
  ];
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-800">{t("wf.condition")}</h3>
      <SegmentedControl value={value} onChange={onChange} options={options} />
    </div>
  );
}

export function DamagesEditor({ damages, onChange }: { damages: DamageDraft[]; onChange: (d: DamageDraft[]) => void }) {
  const { t } = useT();
  function update(i: number, patch: Partial<DamageDraft>) {
    onChange(damages.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  }
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">{t("wf.damages")}</h3>
        <Button size="sm" variant="secondary" onClick={() => onChange([...damages, { description: "", severity: "minor", photos: [] }])}>
          + {t("wf.add_damage")}
        </Button>
      </div>
      <div className="space-y-3">
        {damages.map((d, i) => (
          <div key={i} className="rounded-2xl border border-red-200 bg-red-50/40 p-3">
            <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
              <Field label={t("wf.damage_description")} required>
                <Textarea value={d.description} onChange={(e) => update(i, { description: e.target.value })} rows={2} />
              </Field>
              <Field label={t("wf.damage_severity")}>
                <Select value={d.severity} onChange={(e) => update(i, { severity: e.target.value as Severity })}>
                  <option value="minor">{t("severity.minor")}</option>
                  <option value="major">{t("severity.major")}</option>
                  <option value="critical">{t("severity.critical")}</option>
                </Select>
              </Field>
            </div>
            <p className="mb-1 mt-2 text-xs font-medium text-slate-600">{t("wf.damage_photos")}</p>
            <PhotoCapture photos={d.photos} onChange={(photos) => update(i, { photos })} max={6} compact />
            <div className="mt-2 text-right">
              <Button size="sm" variant="ghost" onClick={() => onChange(damages.filter((_, j) => j !== i))}>
                {t("common.delete")}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SummaryList({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white">
      {items
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-4 px-4 py-2.5 text-sm">
            <dt className="text-slate-500">{k}</dt>
            <dd className="text-right font-medium text-slate-900">{v}</dd>
          </div>
        ))}
    </dl>
  );
}

export function StatusPreview({ from, to }: { from: VehicleStatus; to: VehicleStatus }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <StatusBadge status={from} /> <span className="text-slate-400">→</span> <StatusBadge status={to} />
    </div>
  );
}
