import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { cx } from "./ui";

const Icon = {
  home: <path d="M3 11 12 3l9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1V11Z" />,
  truck: (
    <>
      <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  scan: (
    <>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
      <path d="M7 12h10" />
    </>
  ),
  handshake: <path d="M8 12 4 8l4-4M16 12l4 4-4 4M4 8h9a5 5 0 0 1 5 5v0M20 16h-9a5 5 0 0 1-5-5" />,
  doc: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 13h6M9 17h6" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </>
  ),
};

function I({ d, className }: { d: ReactNode; className?: string }) {
  return (
    <svg className={className ?? "h-6 w-6"} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {d}
    </svg>
  );
}

export function AppLayout() {
  const { t } = useT();
  const { me, can, logout } = useAuth();
  const nav = useNavigate();
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => setMoreOpen(false), [location.pathname]);

  const primary = [
    { to: "/", label: t("nav.dashboard"), icon: Icon.home, end: true },
    { to: "/vehicles", label: t("nav.vehicles"), icon: Icon.truck },
    { to: "/scan", label: t("nav.scan"), icon: Icon.scan, highlight: true },
    { to: "/loans", label: t("nav.loans"), icon: Icon.handshake },
    { to: "/documents", label: t("nav.documents"), icon: Icon.doc },
  ];
  const secondary = [
    { to: "/reservations", label: t("nav.reservations") },
    can("admin") && { to: "/import", label: t("nav.import") },
    { to: "/partners", label: t("nav.partners") },
    can("admin") && { to: "/categories", label: t("nav.categories") },
    can("admin") && { to: "/users", label: t("nav.users") },
    can("admin") && { to: "/audit", label: t("nav.audit") },
    can("super_admin") && { to: "/settings", label: t("nav.settings") },
    { to: "/profile", label: t("nav.profile") },
  ].filter(Boolean) as { to: string; label: string }[];

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cx("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition", isActive ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-slate-100");

  return (
    <div className="min-h-dvh bg-slate-50 lg:flex">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <div className="flex items-center gap-2 px-5 py-5">
          <img src="/favicon.svg" alt="" className="h-8 w-8" />
          <div>
            <div className="text-base font-bold leading-tight text-slate-900">{me?.settings.org_name || t("app.name")}</div>
            <div className="text-xs text-slate-500">{t("app.name")}</div>
          </div>
        </div>
        <nav className="flex-1 space-y-1 px-3">
          {primary.map((p) => (
            <NavLink key={p.to} to={p.to} end={p.end} className={linkClass}>
              <I d={p.icon} className="h-5 w-5" /> {p.label}
            </NavLink>
          ))}
          <div className="my-3 border-t border-slate-100" />
          {secondary.map((s) => (
            <NavLink key={s.to} to={s.to} className={linkClass}>
              {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-100 px-5 py-4 text-sm">
          <div className="truncate font-medium text-slate-800">{me?.name}</div>
          <div className="truncate text-xs text-slate-500">
            {me?.email} · {me && t(`role.${me.role}`)}
          </div>
          <button type="button" onClick={() => logout().then(() => nav("/login"))} className="mt-2 text-xs font-medium text-blue-700 hover:underline">
            {t("nav.logout")}
          </button>
        </div>
      </aside>

      <div className="flex min-h-dvh flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-200 bg-white/95 px-4 py-2.5 backdrop-blur lg:hidden" style={{ paddingTop: "calc(0.625rem + env(safe-area-inset-top))" }}>
          <NavLink to="/" className="flex items-center gap-2">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            <span className="text-base font-bold text-slate-900">{me?.settings.org_name || t("app.name")}</span>
          </NavLink>
          <button type="button" onClick={() => setMoreOpen(true)} aria-label={t("nav.more")} className="rounded-full p-2 text-slate-700 hover:bg-slate-100">
            <I d={Icon.more} />
          </button>
        </header>

        {!online && <div className="bg-amber-500 px-4 py-1.5 text-center text-xs font-medium text-white">{t("common.offline")}</div>}

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-4 lg:px-8 lg:pb-8">
          <Outlet />
        </main>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden" style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
          {primary.map((p) => (
            <NavLink
              key={p.to}
              to={p.to}
              end={p.end}
              className={({ isActive }) =>
                cx("flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium", isActive ? "text-blue-700" : "text-slate-500")
              }
            >
              {p.highlight ? (
                <span className="-mt-5 flex h-12 w-12 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg">
                  <I d={p.icon} />
                </span>
              ) : (
                <I d={p.icon} />
              )}
              {p.label}
            </NavLink>
          ))}
        </nav>
      </div>

      {/* Mobile "more" sheet */}
      {moreOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 lg:hidden" onClick={() => setMoreOpen(false)}>
          <div className="absolute inset-x-0 bottom-0 rounded-t-3xl bg-white p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 px-1 text-sm">
              <div className="font-semibold text-slate-900">{me?.name}</div>
              <div className="text-xs text-slate-500">
                {me?.email} · {me && t(`role.${me.role}`)}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {secondary.map((s) => (
                <NavLink key={s.to} to={s.to} className="rounded-xl border border-slate-200 px-3 py-3 text-sm font-medium text-slate-800 active:bg-slate-100">
                  {s.label}
                </NavLink>
              ))}
              <button type="button" onClick={() => logout().then(() => nav("/login"))} className="rounded-xl border border-red-200 px-3 py-3 text-left text-sm font-medium text-red-700">
                {t("nav.logout")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
