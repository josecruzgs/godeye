import Link from "next/link";
import { Bot, Download, Phone, PhoneCall, PencilLine, RefreshCw, Users } from "lucide-react";
import EncuestaLlamadaModel from "@/lib/models/EncuestaLlamada";
import EncuestaContactoModel from "@/lib/models/EncuestaContacto";
import { requireSesion } from "@/lib/encuestas/acceso";
import { cuestionarioActivo, resultadosLlamadas, respuestasDe, telefonoVisible, buscarLlamadas, ESTADOS_LLAMADA, leerOpciones } from "@/lib/encuestas/llamadas";
import { hayAgenteDeVoz, estadoTanda, horarioDeLlamadas, avisoDeVoz, metaDeContacto, simultaneas } from "@/lib/encuestas/agente_voz";
import { estadoBase, segmentos } from "@/lib/encuestas/base";
import { COLOR_OPCION, COLOR_PERSONA } from "@/lib/encuestas/encuesta";
import { fechaHoraCorta, mmss } from "@/lib/encuestas/fechas";
import { Carta, Kpi, Barra, Pastilla, Aviso, n, INPUT, LABEL, BTN, BTN_PRIMARY } from "@/components/encuestas/ui";
import PageHeader from "@/components/ui/PageHeader";
import Seguir from "@/components/encuestas/Seguir";
import Platica from "@/components/encuestas/Platica";
import { BRAND_NAME } from "@/lib/brand";
import { llamarAhora, detenerLlamadas, ajustarRemarcado, probarConMiNumero, mandarEncuesta, traerLlamadas, subirBase, vaciarBase } from "./acciones";

export const dynamic = "force-dynamic";
export const metadata = { title: `Encuestas · ${BRAND_NAME}` };

const haceMin = (m: number) => new Date(Date.now() - m * 60_000);
/** Margen de error al 95% para una proporción, en el peor caso (50%): lo que una casa encuestadora pone al pie. */
const margen = (base: number) => (base >= 30 ? Math.round((98 / Math.sqrt(base)) * 10) / 10 : null);

