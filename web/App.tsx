import { type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import type { Role } from "@shared/types";
import { useAuth } from "./lib/auth";
import { I18nProvider, detectLanguage, useT } from "./lib/i18n";
import { Loading } from "./components/ui";
import { AppLayout } from "./components/Layout";
import { ForgotPasswordPage, LoginPage, ResetPasswordPage, SetupPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { VehiclesPage } from "./pages/Vehicles";
import { VehicleFormPage } from "./pages/VehicleForm";
import { VehicleDetailPage } from "./pages/VehicleDetail";
import { CheckInPage, CheckOutPage, CorrectionPage, LoanPage, MaintenanceEndPage, MaintenanceStartPage, ReturnPage } from "./pages/workflows";
import { DocumentsPage, ProtocolDetailPage } from "./pages/Documents";
import { LoansPage } from "./pages/Loans";
import { ReservationsPage } from "./pages/Reservations";
import { PublicQrPage, ScanPage } from "./pages/Scan";
import { ImportPage } from "./pages/Import";
import { PartnersPage } from "./pages/Partners";
import { CategoriesPage } from "./pages/Categories";
import { UsersPage } from "./pages/Users";
import { SettingsPage } from "./pages/Settings";
import { AuditPage } from "./pages/Audit";
import { ProfilePage } from "./pages/Profile";

function RequireAuth({ children, min }: { children: ReactNode; min?: Role }) {
  const { me, loading, can } = useAuth();
  const location = useLocation();
  const { t } = useT();
  if (loading) return <Loading />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (me.must_change_password && !location.pathname.startsWith("/profile")) return <Navigate to="/profile?force=1" replace />;
  if (min && !can(min)) return <div className="p-8 text-center text-slate-600">{t("error.forbidden")}</div>;
  return <>{children}</>;
}

function NotFound() {
  const { t } = useT();
  return <div className="p-8 text-center text-slate-600">{t("error.not_found")}</div>;
}

export function App() {
  const { me } = useAuth();
  const lang = me?.language ?? detectLanguage();
  return (
    <I18nProvider lang={lang}>
      <BrowserRouter future={{ v7_relativeSplatPath: true, v7_startTransition: true }}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/q/:code" element={<PublicQrPage />} />

          <Route
            element={
              <RequireAuth>
                <AppLayout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<DashboardPage />} />
            <Route path="/vehicles" element={<VehiclesPage />} />
            <Route path="/vehicles/new" element={<RequireAuth min="admin"><VehicleFormPage /></RequireAuth>} />
            <Route path="/vehicles/:id" element={<VehicleDetailPage />} />
            <Route path="/vehicles/:id/edit" element={<RequireAuth min="admin"><VehicleFormPage /></RequireAuth>} />
            <Route path="/vehicles/:id/check-in" element={<CheckInPage />} />
            <Route path="/vehicles/:id/loan" element={<LoanPage />} />
            <Route path="/vehicles/:id/return" element={<ReturnPage />} />
            <Route path="/vehicles/:id/check-out" element={<CheckOutPage />} />
            <Route path="/vehicles/:id/maintenance/start" element={<MaintenanceStartPage />} />
            <Route path="/vehicles/:id/maintenance/end" element={<MaintenanceEndPage />} />
            <Route path="/vehicles/:id/correct" element={<RequireAuth min="admin"><CorrectionPage /></RequireAuth>} />
            <Route path="/scan" element={<ScanPage />} />
            <Route path="/loans" element={<LoansPage />} />
            <Route path="/reservations" element={<ReservationsPage />} />
            <Route path="/documents" element={<DocumentsPage />} />
            <Route path="/documents/:id" element={<ProtocolDetailPage />} />
            <Route path="/import" element={<RequireAuth min="admin"><ImportPage /></RequireAuth>} />
            <Route path="/partners" element={<PartnersPage />} />
            <Route path="/categories" element={<RequireAuth min="admin"><CategoriesPage /></RequireAuth>} />
            <Route path="/users" element={<RequireAuth min="admin"><UsersPage /></RequireAuth>} />
            <Route path="/audit" element={<RequireAuth min="admin"><AuditPage /></RequireAuth>} />
            <Route path="/settings" element={<RequireAuth min="super_admin"><SettingsPage /></RequireAuth>} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </I18nProvider>
  );
}
