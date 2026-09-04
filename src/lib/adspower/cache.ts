import { readdir, rm } from "fs/promises";
import { homedir } from "os";
import path from "path";

/**
 * Borra la caché de navegación que AdsPower deja por perfil.
 *
 * Existe porque `clear_cache_after_closing: 1` —que sí se le manda en cada
 * `browser/start`, ver client.ts— no hace nada. Está medido, no supuesto: el
 * 3/9/2026, una hora después de vaciar el directorio a mano, había 133 carpetas
 * de perfil y 5,4 GB, con nunca más de 3 navegadores abiertos a la vez. Cada
 * tarea deja ~40 MB y nadie los recoge. A ese ritmo el disco de 96 GB se llena
 * en unas 15 horas, y llenarlo ya tiró producción dos veces (28/8 y 3/9): el
 * `npm ci` del despliegue borra node_modules y después no tiene espacio para
 * reinstalarlo.
 *
 * `deploy/podar-cache.sh` hace lo mismo por cron y sigue instalado: es la red
 * por si esto no corre —un worker que muere sin pasar por acá, un perfil que se
 * abrió desde el visor y nadie cerró—. Esto es lo que evita que se acumule;
 * aquello, lo que evita que se acumule sin que nadie mire.
 */

/**
 * Dónde vive la caché. Es la máquina donde corre AdsPower, que hoy es el mismo
 * VPS que el worker; si algún día vuelven a separarse, este módulo no encuentra
 * el directorio y no hace nada, que es la respuesta correcta.
 */
const RAIZ = path.resolve(
  process.env.ADSPOWER_CACHE_DIR ??
    path.join(homedir(), ".cache", "adspower_global", "cwd_global", "source", "cache"),
);

/** Los ids de AdsPower son alfanuméricos (`k1fl73hx`). Nada que pueda ser ruta. */
const ID_VALIDO = /^[A-Za-z0-9]+$/;

/**
 * Borra las carpetas de caché del perfil y devuelve cuáles borró.
 *
 * La carpeta se llama `<user_id>_<sufijo>` (`k1fl73hx_i78ncl`), confirmado
 * contra la Local API. El match es exacto o con guion bajo: `startsWith(id)` a
 * secas emparejaría a `k1fl73hx` con la carpeta de `k1fl73hxZ`, que es otro
 * perfil.
 *
 * Nunca tira. Es limpieza: que falle no puede tumbar la tarea que ya terminó.
 */
export async function borrarCacheDelPerfil(profileId: string): Promise<string[]> {
  if (!ID_VALIDO.test(profileId)) return [];

  let entradas: string[];
  try {
    entradas = await readdir(RAIZ);
  } catch {
    // No existe: no estamos en la máquina de AdsPower, o todavía no se abrió
    // ningún navegador. En los dos casos no hay nada que borrar.
    return [];
  }

  const suyas = entradas.filter((n) => n === profileId || n.startsWith(`${profileId}_`));
  const borradas: string[] = [];

  for (const nombre of suyas) {
    const destino = path.resolve(RAIZ, nombre);
    // Un nombre de carpeta no debería poder salirse de la raíz, pero esto se
    // ejecuta como un `rm -rf` en un servidor de producción: la comprobación
    // cuesta una línea y el error que evita no tiene vuelta atrás.
    if (path.dirname(destino) !== RAIZ) continue;

    try {
      await rm(destino, { recursive: true, force: true });
      borradas.push(nombre);
    } catch {
      // Un archivo que desaparece solo, un permiso raro: lo levanta el cron.
    }
  }

  return borradas;
}