export default async function Encuestas({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; pruebas?: string; municipio?: string; distrito?: string }> }) {
  const { ok, error, pruebas: verPruebas, municipio = "", distrito = "" } = await searchParams;
  const s = await requireSesion();
  const admin = s.admin;
  const c = await cuestionarioActivo();
  if (!c) return <p className="text-ink-muted">No se pudo cargar el cuestionario.</p>;

  // Las llamadas de prueba (las de «Llamarme») entran a las estadísticas si se pide, o solas mientras la campaña todavía
  // no tiene ninguna llamada: así se ve cómo quedan los resultados antes de arrancar. Siempre se dice cuántas son de prueba.
  const deCampana = await EncuestaLlamadaModel.countDocuments({ cuestionarioId: c.id, prueba: false, estado: { $nin: ["NO_SALIO", "EN_CURSO"] } });
  // El filtro de municipio y distrito sale de la base que este usuario ve en claro (lo suyo y lo compartido): las opciones
  // nunca enseñan lo de una base ajena. Con filtro no hay pruebas: esas llamadas no son de nadie de la base.
  const seg = await segmentos(s.id, { municipio, distrito });
  const filtrado = !!seg.contactoIds;
  const zona = [municipio && `Municipio: ${municipio}`, distrito && `Distrito: ${distrito}`].filter(Boolean).join(" · ");
  const conPruebas = !filtrado && (verPruebas === "1" || (verPruebas !== "0" && deCampana === 0));
  const liga = (cambio: Record<string, string>) => {
    const u = new URLSearchParams({ ...(municipio ? { municipio } : {}), ...(distrito ? { distrito } : {}), ...(verPruebas ? { pruebas: verPruebas } : {}), ...cambio });
    for (const [k, v] of [...u.entries()]) if (!v) u.delete(k);
    return u.toString() ? `?${u}` : "";
  };
  const [real, enLinea, tanda, base, meta, aviso, pruebas] = await Promise.all([
    resultadosLlamadas(c, { conPruebas, contactoIds: seg.contactoIds }),
    EncuestaLlamadaModel.countDocuments({ estado: "EN_CURSO", inicio: { $gte: haceMin(30) } }),
    estadoTanda(),
    estadoBase(),
    metaDeContacto(),
    avisoDeVoz(),
    admin ? buscarLlamadas({ prueba: true }, { limite: 3 }) : Promise.resolve([]),
  ]);
  const h = horarioDeLlamadas();
  const conAgente = hayAgenteDeVoz();
  const lineas = simultaneas();
  const remarcando = !!meta && !meta.terminada;
  const llamando = enLinea > 0 || !!tanda || remarcando;
  const intentosMax = remarcando ? meta.reglas.intentosMax : 3;
  const reintentables = await EncuestaContactoModel.countDocuments({ estado: { $in: ["NO_CONTESTO", "BUZON"] }, intentos: { $lt: intentosMax } });
  const pendientes = base.porEstado.PENDIENTE ?? 0;
  const hechas = real.llamadas.filter((l) => l.estado !== "EN_CURSO");
  const pocas = real.completas < 100;
  const estadoTxt = aviso ? "No están saliendo" : llamando ? "Llamando" : h.abierto ? "Lista para llamar" : "Fuera de horario";
  const estadoColor = aviso ? "var(--status-critical)" : llamando ? "var(--primary)" : h.abierto ? "var(--status-good)" : "var(--text-muted)";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<PhoneCall className="h-4 w-4" />}
        title={c.nombre}
        subtitle={`Encuesta en curso · ${c.preguntas.length} preguntas · la asistente virtual llama ${h.texto} (hora de Baja California)`}
        right={
          <>
            {admin && (
              <Link href="/encuestas/guion" className={BTN}>
                <PencilLine className="h-3.5 w-3.5" /> Editar el guion
              </Link>
            )}
            <span
              className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-semibold"
              style={{ background: `color-mix(in srgb, ${estadoColor} 14%, transparent)`, color: estadoColor }}
            >
              <span className={`h-2 w-2 rounded-full ${llamando ? "animate-pulse" : ""}`} style={{ background: estadoColor }} /> {estadoTxt}
            </span>
          </>
        }
      />

      <Aviso ok={ok} error={error} />

      {admin && (
        <Carta id="mandar" titulo="Mandar la encuesta a un número" subtitulo="Escribe un celular de 10 dígitos: la asistente le llama y le hace la encuesta. La respuesta aparece abajo en cuanto cuelga." accent="var(--gold-vivid)">
          <form action={mandarEncuesta} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[200px] flex-1">
              <label className={LABEL} htmlFor="mandar-tel">Número de teléfono</label>
              <input id="mandar-tel" name="telefono" inputMode="tel" autoComplete="off" placeholder="664 123 4567" className={INPUT} required />
            </div>
            <label className="flex items-center gap-2 pb-2.5 text-[13px] text-ink-secondary">
              <input type="checkbox" name="prueba" className="h-4 w-4 accent-[var(--primary)]" /> Es prueba (no cuenta en los resultados)
            </label>
            <button disabled={!conAgente} className={BTN_PRIMARY}>
              <Phone className="h-4 w-4" /> Llamar ahora
            </button>
          </form>
          {!conAgente && <p className="mt-3 text-[12.5px] text-ink-muted">Falta conectar el agente de voz (ELEVENLABS_API_KEY y ELEVENLABS_AGENTE_ENCUESTA en el .env del servidor).</p>}
        </Carta>
      )}

      {(seg.municipios.length > 0 || seg.distritos.length > 0) && (
        <form action="/encuestas" className={`flex flex-wrap items-end gap-3 rounded-xl border px-4 py-3 ${filtrado ? "border-primary/50 bg-primary/10" : "border-hairline bg-surface"}`}>
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-[13px] font-semibold text-ink">{filtrado ? `Viendo solo ${zona}` : "Ver los resultados por zona"}</p>
            <p className="text-[12.5px] text-ink-muted">
              {filtrado
                ? `${n(seg.contactoIds?.length ?? 0)} ${seg.contactoIds?.length === 1 ? "persona" : "personas"} de tu base. Las cifras, las gráficas y la descarga son solo de ellas.`
                : "Municipio y distrito salen de la base que tú subiste (y de la compartida)."}
            </p>
          </div>
          <div className="w-full sm:w-52">
            <label className={LABEL} htmlFor="f-municipio">Municipio</label>
            <select id="f-municipio" name="municipio" defaultValue={municipio} className={INPUT}>
              <option value="">Todos</option>
              {seg.municipios.map((m) => <option key={m.clave} value={m.valor}>{m.valor} ({n(m.n)})</option>)}
            </select>
          </div>
          <div className="w-full sm:w-40">
            <label className={LABEL} htmlFor="f-distrito">Distrito</label>
            <select id="f-distrito" name="distrito" defaultValue={distrito} className={INPUT}>
              <option value="">Todos</option>
              {seg.distritos.map((d) => <option key={d.clave} value={d.valor}>{d.valor} ({n(d.n)})</option>)}
            </select>
          </div>
          <button className={BTN_PRIMARY}>Filtrar</button>
          {filtrado && <Link href="/encuestas" className="pb-2.5 text-[13px] font-semibold text-ink-muted underline">Quitar filtro</Link>}
        </form>
      )}

      {!filtrado && <section className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${conPruebas ? "border-warning/40 bg-warning/10" : "border-hairline bg-surface"}`}>
        <p className={`text-[13px] ${conPruebas ? "text-warning" : "text-ink-muted"}`}>
          {conPruebas ? (
            <>
              <b>Viendo campaña + pruebas.</b> Las cifras incluyen {n(real.pruebas)} {real.pruebas === 1 ? "llamada de prueba" : "llamadas de prueba"} (las de «Llamarme» o «Es prueba»)
              {deCampana ? ` y ${n(deCampana)} de la campaña` : "; la campaña todavía no tiene llamadas"}.
            </>
          ) : (
            <>Viendo solo la campaña: las llamadas de prueba no cuentan.</>
          )}
        </p>
        <div className="flex rounded-lg border border-hairline bg-page p-1 text-[12.5px] font-semibold" role="tablist" aria-label="Qué llamadas contar">
          <Link href="/encuestas?pruebas=0" className={`rounded-md px-3 py-1 ${!conPruebas ? "bg-primary text-primary-fg" : "text-ink-muted"}`} aria-selected={!conPruebas} role="tab">Solo campaña</Link>
          <Link href="/encuestas?pruebas=1" className={`rounded-md px-3 py-1 ${conPruebas ? "bg-warning text-white" : "text-ink-muted"}`} aria-selected={conPruebas} role="tab">Con pruebas</Link>
        </div>
      </section>}

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi etiqueta="Llamadas hechas" valor={n(real.intentos)} pie={`${conPruebas ? `incluye ${n(real.pruebas)} de prueba` : filtrado ? zona : "a personas de la base"}${enLinea ? ` · ${enLinea} en la línea` : ""}`} />
        <Kpi etiqueta="Contestaron" valor={n(real.contestaron)} pie={real.intentos ? `${Math.round((real.contestaron / real.intentos) * 100)} de cada 100 llamadas` : "—"} color="var(--teal)" />
        <Kpi etiqueta="Encuestas completas" valor={n(real.completas)} pie={real.duracionMedia ? `duran ${mmss(real.duracionMedia)} en promedio` : "contestaron todas las preguntas"} color="var(--status-good)" />
        <Kpi etiqueta="Faltan por llamar" valor={n(pendientes + reintentables)} pie={`${reintentables ? `${n(reintentables)} son para volver a marcar` : base.total ? `de ${n(base.total)} en la base` : "sube la base para empezar"}${filtrado ? " · de toda la base" : ""}`} color="#7c8aa5" />
      </section>

      {admin && (
        <Carta titulo="Llamadas" subtitulo={conAgente ? `La asistente marca de ${lineas} en ${lineas}; al colgar cada una se registra sola. El servidor sigue llamando aunque cierres esta pantalla.` : "Falta conectar el agente de voz (ELEVENLABS_AGENTE_ENCUESTA)."}>
          {aviso && (
            <p className="mb-4 rounded-xl border border-critical/40 bg-critical/10 px-4 py-3 text-[14px] text-ink">
              <b className="text-critical">Las llamadas no están saliendo.</b> {aviso.texto} <span className="text-ink-muted">(desde el {fechaHoraCorta(new Date(aviso.desde))})</span>
            </p>
          )}
          <Seguir activo={llamando} enLinea={enLinea} />
          {meta && (
            <div className={`mt-3 rounded-xl border px-4 py-3 ${meta.terminada ? "border-success/40" : "border-hairline"} bg-surface-2`}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <p className="text-[14px] font-semibold text-ink">
                  {meta.terminada
                    ? meta.reglas.motivo === "alcanzada"
                      ? `✓ Meta alcanzada: ya se habló con el ${meta.pct}% de la base`
                      : `Se acabó a quién volver a llamar: se habló con el ${meta.pct}% de la base`
                    : meta.meta >= 100
                      ? `Volviendo a marcar a quien no contesta (cada ${meta.reglas.esperaMin} min, hasta ${meta.reglas.intentosMax} veces)`
                      : `Remarcando hasta hablar con el ${meta.meta}% de la base`}
                </p>
                <span className="font-mono text-[15px] font-semibold tabular-nums text-primary">
                  {meta.pct}% <span className="text-[12px] font-normal text-ink-muted">· {n(meta.hablaron)} de {n(meta.total)}</span>
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-page">
                <div className="enc-barra h-full rounded-full" style={{ width: `${Math.min(100, (meta.pct / Math.max(1, meta.meta)) * 100)}%`, background: meta.terminada ? "var(--status-good)" : "var(--primary)" }} />
              </div>
              {!meta.terminada && <p className="mt-2 text-[12px] text-ink-muted">A quien no contesta se le vuelve a marcar hasta {meta.reglas.intentosMax} veces, con al menos {meta.reglas.esperaMin} minutos entre intentos y solo en horario. A quien ya contestó no se le vuelve a llamar.</p>}
            </div>
          )}
          {tanda || remarcando ? (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                <p className="text-[15px] font-semibold text-ink">{tanda && tanda.restante > 0 ? `Llamando: quedan ${n(tanda.restante)} de la base por primera vez.` : "Volviendo a marcar a quienes no contestaron."}</p>
                <form action={detenerLlamadas}>
                  <button className={`${BTN} !text-critical`}>Detener</button>
                </form>
              </div>
              <form action={ajustarRemarcado} className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-ink-secondary">
                <span>A quien no conteste, volver a marcarle cada</span>
                <input name="espera" inputMode="numeric" defaultValue={meta?.reglas.esperaMin ?? 5} className={`${INPUT} !w-20 !py-1.5 text-center font-semibold`} aria-label="Minutos entre intentos" />
                <span>minutos, hasta</span>
                <input name="intentos" inputMode="numeric" defaultValue={meta?.reglas.intentosMax ?? 3} className={`${INPUT} !w-16 !py-1.5 text-center font-semibold`} aria-label="Intentos por persona" />
                <span>veces.</span>
                <button className={BTN}>Guardar</button>
              </form>
            </>
          ) : (
            <form action={llamarAhora} className="mt-2 flex flex-wrap items-end gap-3">
              <div>
                <label className={LABEL} htmlFor="cuantas">¿A cuántas personas llamo?</label>
                <input id="cuantas" name="cuantas" inputMode="numeric" defaultValue={Math.min(100, Math.max(1, pendientes || 20))} className={`${INPUT} !w-36 font-mono text-[17px] font-semibold`} />
              </div>
              <div>
                <label className={LABEL} htmlFor="espera">Si no contesta, volver a marcar cada</label>
                <div className="flex items-center gap-2"><input id="espera" name="espera" inputMode="numeric" defaultValue={5} className={`${INPUT} !w-20 text-center font-semibold`} /><span className="text-[13px] text-ink-muted">min,</span></div>
              </div>
              <div>
                <label className={LABEL} htmlFor="intentos">hasta</label>
                <div className="flex items-center gap-2"><input id="intentos" name="intentos" inputMode="numeric" defaultValue={3} className={`${INPUT} !w-16 text-center font-semibold`} /><span className="text-[13px] text-ink-muted">veces</span></div>
              </div>
              <div>
                <label className={LABEL} htmlFor="meta">Parar al hablar con (%)</label>
                <input id="meta" name="meta" inputMode="decimal" placeholder="opcional, p. ej. 35" className={`${INPUT} !w-40`} />
              </div>
              <button disabled={!h.abierto || !conAgente} className={BTN_PRIMARY}>
                <Phone className="h-4 w-4" /> Llamar ahora
              </button>
              {!h.abierto && <span className="pb-2.5 text-[13px] text-ink-muted">Ahora está cerrado: se llama {h.texto}.</span>}
            </form>
          )}
        </Carta>
      )}

      <section id="resultados" className="grid scroll-mt-28 gap-5 lg:grid-cols-2">
        {real.preguntas.map((q, k) => {
          const max = Math.max(...q.filas.map((f) => f.votos));
          const me = margen(q.respondieron);
          return (
            <Carta key={q.pregunta.id} titulo={q.pregunta.corto ?? q.pregunta.texto} subtitulo={`Pregunta ${k + 1} · ${n(q.respondieron)} ${q.respondieron === 1 ? "persona contestó" : "personas contestaron"}${me ? ` · margen de error ±${me} pts` : ""}`}>
              {q.respondieron ? (
                <div className="space-y-3.5">
                  {q.filas.map((f, i) => (
                    <Barra key={f.nombre} nombre={f.nombre} pct={f.pct} votos={f.votos} lider={f.votos === max && max > 0} color={COLOR_OPCION[f.nombre] ?? COLOR_PERSONA[i] ?? "var(--primary)"} />
                  ))}
                </div>
              ) : (
                <p className="py-6 text-center text-[14px] text-ink-muted">Nadie ha contestado esta pregunta todavía.</p>
              )}
              <p className="mt-4 text-[12px] leading-snug text-ink-muted">«{q.pregunta.texto}»</p>
            </Carta>
          );
        })}
      </section>
      {pocas && (
        <p className="rounded-xl bg-warning/10 px-4 py-2.5 text-[13px] text-warning">
          {real.completas === 0 ? "Todavía no hay encuestas completas." : `Con ${n(real.completas)} ${real.completas === 1 ? "encuesta completa" : "encuestas completas"} estos porcentajes todavía se mueven mucho con cada llamada.`} A partir de unas 100 ya se leen con confianza; con 400, el margen de error baja a ±5 puntos.
        </p>
      )}

      {real.cruce && real.completas > 0 && (
        <Carta titulo="¿Qué contestó cada grupo?" subtitulo="Por cada respuesta de la primera pregunta, qué contestaron en la segunda. Cada renglón suma 100%; solo entran quienes contestaron las dos preguntas.">
          <div className="-mx-1 overflow-x-auto px-1">
            <table className="enc-tabla">
              <thead>
                <tr>
                  <th>Primera pregunta</th>
                  <th className="num">Personas</th>
                  {real.cruce.columnas.map((col) => <th key={col} className="num">{col}</th>)}
                </tr>
              </thead>
              <tbody>
                {real.cruce.filas.filter((f) => f.total > 0).map((f) => {
                  const top = Math.max(...f.celdas.map((x) => x.pct));
                  return (
                    <tr key={f.nombre}>
                      <td><span className="inline-flex items-center gap-2 font-semibold"><span className="h-2.5 w-2.5 rounded-full" style={{ background: COLOR_OPCION[f.nombre] ?? "var(--primary)" }} />{f.nombre}</span></td>
                      <td className="num text-ink-muted">{n(f.total)}</td>
                      {f.celdas.map((x, i) => (
                        <td key={i} className="num">
                          <span
                            className="inline-block min-w-[52px] rounded-md px-2 py-0.5 font-mono text-[13px] tabular-nums"
                            style={{ background: x.pct ? `color-mix(in srgb, var(--primary) ${Math.round(6 + x.pct * 0.5)}%, transparent)` : "transparent", fontWeight: x.pct === top && top > 0 ? 700 : 500 }}
                          >
                            {x.pct}%
                          </span>
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Carta>
      )}

      <Carta
        id="encuestas"
        titulo="Las encuestas hechas"
        subtitulo={`${n(hechas.length)} ${hechas.length === 1 ? "llamada" : "llamadas"} · ${n(real.completas)} completas · de la más reciente a la más vieja · de la campaña solo se ven los últimos 4 dígitos del teléfono`}
        extra={
          <div className="flex flex-wrap gap-2">
            {hechas.length > 0 && (
              <a href={`/encuestas/descargar${liga({ pruebas: conPruebas ? "1" : "" })}`} className={BTN}>
                <Download className="h-3.5 w-3.5" /> Descargar Excel (CSV)
              </a>
            )}
            {admin && (
              <form action={traerLlamadas}>
                <button className={BTN}><RefreshCw className="h-3.5 w-3.5" /> Traer lo último</button>
              </form>
            )}
          </div>
        }
      >
        {hechas.length ? (
          <div className="-mx-1 max-h-[620px] overflow-auto px-1">
            <table className="enc-tabla">
              <thead>
                <tr>
                  <th className="num">#</th><th>Cuándo</th><th>Teléfono</th><th>Resultado</th><th>Llamada</th><th className="num">Duró</th>
                  {c.preguntas.map((p) => <th key={p.id}>{p.corto ?? p.clave}</th>)}
                </tr>
              </thead>
              <tbody>
                {hechas.slice(0, 500).map((l, k) => {
                  const e = ESTADOS_LLAMADA[l.estado] ?? ESTADOS_LLAMADA.COLGO;
                  const rs = respuestasDe(l, c);
                  return (
                    <tr key={l.id}>
                      <td className="num text-ink-muted">{hechas.length - k}</td>
                      <td className="whitespace-nowrap">{fechaHoraCorta(l.inicio)}</td>
                      <td className={`whitespace-nowrap font-mono text-[12.5px] ${l.prueba ? "" : "text-ink-muted"}`}>{telefonoVisible(l) ?? "—"}</td>
                      <td className="whitespace-nowrap">
                        <Pastilla color={e.color}>{e.label}</Pastilla>
                        {l.prueba && <span className="ml-1.5"><Pastilla color="var(--status-warning)">Prueba</Pastilla></span>}
                      </td>
                      <td>
                        <Platica id={l.id} titulo={`${fechaHoraCorta(l.inicio)} · ${e.label}${l.segundos ? ` · ${mmss(l.segundos)}` : ""}`} transcripcion={l.transcripcion} conAudio={admin && !!l.externoId && (l.segundos ?? 0) > 0} />
                      </td>
                      <td className="num">{l.segundos ? mmss(l.segundos) : "—"}</td>
                      {rs.map((r, i) => (
                        <td key={i} className="font-medium">
                          {r ? (
                            <span className="inline-flex items-center gap-1.5">
                              {COLOR_OPCION[r] && <span className="h-2 w-2 rounded-full" style={{ background: COLOR_OPCION[r] }} />}
                              {r}
                            </span>
                          ) : (
                            <span className="font-normal text-ink-muted">—</span>
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {hechas.length > 500 && <p className="mt-2 text-[12.5px] text-ink-muted">Se muestran las 500 más recientes; el archivo descargado trae todas.</p>}
          </div>
        ) : (
          <p className="py-6 text-center text-[14px] text-ink-muted">Todavía no se ha hecho ninguna llamada a la base.</p>
        )}
      </Carta>

      {admin && (
        <section className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
          <Carta
            id="base"
            titulo="La base de teléfonos"
            subtitulo={base.total ? `${n(base.total)} teléfonos · ${n(pendientes)} sin llamar todavía` : "Sube la lista a la que va a llamar la asistente."}
            extra={
              base.total ? (
                <Link href="/encuestas/base" className={BTN_PRIMARY}>
                  <Users className="h-4 w-4" /> Ver la base ({n(base.total)})
                </Link>
              ) : undefined
            }
          >
            {base.total > 0 && (
              <div className="mb-4 flex flex-wrap gap-2">
                {Object.entries(base.porEstado).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
                  <Pastilla key={k} color={k === "PENDIENTE" ? "var(--primary)" : k === "NO_LLAMAR" ? "var(--status-critical)" : ESTADOS_LLAMADA[k]?.color ?? "var(--text-muted)"}>
                    {k === "PENDIENTE" ? "Sin llamar" : k === "NO_LLAMAR" ? "Pidió que no le llamen" : ESTADOS_LLAMADA[k]?.label ?? k}: {n(v)}
                  </Pastilla>
                ))}
              </div>
            )}
            <form action={subirBase} className="space-y-3">
              <div>
                <label className={LABEL} htmlFor="archivo">Archivo de Excel (.xlsx) o CSV</label>
                <input id="archivo" name="archivo" type="file" accept=".xlsx,.csv,.txt,.tsv" className={`${INPUT} !py-1.5`} />
              </div>
              <div>
                <label className={LABEL} htmlFor="pegado">…o pega aquí la columna de teléfonos</label>
                <textarea id="pegado" name="pegado" rows={3} placeholder={"6861234567\n6869876543"} className={`${INPUT} font-mono text-[13px]`} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button className={BTN_PRIMARY}>Subir a la base</button>
                <span className="text-[12.5px] text-ink-muted">Celulares de 10 dígitos. Lo repetido y lo que ya estaba no se duplica.</span>
                <a href="/encuestas/plantilla" className="text-[12.5px] font-semibold text-ink-muted underline">Descargar plantilla</a>
              </div>
            </form>
            {base.total > 0 && (
              <form action={vaciarBase} className="mt-4 border-t border-hairline pt-4">
                <button className="text-[12.5px] font-semibold text-critical underline">Vaciar la base</button>
                <span className="ml-2 text-[12px] text-ink-muted">Borra la lista de teléfonos; las encuestas hechas se quedan.</span>
              </form>
            )}
          </Carta>

          <Carta id="probar" titulo="Probar con mi número" subtitulo="La asistente te llama a ti, a cualquier hora. Nunca cuenta en los resultados.">
            <form action={probarConMiNumero} className="flex flex-wrap items-end gap-2">
              <div className="min-w-[180px] flex-1">
                <label className={LABEL} htmlFor="telefono">Tu celular</label>
                <input id="telefono" name="telefono" inputMode="tel" placeholder="686 123 4567" className={INPUT} />
              </div>
              <button disabled={!conAgente} className={BTN}>
                <Phone className="h-3.5 w-3.5" /> Llamarme
              </button>
            </form>
            {pruebas.length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="label-mono-sm">Últimas pruebas</p>
                {pruebas.map((l) => {
                  const e = ESTADOS_LLAMADA[l.estado] ?? ESTADOS_LLAMADA.COLGO;
                  const r = respuestasDe(l, c).filter(Boolean);
                  return (
                    <div key={l.id} className="flex items-center justify-between gap-2 text-[13px]">
                      <span className="text-ink-muted">{fechaHoraCorta(l.inicio)}</span>
                      <span className="truncate text-ink-secondary">{r.length ? r.join(" · ") : ""}</span>
                      <Pastilla color={e.color}>{e.label}</Pastilla>
                    </div>
                  );
                })}
              </div>
            )}
          </Carta>
        </section>
      )}

      <Carta
        id="guion"
        titulo="El guion de la llamada"
        subtitulo={`Lo que dice la asistente virtual, palabra por palabra · versión ${c.version}`}
        extra={
          admin ? (
            <Link href="/encuestas/guion" className={BTN_PRIMARY}>
              <PencilLine className="h-4 w-4" /> Editar el guion
            </Link>
          ) : undefined
        }
      >
        <div className="grid gap-4 text-[14px] lg:grid-cols-3">
          <div className="rounded-xl bg-surface-2 p-4">
            <p className="label-mono-sm mb-1.5 flex items-center gap-1.5"><Bot className="h-3.5 w-3.5" /> Introducción</p>
            <p className="leading-relaxed text-ink">{c.saludo}</p>
          </div>
          {c.preguntas.map((p, i) => (
            <div key={p.id} className="rounded-xl bg-surface-2 p-4">
              <p className="label-mono-sm mb-1.5">Pregunta {i + 1}</p>
              <p className="font-semibold leading-relaxed text-ink">{p.texto}</p>
              <p className="label-mono-sm mb-1 mt-3">Se registra</p>
              <ul className="space-y-0.5 text-ink-muted">
                {leerOpciones(p.opciones).map((o) => (
                  <li key={o}>
                    • {o}
                    {leerOpciones(p.noSeLeen).includes(o) && <span className="text-[12px]"> (no se lee; cuenta si la persona lo dice)</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-4 rounded-xl bg-surface-2 p-4 text-[14px]">
          <p className="label-mono-sm mb-1.5">Despedida</p>
          <p className="text-ink">{c.cierre}</p>
        </div>
      </Carta>

      <p className="py-2 text-center text-[12px] text-ink-muted">
        Encuesta telefónica {c.municipio} · Las llamadas de prueba nunca se cuentan en los resultados.
      </p>
    </div>
  );
}
