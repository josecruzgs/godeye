import Link from "next/link";
import { Lock, Users } from "lucide-react";
import EncuestaContactoModel from "@/lib/models/EncuestaContacto";
import { dbConnect } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/encuestas/acceso";
import { ESTADOS_LLAMADA } from "@/lib/encuestas/llamadas";
import { estadoBase, contactoVisible, filtroVisible, type ContactoDoc } from "@/lib/encuestas/base";
import { fechaHoraCorta } from "@/lib/encuestas/fechas";
import { Carta, Pastilla, Aviso, n, INPUT, LABEL, BTN, BTN_PRIMARY } from "@/components/encuestas/ui";
import PageHeader from "@/components/ui/PageHeader";
import { BRAND_NAME } from "@/lib/brand";
import { subirBase } from "../acciones";

export const dynamic = "force-dynamic";
export const metadata = { title: `Base de teléfonos · ${BRAND_NAME}` };

/**
 * LA BASE, CON NOMBRE Y NÚMERO, PERO SOLO PARA QUIEN LA SUBIÓ. Cada contacto se guarda cifrado y con dueño
 * (lib/encuestas/cifrado.ts): aquí cada quien ve en claro lo suyo y lo compartido; lo que subió otro usuario sale con los
 * últimos 4 dígitos y cómo le fue, sin nombre. Admin y operador. Lo que contestó cada quien no se enseña aquí: eso vive en
 * las encuestas, sin nombre.
 */
const POR_PAGINA = 50;
const ROTULO: Record<string, string> = { PENDIENTE: "Sin llamar", NO_LLAMAR: "Pidió que no le llamen", ...Object.fromEntries(Object.entries(ESTADOS_LLAMADA).map(([k, v]) => [k, v.label])) };
const COLOR: Record<string, string> = { PENDIENTE: "var(--primary)", NO_LLAMAR: "var(--status-critical)", ...Object.fromEntries(Object.entries(ESTADOS_LLAMADA).map(([k, v]) => [k, v.color])) };
const tel = (t: string) => `${t.slice(0, 3)} ${t.slice(3, 6)} ${t.slice(6)}`;
const sinAcentos = (x: string) => x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const CAMPOS = "telefono telCifrado telFin nombreCifrado coloniaCifrada origenCifrado subidoPor estado intentos ultimoIntento createdAt";

