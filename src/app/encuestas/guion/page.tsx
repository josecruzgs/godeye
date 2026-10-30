import Link from "next/link";
import { Types } from "mongoose";
import { Phone, PencilLine } from "lucide-react";
import EncuestaLlamadaModel from "@/lib/models/EncuestaLlamada";
import EncuestaCambioModel from "@/lib/models/EncuestaCambio";
import { requireAdmin } from "@/lib/encuestas/acceso";
import { cuestionarioActivo, leerOpciones } from "@/lib/encuestas/llamadas";
import { leerFrases, ROTULO_FRASES } from "@/lib/encuestas/guion";
import { fechaHoraCorta } from "@/lib/encuestas/fechas";
import { Carta, Aviso, n, INPUT, LABEL, BTN } from "@/components/encuestas/ui";
import PageHeader from "@/components/ui/PageHeader";
import { BRAND_NAME } from "@/lib/brand";
import Editor from "./Editor";
import { probarConMiNumero } from "../acciones";
import type { GuionEditado } from "./acciones";

export const dynamic = "force-dynamic";
export const metadata = { title: `Editar el guion · ${BRAND_NAME}` };

type Cambio = { _id: unknown; version: number; nombre: string | null; fecha: Date; resumen: string };

export default async function EditarGuion({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string }> }) {
  const { ok, error } = await searchParams;
  await requireAdmin();
  const c = await cuestionarioActivo();
  if (!c) return <p className="text-ink-muted">No se pudo cargar el cuestionario.</p>;

  const [conteos, cambios, porVersion] = await Promise.all([
    EncuestaLlamadaModel.aggregate<{ _id: { p: unknown; v: string }; n: number }>([
      { $match: { cuestionarioId: new Types.ObjectId(c.id) } },
      { $unwind: "$respuestas" },
      { $group: { _id: { p: "$respuestas.preguntaId", v: "$respuestas.valor" }, n: { $sum: 1 } } },
    ]),
    EncuestaCambioModel.find({ cuestionarioId: c.id }).sort({ fecha: -1 }).limit(12).lean<Cambio[]>(),
    EncuestaLlamadaModel.aggregate<{ _id: number | null; n: number }>([
      { $match: { cuestionarioId: new Types.ObjectId(c.id), prueba: false, estado: { $nin: ["NO_SALIO", "EN_CURSO"] } } },
      { $group: { _id: "$versionGuion", n: { $sum: 1 } } },
    ]),
  ]);
  const respuestasPorOpcion: Record<string, Record<string, number>> = {};
  for (const x of conteos) (respuestasPorOpcion[String(x._id.p)] ??= {})[x._id.v] = x.n;
  const llamadasCon = (v: number) => porVersion.filter((x) => (x._id ?? 1) === v).reduce((a, x) => a + x.n, 0);

  const inicial: GuionEditado = {
    saludo: c.saludo,
    cierre: c.cierre ?? "",
    frases: leerFrases(c.frases),
    preguntas: c.preguntas.map((p) => {
      const callar = new Set(leerOpciones(p.noSeLeen));
      return { id: p.id, texto: p.texto, corto: p.corto ?? "", reglas: p.reglas ?? "", opciones: leerOpciones(p.opciones).map((o) => ({ original: o, texto: o, seLee: !callar.has(o) })) };
    }),
  };

  return (
    <div className="mx-auto flex max-w-[920px] flex-col gap-5">
      <PageHeader
        icon={<PencilLine className="h-4 w-4" />}
        title="Editar el guion"
        subtitle={`Versión actual ${c.version} · ${n(llamadasCon(c.version))} ${llamadasCon(c.version) === 1 ? "llamada hecha" : "llamadas hechas"} con ella`}
        right={<Link href="/encuestas" className={BTN}>← Volver al tablero</Link>}
      />
      <p className="-mt-2 text-[14px] text-ink-secondary">Lo que dice la asistente virtual en cada llamada. Al guardar se actualiza sola y lo usa desde la siguiente llamada.</p>

      <Aviso ok={ok} error={error} />

      <p className="rounded-xl bg-warning/10 px-4 py-3 text-[13px] text-warning">
        <b>Ojo:</b> cambiar cómo se pregunta a media encuesta cambia lo que se mide, y las respuestas de antes y después ya no son
        del todo comparables. Cada llamada guarda con qué versión del guion se hizo (viene en el Excel descargado). Cambiar la
        introducción o la despedida no afecta los resultados.
      </p>

      <Editor key={c.version} inicial={inicial} rotulos={ROTULO_FRASES} respuestasPorOpcion={respuestasPorOpcion} />

      <Carta id="probar" titulo="Escucharlo" subtitulo="Guarda primero y luego pide que la asistente te llame. Sale a cualquier hora y nunca cuenta en los resultados.">
        <form action={probarConMiNumero} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="desde" value="guion" />
          <div className="min-w-[180px] flex-1">
            <label className={LABEL} htmlFor="telefono">Tu celular</label>
            <input id="telefono" name="telefono" inputMode="tel" placeholder="686 123 4567" className={INPUT} />
          </div>
          <button className={BTN}><Phone className="h-3.5 w-3.5" /> Llamarme</button>
        </form>
      </Carta>

      <Carta titulo="Historial de cambios">
        {cambios.length ? (
          <ol className="space-y-2.5">
            {cambios.map((x) => (
              <li key={String(x._id)} className="flex gap-3 text-[13.5px]">
                <span className="w-12 shrink-0 font-mono font-semibold text-primary">v{x.version}</span>
                <span>
                  <span className="block text-ink"><b>{x.nombre ?? "Alguien"}</b> · {fechaHoraCorta(new Date(x.fecha))} · {n(llamadasCon(x.version))} llamadas</span>
                  <span className="block text-ink-muted">Cambió: {x.resumen}</span>
                </span>
              </li>
            ))}
            <li className="flex gap-3 text-[13px] text-ink-muted"><span className="w-12 font-mono">v1</span><span>Guion original · {n(llamadasCon(1))} llamadas</span></li>
          </ol>
        ) : (
          <p className="text-[13.5px] text-ink-muted">Todavía nadie ha cambiado el guion desde el panel (versión 1).</p>
        )}
      </Carta>
    </div>
  );
}
