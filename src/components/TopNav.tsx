"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  Activity,
  ChevronDown,
  FolderKanban,
  GitBranch,
  Heart,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Megaphone,
  Menu,
  MessageCircleHeart,
  MessageSquare,
  MonitorPlay,
  PencilLine,
  PhoneCall,
  Radar,
  ShieldCheck,
  SlidersHorizontal,
  UserCog,
  UserPlus,
  Users,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import { useSession } from "@/lib/session";
import { isClienteRole, ROLE_LABELS } from "@/lib/auth/roles";
import { findCity } from "@/lib/timezones";
import { sidebarStyle } from "@/lib/theme";
import { BRAND_NAME, BRAND_SUBTITLE } from "@/lib/brand";

// `adminOnly` solo esconde el enlace: quien lo adivine igual choca contra el
// 403 de withAdmin en la API. La seguridad está allá, esto es prolijidad.
type NavItem = { href: string; label: string; hint: string; icon: LucideIcon; adminOnly?: boolean };
type NavSection = { key: string; label: string; code: string; items: NavItem[] };

/**
 * El menú va arriba y por secciones. Una sección de un solo ítem es una
 * pestaña directa; las demás abren un submenú al pasar el mouse.
 *
 * `code` es la etiqueta corta de instrumento que se ve en el submenú
 * ("SEC-02"); es decoración, no se usa para nada más.
 *
 * Tierra (/actividades) y Fuego (/dia-d) siguen fuera del menú a pedido. Las
 * páginas existen y responden si se entra por URL; para devolverlas basta con
 * reponer sus ítems acá.
 */
const NAV: NavSection[] = [
  {
    key: "panel",
    label: "Panel",
    code: "SEC-01",
    items: [{ href: "/", label: "Dashboard", hint: "Resumen de la operación", icon: LayoutDashboard }],
  },
  {
    key: "publicar",
    label: "Publicar",
    code: "SEC-02",
    items: [
      { href: "/campanas", label: "Campañas", hint: "Avance y control de cada campaña", icon: FolderKanban },
      { href: "/tasks", label: "Tareas", hint: "Cola de ejecución y su detalle", icon: ListChecks },
      { href: "/tasks/like", label: "Likes", hint: "Reacciones a una publicación", icon: Heart },
      { href: "/tasks/likecomment", label: "Likes a comentarios", hint: "Reacciones a comentarios", icon: MessageCircleHeart },
      { href: "/tasks/comment", label: "Comentar", hint: "Comentarios desde el banco", icon: MessageSquare },
      { href: "/tasks/ramificacion", label: "Ramificaciones", hint: "Hilos de respuestas", icon: GitBranch },
      { href: "/tasks/unirse-grupo", label: "Unirse a grupos", hint: "Solicitudes a grupos de Facebook", icon: UsersRound },
      { href: "/tasks/follow", label: "Seguir perfiles", hint: "Seguir cuentas de Facebook", icon: UserPlus },
      { href: "/tasks/post", label: "Publicar", hint: "Publicaciones desde perfiles", icon: Megaphone },
    ],
  },
  {
    key: "scrapping",
    label: "Scrapping",
    code: "SEC-03",
    items: [{ href: "/scrapping", label: "Escucha", hint: "Menciones y conversación en redes", icon: Radar }],
  },
  {
    key: "encuestas",
    label: "Encuestas",
    code: "SEC-04",
    items: [
      { href: "/encuestas", label: "Tablero", hint: "Llamadas con la asistente de voz y resultados", icon: PhoneCall },
      { href: "/encuestas/base", label: "Base de teléfonos", hint: "La lista a la que llama la asistente", icon: Users },
      { href: "/encuestas/guion", label: "Guion", hint: "Lo que dice la asistente, palabra por palabra", icon: PencilLine },
    ],
  },
  {
    key: "recursos",
    label: "Recursos",
    code: "SEC-05",
    items: [
      { href: "/profiles", label: "Perfiles", hint: "Perfiles de AdsPower", icon: Users },
      { href: "/groups", label: "Grupos", hint: "Grupos y sincronización", icon: FolderKanban },
      { href: "/profiles/auto-profile", label: "Auto Profile", hint: "Completar perfiles en lote", icon: UserCog },
      { href: "/tasks/warmup", label: "Warmup", hint: "Calentamiento de cuentas", icon: Activity },
      { href: "/ajustes", label: "Ajustes", hint: "Apariencia, hora, marca y motores", icon: SlidersHorizontal },
      { href: "/usuarios", label: "Usuarios", hint: "Accesos y actividad por usuario", icon: ShieldCheck, adminOnly: true },
    ],
  },
];

