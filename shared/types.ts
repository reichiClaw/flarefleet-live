// Types shared by the Worker API and the React SPA.

export type Role = "super_admin" | "admin" | "user";
export type Language = "de" | "en";
export type MeterMode = "odometer" | "hours" | "both" | "none";
export type CompanyType = "supplier" | "subcontractor" | "internal";
export type VehicleStatus =
  | "announced"
  | "available"
  | "loaned"
  | "damaged"
  | "maintenance"
  | "checked_out"
  | "archived";
export type ProtocolType =
  | "check_in"
  | "loan_checkout"
  | "loan_return"
  | "check_out"
  | "maintenance_start"
  | "maintenance_end"
  | "damage_resolved"
  | "status_correction";
export type Condition = "ok" | "damaged" | "maintenance";
export type Severity = "minor" | "major" | "critical";
export type PdfStatus = "pending" | "generated" | "failed" | "none";

export const ROLES: Role[] = ["super_admin", "admin", "user"];
export const VEHICLE_STATUSES: VehicleStatus[] = [
  "announced",
  "available",
  "loaned",
  "damaged",
  "maintenance",
  "checked_out",
  "archived",
];
export const ACTIVE_STATUSES: VehicleStatus[] = ["announced", "available", "loaned", "damaged", "maintenance"];

export const ROLE_RANK: Record<Role, number> = { user: 1, admin: 2, super_admin: 3 };
export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  language: Language;
  must_change_password: boolean;
  csrf_token: string;
  settings: PublicSettings;
}

export interface PublicSettings {
  org_name: string;
  default_language: Language;
  public_base_url: string;
  min_photos_check_in: number;
  min_photos_loan: number;
  min_photos_return: number;
  min_photos_check_out: number;
  signature_required_check_in: boolean;
  signature_required_return: boolean;
  signature_required_check_out: boolean;
  default_loan_days: number;
  public_qr_page: boolean;
  email_enabled: boolean;
}

export interface Settings extends PublicSettings {
  email_from: string;
  overdue_digest_recipients: string;
  pdf_footer: string;
}

export interface Category {
  id: string;
  name: string;
  meter_mode: MeterMode;
  is_active: boolean;
  vehicle_count?: number;
}

export interface Company {
  id: string;
  name: string;
  company_type: CompanyType;
  contact_name: string;
  phone: string;
  email: string;
  notes: string;
  is_active: boolean;
}

export interface Driver {
  id: string;
  company_id: string | null;
  company_name?: string | null;
  name: string;
  phone: string;
  email: string;
  is_active: boolean;
}

export interface Loan {
  id: string;
  vehicle_id: string;
  company_id: string | null;
  company_name?: string | null;
  driver_id: string | null;
  borrower_name: string;
  borrower_phone: string;
  borrower_email: string;
  status: "active" | "returned" | "cancelled";
  checked_out_at: string;
  expected_return_at: string;
  actual_return_at: string | null;
  checkout_odometer_km: number | null;
  checkout_operating_hours: number | null;
  return_odometer_km: number | null;
  return_operating_hours: number | null;
  checkout_protocol_id: string | null;
  return_protocol_id: string | null;
  overdue?: boolean;
  vehicle?: VehicleSummary;
}

export interface VehicleSummary {
  id: string;
  internal_number: string;
  qr_code: string;
  manufacturer: string;
  model: string;
  license_plate: string;
  serial_number: string;
  status: VehicleStatus;
  category_name: string;
}

export interface Vehicle extends VehicleSummary {
  external_key: string | null;
  category_id: string;
  meter_mode: MeterMode;
  odometer_km: number | null;
  operating_hours: number | null;
  location: string;
  notes: string;
  supplier_id: string | null;
  supplier_name: string | null;
  expected_arrival: string | null;
  return_due: string | null;
  archived_at: string | null;
  archive_reason: string;
  created_at: string;
  updated_at: string;
  open_damage_count: number;
  active_loan: Loan | null;
  capabilities: VehicleCapabilities;
}

export interface VehicleCapabilities {
  check_in: boolean;
  loan: boolean;
  return: boolean;
  check_out: boolean;
  maintenance_start: boolean;
  maintenance_end: boolean;
  report_damage: boolean;
  resolve_damage: boolean;
  archive: boolean;
  unarchive: boolean;
  correct: boolean;
  edit: boolean;
}

export interface Damage {
  id: string;
  vehicle_id: string;
  protocol_id: string | null;
  description: string;
  severity: Severity;
  reported_by: string;
  reported_by_name?: string;
  reported_at: string;
  resolved_at: string | null;
  resolution_notes: string;
  photos?: MediaItem[];
}

export interface MediaItem {
  id: string;
  kind: "photo" | "signature" | "pdf" | "import";
  filename: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
  caption: string;
  created_at: string;
  url: string;
}

export interface Protocol {
  id: string;
  number: string;
  type: ProtocolType;
  vehicle_id: string;
  loan_id: string | null;
  company_id: string | null;
  company_name: string | null;
  performed_by: string;
  performed_by_name: string;
  performed_at: string;
  odometer_km: number | null;
  operating_hours: number | null;
  condition: Condition | null;
  notes: string;
  status_before: VehicleStatus | null;
  status_after: VehicleStatus | null;
  language: Language;
  pdf_status: PdfStatus;
  pdf_media_id: string | null;
  pdf_error: string | null;
  snapshot?: ProtocolSnapshot;
  photos?: MediaItem[];
  signature?: MediaItem | null;
  vehicle?: VehicleSummary;
}

export interface ProtocolSnapshot {
  vehicle: VehicleSummary & { location: string; meter_mode: MeterMode };
  party?: { name: string; phone?: string; email?: string; company?: string | null } | null;
  loan?: { expected_return_at: string; checked_out_at: string; actual_return_at?: string | null } | null;
  readings: { odometer_km: number | null; operating_hours: number | null };
  previous_readings?: { odometer_km: number | null; operating_hours: number | null };
  damages: { description: string; severity: Severity }[];
  media: { id: string; kind: string; sha256: string; caption: string }[];
  performed_by: { id: string; name: string; email: string };
  extra?: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  vehicle_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface Paginated<T> {
  count: number;
  page: number;
  page_size: number;
  results: T[];
}

export interface DashboardSummary {
  counts: Record<VehicleStatus, number>;
  fleet: number;
  active_loans: number;
  overdue_loans: number;
  open_damages: number;
  failed_pdfs: number;
  arrivals: (VehicleSummary & { expected_arrival: string | null })[];
  overdue: Loan[];
  due_soon: Loan[];
  attention: (VehicleSummary & { open_damage_count: number })[];
  return_due: (VehicleSummary & { return_due: string | null })[];
  recent: AuditEntry[];
}

export interface ImportRow {
  row_number: number;
  action: "create" | "update" | "error";
  data: Record<string, string | number | null>;
  errors: { field: string; message: string }[];
  matched_vehicle_id: string | null;
  result_vehicle_id: string | null;
}

export interface ImportJob {
  id: string;
  filename: string;
  status: "validated" | "failed" | "committed";
  columns: Record<string, string>;
  row_count: number;
  valid_count: number;
  error_count: number;
  created_count: number;
  updated_count: number;
  created_by: string;
  committed_at: string | null;
  created_at: string;
  rows?: ImportRow[];
}

export interface ApiError {
  error: { code: string; message: string; details?: Record<string, string> };
}
