import Link from "next/link";
import { Users } from "lucide-react";
import EncuestaContactoModel from "@/lib/models/EncuestaContacto";
import { dbConnect } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/encuestas/acceso";
import { ESTADOS_LLAMADA } from "@/lib/encuestas/llamadas";
import { estadoBase } from "@/lib/encuestas/base";
import { fechaHoraCorta } from "@/lib/encuestas/fechas";
import { Carta, Pastilla, Aviso, n, INPUT, LABEL, BTN, BTN_PRIMARY } from "@/components/encuestas/ui";
import PageHeader from "@/components/ui/PageHeader";
import { BRAND_NAME } from "@/lib/brand";
import { subirBase } from "../acciones";

export const dynamic = "force-dynamic";
export const metadata = { title: `Base de teléfonos · ${BRAND_NAME}` };

/**
 * LA BASE, CON NOMBRE Y NÚMERO. Es la lista que se subió para llamar: quién está, cómo le fue y cuántas veces se le marcó.
 * Admin y operador. Aquí no se enseña qué contestó cada quien: eso vive en las encuestas, sin nombre.
 */
const POR_PAGINA = 50;
const ROTULO: Record<string, string> = { PENDIENTE: "Sin llamar", NO_LLAMAR: "Pidió que no le llamen", ...Object.fromEntries(Object.entries(ESTADOS_LLAMADA).map(([k, v]) => [k, v.label])) };
const COLOR: Record<string, string> = { PENDIENTE: "var(--primary)", NO_LLAMAR: "var(--status-critical)", ...Object.fromEntries(Object.entries(ESTADOS_LLAMADA).map(([k, v]) => [k, v.color])) };
const tel = (t: string) => `${t.slice(0, 3)} ${t.slice(3, 6)} ${t.slice(6)}`;
/** Lo que se escribe en el buscador va a una expresión regular: se escapa para que «(» o «.» se busquen tal cual. */
const literal = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Fila = { _id: unknown; telefono: string; nombre: string | null; colonia: string | null; origen: string | null; estado: string; intentos: number; ultimoIntento: Date | null };

