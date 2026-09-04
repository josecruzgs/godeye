import type {
  AdsPowerGroup,
  AdsPowerListResponse,
  AdsPowerProfile,
  AdsPowerStartBrowserData,
} from "./types";

// Cliente para la Local API de AdsPower (requiere el cliente de escritorio
// abierto en esta misma máquina). Documentación oficial:
// https://localapi-doc-en.adspower.com/
//
// Cuando "API key obligatoria" está activada (Configuración > Avanzado), el
// key se manda como header `Authorization: Bearer <key>` (confirmado
// empíricamente contra la instancia local; ni query param ni header
// `api-key`/`x-api-key` funcionan).

const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1100;
const RATE_LIMIT_RETRY_DELAYS_MS = [1200, 2200, 3500];

/**
 * Ninguna llamada a la Local API puede esperar para siempre.
 *
 * `fetch` sin `signal` no tiene tope: si AdsPower acepta la conexión y después
 * no contesta —el cuelgue del 23/8, con el worker siete horas dentro del mismo
 * `await`, vivo, al 0% de CPU y sin escribir una línea— el bucle de tareas
 * queda trancado, y PM2 no lo levanta porque el proceso nunca murió. Un
 * timeout convierte eso en una tarea fallida, que es recuperable.
 *
 * Arrancar un navegador es la operación lenta (AdsPower levanta un Chromium
 * entero) y por eso tiene su propio tope, mucho más generoso que el resto.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const START_BROWSER_TIMEOUT_MS = 120_000;

/**
 * Banderas que se le pasan al Chromium del perfil cuando arranca.
 *
 * La barra de Google Translate ("¿Traducir esta página? Spanish | English") es
 * UI nativa del navegador, no DOM: Playwright no la ve y no la puede cerrar, y
 * si alguien alguna vez le dijo "traducir siempre" a ese perfil, Chrome reescribe
 * los rótulos de Facebook y todos los selectores por texto pasan a dar
 * "0 match(es)". Apagar la función de raíz es la única forma de que no aparezca.
 *
 * Van los dos nombres a propósito: `TranslateUI` es como se llamaba la feature
 * en los Chromium viejos —AdsPower arrastra varias versiones según el perfil— y
 * `Translate` como se llama ahora.
 *
 * Ojo con agregar más: `--disable-features` es un switch de valor único, así que
 * si AdsPower pasara el suyo, el último gana y se pisan. Y nada que toque la
 * huella (idioma, user agent, APIs deshabilitadas): el sentido de AdsPower es
 * que cada perfil parezca un navegador normal.
 */
const LAUNCH_ARGS = ["--disable-features=Translate,TranslateUI"];

let requestQueue = Promise.resolve();
let lastRequestStartedAt = 0;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function getMinRequestIntervalMs() {
  const raw = process.env.ADSPOWER_MIN_REQUEST_INTERVAL_MS;
  if (!raw) return DEFAULT_MIN_REQUEST_INTERVAL_MS;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MIN_REQUEST_INTERVAL_MS;
}

function isRateLimitMessage(message: string) {
  return /too many request|request per second|rate.?limit/i.test(message);
}

async function runQueuedRequest<T>(operation: () => Promise<T>) {
  const queued = requestQueue.then(async () => {
    const minInterval = getMinRequestIntervalMs();
    const elapsed = Date.now() - lastRequestStartedAt;
    if (elapsed < minInterval) await sleep(minInterval - elapsed);

    lastRequestStartedAt = Date.now();
    return operation();
  });

  requestQueue = queued.catch(() => undefined).then(() => undefined);
  return queued;
}