/** Cuánto espera el submenú antes de cerrarse al salir el mouse. */
const CLOSE_DELAY_MS = 140;
const POLL_MS = 10000;

type RoleStatus = { online: boolean; host?: string | null };
type Status = { online: boolean; roles?: { tasks: RoleStatus; listening: RoleStatus } } | null;

/**
 * Los dos workers pueden vivir en máquinas distintas —la automatización donde
 * está AdsPower, la escucha en el VPS— así que el chip tiene tres estados. Uno
 * solo diría "SIN WORKER" con la escucha funcionando perfectamente.
 */
function workerChip(status: NonNullable<Status>) {
  const tasks = status.roles?.tasks.online ?? status.online;
  const listening = status.roles?.listening.online ?? status.online;
  if (tasks && listening) return { label: "EN VIVO", off: false, title: "Automatización y escucha corriendo" };
  if (listening)
    return {
      label: "SOLO ESCUCHA",
      off: true,
      title: "La escucha ingiere sola, pero no hay worker de automatización: las tareas en cola no avanzarán",
    };
  if (tasks)
    return {
      label: "SOLO TAREAS",
      off: true,
      title: "La automatización corre, pero nadie está ingiriendo menciones: la escucha solo avanzará con «Buscar ahora»",
    };
  return { label: "SIN WORKER", off: true, title: "No hay ningún worker corriendo" };
}

/**
 * Reloj de sala: hora y minutos en la ciudad que eligió el usuario. La zona
 * sale de la preferencia y no del reloj de la máquina, porque el VPS corre en
 * UTC. Sin segundos: son ruido en una barra que se mira de reojo.
 */
function useClock(timeZone: string) {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const paint = () =>
      setNow(new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone }));
    paint();
    const id = setInterval(paint, 15000);
    return () => clearInterval(id);
  }, [timeZone]);
  // null hasta que hidrata: la hora del servidor y la del cliente no
  // coinciden nunca, así que pintarla en SSR sería un error de hidratación.
  return now;
}

/** ThemeToggle cambia la clase "dark" por DOM; esto se entera sin un provider. */
function useIsDark() {
  const [isDark, setIsDark] = useState(true);
  useEffect(() => {
    const root = document.documentElement;
    setIsDark(root.classList.contains("dark"));
    const observer = new MutationObserver(() => setIsDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return isDark;
}

function useWorkerStatus() {
  const [status, setStatus] = useState<Status>(null);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch("/api/worker/status");
        const data = await res.json();
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus({ online: false });
      }
    }
    check();
    const interval = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);
  return status;
}

