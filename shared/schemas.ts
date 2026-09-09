import { z } from "zod";

const trimmed = (max = 200) => z.string().trim().max(max);
const optionalTrimmed = (max = 200) => z.string().trim().max(max).default("");
const optionalId = z.string().uuid().nullable().optional();
const isoDate = z.string().datetime({ offset: true });
const meter = z.number().int().min(0).max(99_999_999).nullable().optional();
const hours = z.number().min(0).max(9_999_999).nullable().optional();
const mediaIds = z.array(z.string().uuid()).max(20).default([]);

export const RoleSchema = z.enum(["super_admin", "admin", "user"]);
export const LanguageSchema = z.enum(["de", "en"]);
export const MeterModeSchema = z.enum(["odometer", "hours", "both", "none"]);
export const CompanyTypeSchema = z.enum(["supplier", "subcontractor", "internal"]);
export const ConditionSchema = z.enum(["ok", "damaged", "maintenance"]);
export const SeveritySchema = z.enum(["minor", "major", "critical"]);
export const VehicleStatusSchema = z.enum([
  "announced",
  "available",
  "loaned",
  "damaged",
  "maintenance",
  "checked_out",
  "archived",
]);

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

export const ChangePasswordSchema = z.object({
  current_password: z.string().max(200).optional(),
  new_password: z.string().min(10).max(200),
});

export const ForgotPasswordSchema = z.object({ email: z.string().trim().toLowerCase().email() });
export const ResetPasswordSchema = z.object({ token: z.string().min(10), new_password: z.string().min(10).max(200) });

export const UserCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: trimmed(120).min(1),
  role: RoleSchema,
  language: LanguageSchema.default("de"),
  send_invite: z.boolean().default(true),
});
export const UserUpdateSchema = z.object({
  name: trimmed(120).min(1).optional(),
  role: RoleSchema.optional(),
  language: LanguageSchema.optional(),
  is_active: z.boolean().optional(),
});
export const ProfileUpdateSchema = z.object({
  name: trimmed(120).min(1).optional(),
  language: LanguageSchema.optional(),
});

export const CategorySchema = z.object({
  name: trimmed(80).min(1),
  meter_mode: MeterModeSchema.default("both"),
  is_active: z.boolean().default(true),
});

export const CompanySchema = z.object({
  name: trimmed(160).min(1),
  company_type: CompanyTypeSchema,
  contact_name: optionalTrimmed(120),
  phone: optionalTrimmed(60),
  email: z.string().trim().max(200).default(""),
  notes: optionalTrimmed(2000),
  is_active: z.boolean().default(true),
});

export const DriverSchema = z.object({
  company_id: optionalId,
  name: trimmed(120).min(1),
  phone: optionalTrimmed(60),
  email: z.string().trim().max(200).default(""),
  is_active: z.boolean().default(true),
});

export const VehicleCreateSchema = z.object({
  internal_number: optionalTrimmed(40),
  external_key: z.string().trim().max(80).nullable().optional(),
  category_id: z.string().uuid(),
  manufacturer: trimmed(120).min(1),
  model: trimmed(120).min(1),
  serial_number: optionalTrimmed(120),
  license_plate: optionalTrimmed(40),
  location: optionalTrimmed(160),
  notes: optionalTrimmed(4000),
  supplier_id: optionalId,
  expected_arrival: z.string().trim().max(10).nullable().optional(),
  odometer_km: meter,
  operating_hours: hours,
});
export const VehicleUpdateSchema = VehicleCreateSchema.partial().extend({
  return_due: z.string().trim().max(10).nullable().optional(),
});

export const DamageLineSchema = z.object({
  description: trimmed(1000).min(1),
  severity: SeveritySchema.default("minor"),
  photo_ids: mediaIds,
});

const workflowBase = {
  odometer_km: meter,
  operating_hours: hours,
  notes: optionalTrimmed(4000),
  photo_ids: mediaIds,
  signature_id: z.string().uuid().nullable().optional(),
  send_copy_to: z.string().trim().max(200).default(""),
};

export const CheckInSchema = z.object({
  ...workflowBase,
  condition: ConditionSchema.default("ok"),
  damages: z.array(DamageLineSchema).max(20).default([]),
  location: optionalTrimmed(160),
  supplier_id: optionalId,
  license_plate: z.string().trim().max(40).optional(),
  serial_number: z.string().trim().max(120).optional(),
});