async function request<T>(
  path: string,
  {
    method = "GET",
    query,
    body,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  }: {
    method?: string;
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  // Leídas en cada llamada (no a nivel de módulo): en el worker standalone
  // (src/worker/index.ts) dotenv carga .env.local después de que los imports
  // ya se resolvieron, así que capturarlas al importar este módulo las deja
  // en `undefined` aunque .env.local sí las tenga.
  const baseUrl = process.env.ADSPOWER_API_BASE_URL ?? "http://local.adspower.net:50325";
  const apiKey = process.env.ADSPOWER_API_KEY;

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) params.set(k, String(v));
  }

  const url = `${baseUrl}${path}${params.toString() ? `?${params.toString()}` : ""}`;

  const headers: Record<string, string> = {};
  if (body) headers["Content-Type"] = "application/json";
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  return runQueuedRequest(async () => {
    for (let attempt = 0; ; attempt += 1) {
      // El signal se crea dentro del bucle: cada reintento merece su propio
      // tope, no lo que sobró del anterior. Y cubre la lectura del cuerpo
      // además de la conexión, así que el catch envuelve a las dos.
      let json: AdsPowerListResponse<T>;
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) throw new Error(`AdsPower API HTTP ${res.status} en ${path}`);

        json = (await res.json()) as AdsPowerListResponse<T>;
      } catch (err) {
        // El `TimeoutError` pelado dice "The operation was aborted", que en un
        // log de tarea fallida no ayuda a nadie: sin el nombre del endpoint no
        // se distingue un AdsPower caído de un perfil que no arranca.
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new Error(`AdsPower no respondió en ${path} tras ${Math.round(timeoutMs / 1000)}s`);
        }
        throw err;
      }

      if (json.code === 0) {
        return json.data;
      }

      const retryDelay = RATE_LIMIT_RETRY_DELAYS_MS[attempt];
      if (!isRateLimitMessage(json.msg) || retryDelay === undefined) {
        throw new Error(`AdsPower API error (${path}): ${json.msg}`);
      }

      await sleep(retryDelay);
    }
  });
}

// La Local API de AdsPower limita a ~1 request/seg; entre páginas de un
// mismo listado esperamos un poco para no pegarle un "Too many request".
const PAGINATION_DELAY_MS = DEFAULT_MIN_REQUEST_INTERVAL_MS;

