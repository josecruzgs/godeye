/**
 * Motores: cuántas tareas puede tener el worker en vuelo a la vez.
 *
 * Hasta ahora el worker corría estrictamente de a una —el bucle hacía
 * `await tick()` y no volvía hasta que la tarea terminaba—, así que "1 tarea
 * simultánea" no era una decisión sino la forma del código. Un motor es cada
 * una de esas ranuras de ejecución.
 *
 * `TOTALES` es lo que dibuja la UI y `POR_DEFECTO` lo que el worker enciende:
 * la sala muestra siempre los cinco huecos y los que sobran salen apagados,
 * para que subir el número sea cambiar una variable de entorno y no rediseñar
 * la pantalla. El worker informa cuántos encendió en su latido y la UI ilumina
 * esos; no hay un segundo lugar donde el número tenga que coincidir.
 */
export const MOTORES_TOTALES = 5;

/**
 * Dos y no cinco a propósito: cada motor abre su propio navegador en AdsPower
 * sobre la pantalla virtual del VPS, y eso cuesta RAM y disco. Se sube cuando
 * la máquina lo aguante, con `WORKER_ENGINES`.
 */
export const MOTORES_POR_DEFECTO = 2;

/** Lee `WORKER_ENGINES` y lo deja dentro de lo que la UI sabe dibujar. */
export function motoresConfigurados(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return MOTORES_POR_DEFECTO;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return MOTORES_POR_DEFECTO;
  return Math.min(Math.floor(n), MOTORES_TOTALES);
}