export const LoanCheckoutSchema = z.object({
  ...workflowBase,
  company_id: optionalId,
  driver_id: optionalId,
  borrower_name: trimmed(120).min(1),
  borrower_phone: optionalTrimmed(60),
  borrower_email: z.string().trim().max(200).default(""),
  expected_return_at: isoDate,
});

export const LoanReturnSchema = z.object({
  ...workflowBase,
  condition: ConditionSchema.default("ok"),
  damages: z.array(DamageLineSchema).max(20).default([]),
});

export const CheckOutSchema = z.object({
  ...workflowBase,
  company_id: optionalId,
  recipient_name: optionalTrimmed(120),
  condition: ConditionSchema.default("ok"),
  damages: z.array(DamageLineSchema).max(20).default([]),
  archive: z.boolean().default(false),
});

export const MaintenanceStartSchema = z.object({
  ...workflowBase,
  reason: trimmed(1000).min(1),
});

export const MaintenanceEndSchema = z.object({
  ...workflowBase,
  resolved_damage_ids: z.array(z.string().uuid()).max(50).default([]),
});

export const DamageReportSchema = DamageLineSchema.extend({
  mark_vehicle_damaged: z.boolean().default(true),
});

export const DamageResolveSchema = z.object({
  resolution_notes: optionalTrimmed(2000),
  photo_ids: mediaIds,
});

export const CorrectionSchema = z.object({
  status: VehicleStatusSchema,
  reason: trimmed(1000).min(3),
  cancel_active_loan: z.boolean().default(false),
});

export const ArchiveSchema = z.object({ reason: optionalTrimmed(500) });

export const ReturnDueSchema = z.object({ return_due: z.string().trim().max(10).nullable() });

export const SettingsSchema = z
  .object({
    org_name: trimmed(120).min(1),
    default_language: LanguageSchema,
    public_base_url: z.string().trim().max(300),
    min_photos_check_in: z.number().int().min(0).max(10),
    min_photos_loan: z.number().int().min(0).max(10),
    min_photos_return: z.number().int().min(0).max(10),
    min_photos_check_out: z.number().int().min(0).max(10),
    signature_required_check_in: z.boolean(),
    signature_required_return: z.boolean(),
    signature_required_check_out: z.boolean(),
    default_loan_days: z.number().int().min(1).max(365),
    public_qr_page: z.boolean(),
    email_enabled: z.boolean(),
    email_from: z.string().trim().max(200).refine((v) => v === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Invalid email"),
    overdue_digest_recipients: z.string().trim().max(1000),
    pdf_footer: z.string().trim().max(500),
  })
  .partial();

export const ImportCommitSchema = z.object({ only_valid: z.boolean().default(true) });

export const MediaCaptionSchema = z.object({ caption: optionalTrimmed(200) });

export type LoginInput = z.infer<typeof LoginSchema>;
export type UserCreateInput = z.infer<typeof UserCreateSchema>;
export type UserUpdateInput = z.infer<typeof UserUpdateSchema>;
export type CategoryInput = z.infer<typeof CategorySchema>;
export type CompanyInput = z.infer<typeof CompanySchema>;
export type DriverInput = z.infer<typeof DriverSchema>;
export type VehicleCreateInput = z.infer<typeof VehicleCreateSchema>;
export type VehicleUpdateInput = z.infer<typeof VehicleUpdateSchema>;
export type CheckInInput = z.infer<typeof CheckInSchema>;
export type LoanCheckoutInput = z.infer<typeof LoanCheckoutSchema>;
export type LoanReturnInput = z.infer<typeof LoanReturnSchema>;
export type CheckOutInput = z.infer<typeof CheckOutSchema>;
export type MaintenanceStartInput = z.infer<typeof MaintenanceStartSchema>;
export type MaintenanceEndInput = z.infer<typeof MaintenanceEndSchema>;
export type DamageReportInput = z.infer<typeof DamageReportSchema>;
export type DamageResolveInput = z.infer<typeof DamageResolveSchema>;
export type CorrectionInput = z.infer<typeof CorrectionSchema>;
export type SettingsInput = z.infer<typeof SettingsSchema>;