export const adsPower = {
  async listGroups(page = 1, pageSize = 100) {
    return request<{ list: AdsPowerGroup[] }>("/api/v1/group/list", {
      query: { page, page_size: pageSize },
    });
  },

  /** Recorre todas las páginas y devuelve la lista completa de grupos. */
  async listAllGroups() {
    const pageSize = 100;
    const all: AdsPowerGroup[] = [];
    for (let page = 1; ; page++) {
      if (page > 1) await sleep(PAGINATION_DELAY_MS);
      const { list } = await this.listGroups(page, pageSize);
      all.push(...list);
      if (list.length < pageSize) break;
    }
    return all;
  },

  async createGroup(groupName: string, remark?: string) {
    return request<{ group_id: string }>("/api/v1/group/create", {
      method: "POST",
      body: { group_name: groupName, remark },
    });
  },

  async listProfiles(opts: { groupId?: string; page?: number; pageSize?: number } = {}) {
    return request<{ list: AdsPowerProfile[] }>("/api/v1/user/list", {
      query: {
        group_id: opts.groupId,
        page: opts.page ?? 1,
        page_size: opts.pageSize ?? 100,
      },
    });
  },

  /** Recorre todas las páginas y devuelve la lista completa de perfiles. */
  async listAllProfiles(groupId?: string) {
    const pageSize = 100;
    const all: AdsPowerProfile[] = [];
    for (let page = 1; ; page++) {
      if (page > 1) await sleep(PAGINATION_DELAY_MS);
      const { list } = await this.listProfiles({ groupId, page, pageSize });
      all.push(...list);
      if (list.length < pageSize) break;
    }
    return all;
  },

  /**
   * Crea un perfil de navegador. `fingerprint_config` y `proxy` aceptan
   * cualquier estructura soportada por la Local API (se pasan tal cual).
   */
  async createProfile(input: {
    name: string;
    groupId: string;
    remark?: string;
    proxyConfig?: Record<string, unknown>;
    fingerprintConfig?: Record<string, unknown>;
  }) {
    return request<{ id: string }>("/api/v1/user/create", {
      method: "POST",
      body: {
        name: input.name,
        group_id: input.groupId,
        remark: input.remark,
        // `user_proxy_config`, no `proxy_config`: con el nombre equivocado la
        // API rechaza el alta entera con "user_proxy_config or proxy_id error".
        // Es el mismo nombre que devuelve `user/list` para cada perfil.
        user_proxy_config: input.proxyConfig ?? { proxy_soft: "no_proxy" },
        fingerprint_config: input.fingerprintConfig ?? {},
      },
    });
  },

  async deleteProfiles(profileIds: string[]) {
    return request<null>("/api/v1/user/delete", {
      method: "POST",
      body: { user_ids: profileIds },
    });
  },

  /**
   * Abre el navegador del perfil con una sola pestaña en blanco.
   *
   * Por defecto AdsPower restaura "la plataforma o la página histórica", que
   * en un perfil con meses de uso son todas las pestañas de las tareas
   * anteriores: cada una es una carga de Facebook completa, con el proxy
   * residencial de por medio, antes de que la tarea pueda hacer nada. Y encima
   * abre su propia pestaña de comprobación de IP, que también cuesta.
   *
   * `open_tabs: 1` es "Close" —el flag está al revés de lo que sugiere el
   * nombre, dice si abrir la histórica— y `ip_tab: 0` es no abrir la de la IP.
   * Ver https://localapi-doc-en.adspower.com/docs/FFMFMf.
   *
   * `clear_cache_after_closing: 1` debería vaciar la caché del perfil cuando el
   * navegador se cierra. **No funciona**, y se sigue mandando solo por si alguna
   * versión de AdsPower lo arregla: el 3/9/2026, una hora después de vaciar
   * `~/.cache/adspower_global` a mano, había 133 carpetas de perfil y 5,4 GB,
   * con nunca más de 3 navegadores abiertos a la vez. Cada tarea deja ~40 MB.
   *
   * Que eso se acumule no es cosmético: entre el 7 y el 28 de agosto de 2026
   * llenó los 96 GB del VPS y tiró producción —el `npm ci` del despliegue borró
   * node_modules y ya no tuvo espacio para reinstalarlo—, y volvió a llenarlos
   * el 3/9. De ahí que la caché la borremos nosotros al cerrar el navegador
   * (`disconnectProfile` → `borrarCacheDelPerfil`), con `deploy/podar-cache.sh`
   * por cron como red de seguridad.
   *
   * La contra de borrarla es que cada tarea vuelve a bajar los assets de
   * Facebook por el proxy residencial, que se paga por GB; se aceptó porque lo
   * que se acumula es sobre todo video, y cada tarea mira una publicación
   * distinta, así que esa caché casi nunca se reutilizaba.
   *
   * Ojo: esto solo aplica cuando el navegador arranca. Si ya estaba abierto,
   * AdsPower devuelve la instancia que hay: ni estos flags ni los LAUNCH_ARGS
   * corren, y las pestañas viejas siguen ahí. De eso se ocupa connectToProfile.
   */
  async startBrowser(profileId: string) {
    return request<AdsPowerStartBrowserData>("/api/v1/browser/start", {
      query: {
        user_id: profileId,
        headless: 0,
        open_tabs: 1,
        ip_tab: 0,
        clear_cache_after_closing: 1,
        // La Local API espera el array serializado como JSON dentro del query.
        launch_args: JSON.stringify(LAUNCH_ARGS),
      },
      timeoutMs: START_BROWSER_TIMEOUT_MS,
    });
  },

  async stopBrowser(profileId: string) {
    return request<null>("/api/v1/browser/stop", {
      query: { user_id: profileId },
    });
  },

  async browserStatus(profileId: string) {
    return request<{ status: "Active" | "Inactive" }>("/api/v1/browser/active", {
      query: { user_id: profileId },
    });
  },

  /**
   * Los navegadores abiertos en esta máquina, en UNA sola llamada.
   *
   * Preguntar perfil por perfil con `browserStatus` cuesta ~1.1 seg cada uno
   * por la cola de acá arriba, así que refrescar una página de 20 tenía la cola
   * tomada 22 segundos —y todo lo demás, incluidas las tareas del worker,
   * esperando atrás.
   */
  async localActiveBrowsers() {
    return request<{ list: { user_id: string }[] }>("/api/v1/browser/local-active");
  },
};