export default async function Base({ searchParams }: { searchParams: Promise<{ q?: string; estado?: string; p?: string; ok?: string; error?: string }> }) {
  const { q = "", estado = "", p = "1", ok, error } = await searchParams;
  const s = await requireAdmin();
  await dbConnect();
  const pagina = Math.max(1, parseInt(p) || 1);
  const busca = q.trim();
  const porEstado = estado ? { estado } : {};
  const base = await estadoBase();
  const misContactos = await EncuestaContactoModel.countDocuments({ subidoPor: s.id });

  // Sin búsqueda se pagina en Mongo. Con búsqueda no se puede: nombre, teléfono y colonia están cifrados. Se busca entonces
  // solo en lo que este usuario puede ver en claro, descifrándolo aquí; lo de otros nunca aparece en una búsqueda (si
  // apareciera, confirmaría que ese número o ese nombre está en una base ajena).
  let total: number, filas: ReturnType<typeof contactoVisible>[];
  if (busca) {
    const t = sinAcentos(busca), digitos = busca.replace(/\D/g, "");
    const todos = (await EncuestaContactoModel.find({ ...porEstado, ...filtroVisible(s.id) }).sort({ createdAt: -1, _id: 1 }).select(CAMPOS).lean<ContactoDoc[]>())
      .map((c) => contactoVisible(c, s.id))
      .filter((c) => (c.nombre && sinAcentos(c.nombre).includes(t)) || (c.colonia && sinAcentos(c.colonia).includes(t)) || (digitos.length >= 3 && c.telefono?.includes(digitos)));
    total = todos.length;
    filas = todos.slice((pagina - 1) * POR_PAGINA, pagina * POR_PAGINA);
  } else {
    total = await EncuestaContactoModel.countDocuments(porEstado);
    filas = (await EncuestaContactoModel.find(porEstado).sort({ createdAt: -1, _id: 1 }).skip((pagina - 1) * POR_PAGINA).limit(POR_PAGINA).select(CAMPOS).lean<ContactoDoc[]>())
      .map((c) => contactoVisible(c, s.id));
  }
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  const ajenas = base.total - (await EncuestaContactoModel.countDocuments(filtroVisible(s.id)));
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
        subtitle={`${n(base.total)} personas cargadas · ${n(misContactos)} las subiste tú · la lista a la que llama la asistente, con cómo le fue a cada quien`}
        right={<Link href="/encuestas" className={BTN}>← Volver al tablero</Link>}
      />

      <Aviso ok={ok} error={error} />

      <div className="flex items-start gap-2.5 rounded-lg border border-hairline bg-surface-2 px-4 py-3 text-[13px] text-ink-muted">
        <Lock className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          Los nombres, teléfonos y colonias se guardan cifrados. <b className="text-ink">Cada quien ve en claro solo lo que subió</b>; de las bases de otros
          usuarios (también los administradores) solo se ven los últimos 4 dígitos y cómo le fue a cada persona.
          {ajenas > 0 && ` Aquí hay ${n(ajenas)} ${ajenas === 1 ? "persona" : "personas"} de bases ajenas: no salen en las búsquedas.`}
        </p>
      </div>

      <Carta>
        <form className="flex flex-wrap items-end gap-3" action="/encuestas/base">
          <div className="min-w-[220px] flex-1">
            <label className={LABEL} htmlFor="q">Buscar en tu base por nombre, teléfono o colonia</label>
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
              <thead><tr><th className="num">#</th><th>Nombre</th><th>Teléfono</th><th>Colonia</th><th>Cómo va</th><th className="num">Llamadas</th><th>Última llamada</th><th>Archivo</th><th>De quién</th></tr></thead>
              <tbody>
                {filas.map((x, i) => (
                  <tr key={x.id}>
                    <td className="num text-ink-muted">{(pagina - 1) * POR_PAGINA + i + 1}</td>
                    <td className="font-medium">
                      {!x.abierto ? <span className="inline-flex items-center gap-1 font-normal text-ink-muted"><Lock className="h-3 w-3" /> privado</span>
                        : x.nombre ?? <span className="font-normal text-ink-muted">sin nombre</span>}
                    </td>
                    <td className="whitespace-nowrap font-mono text-[12.5px]">{x.telefono ? tel(x.telefono) : <span className="text-ink-muted">••• ••• {x.telFin ?? "????"}</span>}</td>
                    <td>{x.colonia ?? <span className="text-ink-muted">—</span>}</td>
                    <td className="whitespace-nowrap"><Pastilla color={COLOR[x.estado] ?? "var(--text-muted)"}>{ROTULO[x.estado] ?? x.estado}</Pastilla></td>
                    <td className="num">{x.intentos}</td>
                    <td className="whitespace-nowrap text-[13px] text-ink-muted">{x.ultimoIntento ? fechaHoraCorta(new Date(x.ultimoIntento)) : "—"}</td>
                    <td className="max-w-[180px] truncate text-[12.5px] text-ink-muted" title={x.origen ?? ""}>{x.origen ?? "—"}</td>
                    <td className="whitespace-nowrap text-[12.5px] text-ink-muted">{x.de === "mio" ? "Tú" : x.de === "compartida" ? "Compartida" : "Otro usuario"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-8 text-center text-[14px] text-ink-muted">{base.total ? "Nadie de tu base coincide con esa búsqueda." : "Todavía no hay nadie en la base. Súbela abajo."}</p>
        )}
        {paginas > 1 && (
          <div className="mt-4 flex items-center justify-center gap-2 text-[14px] font-semibold">
            {pagina > 1 && <Link href={liga({ p: String(pagina - 1) })} className={BTN}>← Anterior</Link>}
            <span className="text-ink-muted">{pagina} / {paginas}</span>
            {pagina < paginas && <Link href={liga({ p: String(pagina + 1) })} className={BTN}>Siguiente →</Link>}
          </div>
        )}
      </Carta>

      <Carta titulo="Subir más personas" subtitulo="Excel o CSV con una columna de teléfono y, si hay, nombre (o nombre y apellidos) y colonia. Se guarda cifrado y solo tú lo ves en claro. Lo repetido no se duplica.">
        <form action={subirBase} className="flex flex-wrap items-end gap-3">
          <input name="archivo" type="file" accept=".xlsx,.csv,.txt,.tsv" className={`${INPUT} !w-auto min-w-[240px] flex-1 !py-1.5`} />
          <button className={BTN_PRIMARY}>Subir a la base</button>
        </form>
      </Carta>
    </div>
  );
}
