"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  ListChecks,
  Heart,
  MessageSquare,
  Megaphone,
  Activity,
  Users,
  FolderKanban,
  UserCog,
  ChevronsLeft,
  ChevronDown,
  Droplets,
  Wind,
  Tornado,
  Mountain,
  Trees,
  Flame,
  Rocket,
  Archive,
  type LucideIcon,
} from "lucide-react";
import { getElementForPath, ELEMENT_GLOW, DEFAULT_GLOW } from "@/lib/elements";
import ProxyBalance from "@/components/ProxyBalance";

type NavItem = { href: string; label: string; icon: LucideIcon };
type NavSection = {
  key: string;
  label: string;
  icon?: LucideIcon;
  accentText: string;
  accentBg: string;
  accentSolid: string;
  collapsible: boolean;
  items: NavItem[];
};

// Clases completas y literales a propósito (no interpoladas): el scanner de
// Tailwind necesita verlas escritas tal cual en el código para generarlas.
const DEFAULT_ACCENT = { accentText: "text-primary", accentBg: "bg-primary/10", accentSolid: "bg-primary" };

const NAV_SECTIONS: NavSection[] = [
  {
    key: "general",
    label: "General",
    collapsible: false,
    ...DEFAULT_ACCENT,
    items: [{ href: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    key: "agua",
    label: "Agua",
    icon: Droplets,
    collapsible: true,
    accentText: "text-agua",
    accentBg: "bg-agua/10",
    accentSolid: "bg-agua",
    items: [
      { href: "/campanas", label: "Campañas", icon: FolderKanban },
      { href: "/tasks", label: "Tareas", icon: ListChecks },
      { href: "/tasks/like", label: "Likes", icon: Heart },
      { href: "/tasks/comment", label: "Comentar", icon: MessageSquare },
      { href: "/tasks/post", label: "Publicar", icon: Megaphone },
    ],
  },
  {
    key: "viento",
    label: "Viento",
    icon: Wind,
    collapsible: true,
    accentText: "text-series-1",
    accentBg: "bg-series-1/10",
    accentSolid: "bg-series-1",
    items: [{ href: "/scrapping", label: "Scrapping", icon: Tornado }],
  },
  {
    key: "tierra",
    label: "Tierra",
    icon: Mountain,
    collapsible: true,
    accentText: "text-series-6",
    accentBg: "bg-series-6/10",
    accentSolid: "bg-series-6",
    items: [{ href: "/actividades", label: "Actividades", icon: Trees }],
  },
  {
    key: "fuego",
    label: "Fuego",
    icon: Flame,
    collapsible: true,
    accentText: "text-critical",
    accentBg: "bg-critical/10",
    accentSolid: "bg-critical",
    items: [{ href: "/dia-d", label: "Día D", icon: Rocket }],
  },
  {
    key: "recursos",
    label: "Recursos",
    icon: Archive,
    collapsible: true,
    ...DEFAULT_ACCENT,
    items: [
      { href: "/profiles", label: "Perfiles", icon: Users },
      { href: "/groups", label: "Grupos", icon: FolderKanban },
      { href: "/profiles/auto-profile", label: "Auto Profile", icon: UserCog },
      { href: "/tasks/warmup", label: "Warmup", icon: Activity },
    ],
  },
];

// El label solo aparece luego de que el ancho terminó de animar (~200ms):
// mostrarlo de inmediato al expandir hace que el texto se monte a su ancho
// natural mientras el <aside> todavía está angosto y se ve "chocado".
const EXPAND_LABEL_DELAY = 180;

// El toggle de tema (ThemeToggle) muta la clase "dark" en <html> directo por
// DOM, sin pasar por React — un MutationObserver es la forma más simple de
// enterarse del cambio sin tener que levantar un context/provider solo para
// esto.
function useIsDark() {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    setIsDark(root.classList.contains("dark"));

    const observer = new MutationObserver(() => setIsDark(root.classList.contains("dark")));
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export default function Sidebar() {
  const pathname = usePathname();
  const isDark = useIsDark();
  const [collapsed, setCollapsed] = useState(false);
  const [showLabels, setShowLabels] = useState(true);
  const [mounted, setMounted] = useState(false);
  const [closedSections, setClosedSections] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const stored = localStorage.getItem("sidebar-collapsed") === "true";
    setCollapsed(stored);
    setShowLabels(!stored);
    try {
      const storedSections = JSON.parse(localStorage.getItem("sidebar-closed-sections") ?? "{}");
      setClosedSections(storedSections);
    } catch {
      // ignore malformed value
    }
    setMounted(true);
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem("sidebar-collapsed", String(next));
    if (next) {
      setShowLabels(false);
    } else {
      setTimeout(() => setShowLabels(true), EXPAND_LABEL_DELAY);
    }
  }

  function toggleSection(key: string) {
    setClosedSections((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem("sidebar-closed-sections", JSON.stringify(next));
      return next;
    });
  }

  // Un href puede ser prefijo de otro (ej. /tasks y /tasks/comment): solo el
  // match más específico (el más largo) queda marcado como activo, así una
  // subpágina no enciende también el ítem de su padre.
  const activeHref = useMemo(() => {
    const allHrefs = NAV_SECTIONS.flatMap((s) => s.items.map((i) => i.href));
    let best: string | null = null;
    for (const href of allHrefs) {
      const matches = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
      if (matches && (!best || href.length > best.length)) best = href;
    }
    return best;
  }, [pathname]);

  const glowColor = ELEMENT_GLOW[getElementForPath(pathname) as keyof typeof ELEMENT_GLOW] ?? DEFAULT_GLOW;

  return (
    <aside
      className={`sticky top-0 flex h-screen shrink-0 flex-col overflow-hidden border-r border-hairline bg-surface/80 backdrop-blur-md transition-[width] duration-200 ${
        collapsed ? "w-19" : "w-64"
      } ${mounted ? "" : "invisible"}`}
    >
      <div
        key={glowColor}
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 hidden opacity-0 transition-opacity duration-500 dark:block dark:opacity-100"
        style={{
          backgroundImage: `radial-gradient(420px circle at 0% 100%, color-mix(in oklab, ${glowColor} 45%, transparent), transparent 70%)`,
        }}
      />

      <div className={`flex gap-2.5 py-5 ${collapsed ? "flex-col items-center px-2" : "items-center px-5"}`}>
        <div className="relative flex h-9 w-9 shrink-0 items-center justify-center">
          <Image
            src={isDark ? "/media/logo.png" : "/media/logoblack.png"}
            alt="Ojo de Dios"
            width={36}
            height={36}
            className="object-contain"
            priority
          />
        </div>
        {showLabels && (
          <div className="animate-fade-in-up min-w-0 flex-1 overflow-hidden">
            <p className="truncate text-sm font-semibold tracking-tight text-ink">Ojo de Dios</p>
            <p className="truncate text-xs text-ink-muted">By AgentIQ</p>
          </div>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? "Expandir menú" : "Colapsar menú"}
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-page hover:text-ink ${collapsed ? "" : "ml-auto"}`}
        >
          <ChevronsLeft className={`h-4 w-4 transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`} />
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-4 overflow-y-auto px-3 pb-6">
        {NAV_SECTIONS.map((section) => {
          const SectionIcon = section.icon;
          const isOpen = !closedSections[section.key];
          const showHeader = showLabels && section.icon;

          return (
            <div key={section.key} className="flex flex-col gap-1">
              {showHeader && SectionIcon ? (
                <button
                  type="button"
                  onClick={() => section.collapsible && toggleSection(section.key)}
                  className="animate-fade-in-up flex items-center gap-2 px-3 pb-1 text-left"
                >
                  <SectionIcon className={`h-3.5 w-3.5 shrink-0 ${section.accentText}`} />
                  <span className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                    {section.label}
                  </span>
                  {section.collapsible && (
                    <ChevronDown
                      className={`h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                    />
                  )}
                </button>
              ) : (
                showLabels && (
                  <p className="animate-fade-in-up px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
                    {section.label}
                  </p>
                )
              )}

              <div
                className={`grid transition-[grid-template-rows] duration-200 ${
                  showLabels && !isOpen ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
                }`}
              >
                <div className="flex flex-col gap-1 overflow-hidden">
                  {section.items.map((item) => {
                    const active = item.href === activeHref;
                    const Icon = item.icon;
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        title={collapsed ? item.label : undefined}
                        className={`group relative flex items-center gap-3 rounded-lg py-2 text-sm font-medium transition-colors ${
                          showLabels ? "pl-7 pr-3" : "px-3"
                        } ${active ? `${section.accentBg} ${section.accentText}` : "text-ink-secondary hover:bg-page hover:text-ink"}`}
                      >
                        {active && <span className={`absolute left-3 h-5 w-0.5 rounded-full ${section.accentSolid}`} />}
                        <Icon className={`h-4 w-4 shrink-0 ${active ? section.accentText : "text-ink-muted group-hover:text-ink"}`} />
                        {showLabels && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </nav>

      <ProxyBalance collapsed={collapsed} />
    </aside>
  );
}
