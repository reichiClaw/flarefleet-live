import type { MeterMode, Role, VehicleCapabilities, VehicleStatus } from "./types";
import { hasRole } from "./types";

// Allowed status transitions (workflow-owned). Admin correction is separate.
export const TRANSITIONS: Record<VehicleStatus, VehicleStatus[]> = {
  announced: ["available", "damaged"],
  available: ["loaned", "damaged", "maintenance", "checked_out"],
  loaned: ["available", "damaged", "maintenance"],
  damaged: ["available", "maintenance", "checked_out"],
  maintenance: ["available", "damaged", "checked_out"],
  checked_out: ["archived"],
  archived: ["checked_out"],
};

export function canTransition(from: VehicleStatus, to: VehicleStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function meterRequirements(mode: MeterMode) {
  return {
    odometer: mode === "odometer" || mode === "both",
    hours: mode === "hours" || mode === "both",
  };
}

export interface VehicleStateForCaps {
  status: VehicleStatus;
  has_active_loan: boolean;
  open_damage_count: number;
}

export function vehicleCapabilities(role: Role, v: VehicleStateForCaps): VehicleCapabilities {
  const admin = hasRole(role, "admin");
  const s = v.status;
  const noLoan = !v.has_active_loan;
  return {
    check_in: s === "announced",
    loan: s === "available" && noLoan,
    return: s === "loaned" && v.has_active_loan,
    check_out: (s === "available" || s === "damaged" || s === "maintenance") && noLoan,
    maintenance_start: (s === "available" || s === "damaged") && noLoan,
    maintenance_end: s === "maintenance",
    report_damage: s !== "announced" && s !== "archived" && s !== "checked_out",
    resolve_damage: v.open_damage_count > 0 && s !== "archived",
    archive: admin && s === "checked_out",
    unarchive: admin && s === "archived",
    correct: admin && s !== "archived",
    edit: admin && s !== "archived",
    // A vehicle still to be delivered or currently on loan can be planned for
    // later; one that has left the fleet cannot.
    reserve: s !== "checked_out" && s !== "archived",
  };
}

// Generate a human readable QR code that is not a database id.
const QR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function randomQrCode(random: (n: number) => Uint8Array): string {
  const bytes = random(10);
  let out = "VH-";
  for (let i = 0; i < 10; i++) out += QR_ALPHABET[bytes[i] % QR_ALPHABET.length];
  return out;
}

export function formatInternalNumber(n: number): string {
  return `FZ-${String(n).padStart(5, "0")}`;
}

export const PROTOCOL_PREFIX: Record<string, string> = {
  check_in: "CI",
  loan_checkout: "LC",
  loan_return: "LR",
  check_out: "CO",
  maintenance_start: "MS",
  maintenance_end: "ME",
  damage_resolved: "DR",
  status_correction: "SC",
};