export default async function Base({ searchParams }: { searchParams: Promise<{ q?: string; estado?: string; p?: string; ok?: string; error?: string }> }) {
  const { q = "", estado = "", p = "1", ok, error } = await searchParams;
  await requireAdmin();
  await dbConnect();
  const pagina = Math.max(1, parseInt(p) || 1);
  const busca = q.trim();
  const digitos = busca.replace(/\D/g, "");
  const where: Record<string, unknown> = {
    ...(estado ? { estado } : {}),
    ...(busca
      ? {
          $or: [
            { nombre: { $regex: literal(busca), $options: "i" } },
            { colonia: { $regex: literal(busca), $options: "i" } },
            ...(digitos.length >= 3 ? [{ telefono: { $regex: digitos } }] : []),
          ],
        }
      : {}),
  };
  const [base, total, filas] = await Promise.all([
    estadoBase(),
    EncuestaContactoModel.countDocuments(where),
    EncuestaContactoModel.find(where).sort({ createdAt: -1, _id: 1 }).skip((pagina - 1) * POR_PAGINA).limit(POR_PAGINA).lean<Fila[]>(),
  ]);
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const liga = (cambio: Record<string, string>) => {
    const u = new URLSearchParams({ ...(busca ? { q: busca } : {}), ...(estado ? { estado } : {}), ...cambio });
    for (const [k, v] of [...u.entries()]) if (!v) u.delete(k);
    const t = u.toString();
    return `/encuestas/base${t ? `?${t}` : ""}`;
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<Users className="h-4 w-4" />}
        title="La base de teléfonos"
        subtitle={`${n(base.total)} personas cargadas · la lista a la que llama la asistente, con cómo le fue a cada quien`}
        right={<Link href="/encuestas" className={BTN}>← Volver al tablero</Link>}
      />

      <Aviso ok={ok} error={error} />

      <Carta>
        <form className="flex flex-wrap items-end gap-3" action="/encuestas/base">
          <div className="min-w-[220px] flex-1">
            <label className={LABEL} htmlFor="q">Buscar por nombre, teléfono o colonia</label>
            <input id="q" name="q" defaultValue={busca} placeholder="Ej. García · 686 123 · Pueblo Nuevo" className={INPUT} />
          </div>
          {estado && <input type="hidden" name="estado" value={estado} />}
          <button className={BTN_PRIMARY}>Buscar</button>
          {(busca || estado) && <Link href="/encuestas/base" className="pb-2.5 text-[13px] font-semibold text-ink-muted underline">Quitar filtros</Link>}
        </form>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={liga({ estado: "", p: "" })}><Pastilla color={!estado ? "var(--primary)" : "var(--text-muted)"}>Todos: {n(base.total)}</Pastilla></Link>
          {Object.entries(base.porEstado).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
            <Link key={k} href={liga({ estado: estado === k ? "" : k, p: "" })} className={estado === k ? "rounded-md ring-2 ring-current" : ""} style={estado === k ? { color: COLOR[k] } : undefined}>
              <Pastilla color={COLOR[k] ?? "var(--text-muted)"}>{ROTULO[k] ?? k}: {n(v)}</Pastilla>
            </Link>
          ))}
        </div>
      </Carta>

      <Carta titulo={busca || estado ? `${n(total)} ${total === 1 ? "resultado" : "resultados"}` : "Todas las personas"} extra={<span className="text-[12.5px] text-ink-muted">Las más recientes primero · página {pagina} de {paginas}</span>}>
        {filas.length ? (
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="enc-tabla">
              <thead><tr><th className="num">#</th><th>Nombre</th><th>Teléfono</th><th>Colonia</th><th>Cómo va</th><th className="num">Llamadas</th><th>Última llamada</th><th>Archivo</th></tr></thead>
              <tbody>
                {filas.map((x, i) => (
                  <tr key={String(x._id)}>
                    <td className="num text-ink-muted">{(pagina - 1) * POR_PAGINA + i + 1}</td>
                    <td className="font-medium">{x.nombre ?? <span className="font-normal text-ink-muted">sin nombre</span>}</td>
                    <td className="whitespace-nowrap font-mono text-[12.5px]">{tel(x.telefono)}</td>
                    <td>{x.colonia ?? <span className="text-ink-muted">—</span>}</td>
                    <td className="whitespace-nowrap"><Pastilla color={COLOR[x.estado] ?? "var(--text-muted)"}>{ROTULO[x.estado] ?? x.estado}</Pastilla></td>
                    <td className="num">{x.intentos}</td>
                    <td className="whitespace-nowrap text-[13px] text-ink-muted">{x.ultimoIntento ? fechaHoraCorta(new Date(x.ultimoIntento)) : "—"}</td>
                    <td className="max-w-[180px] truncate text-[12.5px] text-ink-muted" title={x.origen ?? ""}>{x.origen ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-8 text-center text-[14px] text-ink-muted">{base.total ? "Nadie coincide con esa búsqueda." : "Todavía no hay nadie en la base. Súbela abajo."}</p>
        )}
        {paginas > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2 text-[14px] font-semibold">
            {pagina > 1 && <Link href={liga({ p: String(pagina - 1) })} className={BTN}>← Anterior</Link>}
            <span className="text-ink-muted">{pagina} / {paginas}</span>
            {pagina < paginas && <Link href={liga({ p: String(pagina + 1) })} className={BTN}>Siguiente →</Link>}
          </div>
        )}
      </Carta>

      <Carta titulo="Subir más personas" subtitulo="Excel o CSV con columnas de nombre (o nombre y apellidos), teléfono y, si hay, colonia. Lo repetido no se duplica.">
        <form action={subirBase} className="flex flex-wrap items-end gap-3">
          <input name="archivo" type="file" accept=".xlsx,.csv,.txt,.tsv" className={`${INPUT} !w-auto min-w-[240px] flex-1 !py-1.5`} />
          <button className={BTN_PRIMARY}>Subir a la base</button>
        </form>
      </Carta>
    </div>
  );
}