export default function TopNav() {
  const pathname = usePathname() ?? "/";
  const session = useSession();
  const isDark = useIsDark();
  const status = useWorkerStatus();
  const city = findCity(session?.preferences.city);
  const clock = useClock(city.timeZone);

  const [open, setOpen] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // El cliente tiene una sola página y ningún lado a donde ir: no lleva menú,
  // solo la franja de estado, que es donde vive el botón de cerrar sesión. Y
  // le va la marca de la casa y punto: no tiene Ajustes donde cambiarla.
  const cliente = isClienteRole(session?.role);
  const prefs = session?.preferences;
  const title = cliente ? BRAND_NAME : prefs?.brandTitle?.trim() || BRAND_NAME;
  const subtitle = cliente ? BRAND_SUBTITLE : prefs?.brandSubtitle?.trim() || BRAND_SUBTITLE;
  const avatar = prefs?.avatar || "";

  const sections = useMemo(
    () =>
      cliente
        ? []
        : NAV.map((section) => ({
            ...section,
            items: section.items.filter((item) => !item.adminOnly || session?.role === "admin"),
          })).filter((section) => section.items.length > 0),
    [session, cliente],
  );

  // Un href puede ser prefijo de otro (/tasks y /tasks/comment): solo el
  // match más largo queda activo, así una subpágina no enciende a su padre.
  const activeHref = useMemo(() => {
    let best: string | null = null;
    for (const href of NAV.flatMap((s) => s.items.map((i) => i.href))) {
      const matches = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
      if (matches && (!best || href.length > best.length)) best = href;
    }
    return best;
  }, [pathname]);

  const activeSection = sections.find((s) => s.items.some((i) => i.href === activeHref));
  const activeItem = activeSection?.items.find((i) => i.href === activeHref);

  // Navegar cierra todo: el submenú abierto por hover quedaría flotando sobre
  // la página nueva.
  useEffect(() => {
    setOpen(null);
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(null);
        setMobileOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function openNow(key: string) {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(key);
  }

  // Con un pequeño retraso: el mouse cruza el hueco entre el botón y el panel,
  // y sin esto el submenú se cerraría justo cuando la persona va a entrar.
  function closeSoon() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(null), CLOSE_DELAY_MS);
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // Recarga completa: hay estado de cliente del usuario saliente que no debe
    // sobrevivir al cambio de sesión.
    window.location.href = "/login";
  }

  const chip = status ? workerChip(status) : null;

  return (
    <header style={sidebarStyle(prefs?.sidebarColor)} className="hud-header sticky top-0 z-30 shrink-0">
      {/* --- Franja de estado --- */}
      <div className="flex items-center gap-3 px-4 py-2 sm:px-6">
        <Link href={cliente ? pathname : "/"} className="group flex min-w-0 items-center gap-2.5">
          <span className="hud-logo relative grid h-9 w-9 shrink-0 place-items-center">
            {avatar ? (
              // La foto viaja como data URI: no pasa por el optimizador.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={avatar} alt={title} className="h-8 w-8 rounded-[3px] object-cover" />
            ) : (
              <Image
                src={isDark ? "/media/logo.png" : "/media/logoblack.png"}
                alt={title}
                width={32}
                height={32}
                className="object-contain"
                priority
              />
            )}
          </span>
          <span className="min-w-0">
            <span className="hud-brand block truncate">{title}</span>
            {subtitle && <span className="label-mono-sm block truncate">{subtitle}</span>}
          </span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          <span className="classchip hidden md:inline-flex">USO INTERNO</span>

          {/* Al cliente solo la hora, sin la ciudad: él no tiene Ajustes donde
              elegirla y vería siempre la de la casa. */}
          {clock && (
            <span
              title={cliente ? `Hora en ${city.label}, ${city.state}` : `Hora en ${city.label}, ${city.state} · se cambia en Ajustes`}
              className="hud-readout hidden md:inline-flex"
            >
              {!cliente && <span className="text-ink-muted">{city.label.toUpperCase()}</span>} {clock}
            </span>
          )}

          {chip && (
            <span title={chip.title} className={`opchip ${chip.off ? "is-off" : ""}`}>
              <i />
              {chip.label}
            </span>
          )}

          {/* Ventana al escritorio del VPS, en otra pestaña para poder seguir
              usando el panel al lado. Solo admin, porque desde ahí se maneja
              AdsPower entero. */}
          {session?.role === "admin" && (
            <a
              href="/vnc"
              target="_blank"
              rel="noopener noreferrer"
              title="Ver la pantalla del VPS donde corre AdsPower · se abre en otra pestaña"
              aria-label="Abrir la pantalla de AdsPower en otra pestaña"
              className="hud-iconbtn hidden sm:grid"
            >
              <MonitorPlay size={14} />
            </a>
          )}

          <ThemeToggle />

          {session && (
            <div className={`items-center gap-1.5 border-l border-hairline pl-2.5 ${cliente ? "flex" : "hidden sm:flex"}`}>
              {/* El cliente no tiene Ajustes, así que su nombre no es enlace:
                  lo mandaría a una página que el proxy le rebota. */}
              {cliente ? (
                <span title={ROLE_LABELS[session.role]} className="hud-readout">
                  {session.username}
                </span>
              ) : (
                <Link
                  href="/ajustes"
                  title={`${ROLE_LABELS[session.role]} · ir a Ajustes`}
                  className="hud-readout transition-colors hover:text-ink"
                >
                  {session.username}
                  {session.role === "admin" && <span className="ml-1 text-gold">·admin</span>}
                </Link>
              )}
              <button type="button" onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión" className="hud-iconbtn">
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          {!cliente && (
            <button
              type="button"
              onClick={() => setMobileOpen((v) => !v)}
              aria-label={mobileOpen ? "Cerrar menú" : "Abrir menú"}
              aria-expanded={mobileOpen}
              className="hud-iconbtn lg:hidden"
            >
              {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>

      {/* --- Menú por secciones, con submenú al pasar el mouse --- */}
      {sections.length > 0 && (
        <nav className="hud-nav hidden items-stretch gap-1 px-4 sm:px-6 lg:flex" aria-label="Navegación principal">
          {sections.map((section) => {
            const isActive = section.key === activeSection?.key;
            const isOpen = open === section.key;

            if (section.items.length === 1) {
              const item = section.items[0];
              return (
                <Link
                  key={section.key}
                  href={item.href}
                  className={`hud-tab ${isActive ? "is-active" : ""}`}
                  onMouseEnter={() => setOpen(null)}
                >
                  <item.icon className="h-3.5 w-3.5" />
                  {/* Si quedó de un ítem porque al rol no le tocan los demás
                      (Encuestas para un operador), la pestaña lleva el nombre de
                      la sección: "Tablero" a secas no dice de qué. */}
                  {(NAV.find((s) => s.key === section.key)?.items.length ?? 1) > 1 ? section.label : item.label}
                </Link>
              );
            }

            return (
              <div
                key={section.key}
                className="relative"
                onMouseEnter={() => openNow(section.key)}
                onMouseLeave={closeSoon}
              >
                <button
                  type="button"
                  className={`hud-tab ${isActive ? "is-active" : ""} ${isOpen ? "is-open" : ""}`}
                  aria-haspopup="true"
                  aria-expanded={isOpen}
                  onClick={() => (isOpen ? setOpen(null) : openNow(section.key))}
                  onFocus={() => openNow(section.key)}
                >
                  {section.label}
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`} />
                </button>

                {isOpen && (
                  <div
                    className="hud-dropdown"
                    role="menu"
                    onBlur={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) closeSoon();
                    }}
                  >
                    <p className="hud-dropdown-head">
                      <span>{section.code}</span>
                      <span>{section.label}</span>
                      <span className="ml-auto">{section.items.length} módulos</span>
                    </p>
                    <div className="grid gap-1 sm:grid-cols-2">
                      {section.items.map((item) => {
                        const Icon = item.icon;
                        const active = item.href === activeHref;
                        return (
                          <Link key={item.href} href={item.href} role="menuitem" className={`hud-menuitem ${active ? "is-active" : ""}`}>
                            <span className="hud-menuitem-ic">
                              <Icon className="h-4 w-4" />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] font-semibold text-ink">{item.label}</span>
                              <span className="block truncate text-[11px] text-ink-muted">{item.hint}</span>
                            </span>
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {/* Dónde estoy: sección y página en lectura de instrumento */}
          {activeSection && (
            <span className="hud-path ml-auto hidden xl:inline-flex">
              {activeSection.code} <span className="text-ink-muted">{"//"}</span> {activeItem?.label}
            </span>
          )}
        </nav>
      )}

      {/* --- Menú móvil: todas las secciones desplegadas --- */}
      {mobileOpen && sections.length > 0 && (
        <nav className="hud-mobile lg:hidden" aria-label="Navegación principal">
          {sections.map((section) => (
            <div key={section.key} className="flex flex-col gap-1">
              <p className="label-mono px-1 pt-2">
                {section.code} · {section.label}
              </p>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link key={item.href} href={item.href} className={`hud-menuitem ${item.href === activeHref ? "is-active" : ""}`}>
                    <span className="hud-menuitem-ic">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="truncate text-[13px] font-semibold text-ink">{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
          {session && (
            <button type="button" onClick={logout} className="tbtn mt-3 inline-flex items-center justify-center gap-1.5">
              <LogOut className="h-3.5 w-3.5" /> Cerrar sesión · {session.username}
            </button>
          )}
        </nav>
      )}
    </header>
  );
}
