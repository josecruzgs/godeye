import { mkdir } from "node:fs/promises";
import type { Locator, Page } from "playwright-core";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import TaskLogModel from "@/lib/models/TaskLog";
import ProfileModel from "@/lib/models/Profile";
import { connectToProfile, disconnectProfile } from "./browser";

type Step = {
  action:
    | "goto"
    | "click"
    | "hover"
    | "fill"
    | "type"
    | "press"
    | "waitForSelector"
    | "waitForTimeout"
    | "screenshot"
    | "scroll"
    | "uploadFile"
    | "likeComment"
    | "captureComment";
  selector?: string;
  value?: string;
  url?: string;
  key?: string;
  ms?: number;
  // Solo para "likeComment".
  commentId?: string;
  reactionSelector?: string;
  // Si el step falla (ej. un selector que no siempre aparece, como un
  // interstitial de "una sola vez"), se loguea como advertencia y la tarea
  // sigue en vez de terminar en "failed".
  optional?: boolean;
};

const DEFAULT_ACTION_TIMEOUT_MS = 30000;
const DEFAULT_CLICK_TIMEOUT_MS = 8000;
const DEFAULT_GOTO_TIMEOUT_MS = 60000;
const GOTO_DOMCONTENTLOADED_GRACE_MS = 10000;
const VISIBLE_POLL_MS = 250;
const BLOCKER_CHECK_INTERVAL_MS = 1000;

const FACEBOOK_COMMENT_BOX_SELECTOR = [
  'div[role="textbox"][contenteditable="true"][aria-label*="Write a comment"]',
  'div[role="textbox"][contenteditable="true"][aria-label*="Escribe un comentario"]',
  'div[role="textbox"][contenteditable="true"][aria-placeholder*="Write a comment"]',
  'div[role="textbox"][contenteditable="true"][aria-placeholder*="Escribe un comentario"]',
  'div[aria-label*="Write a comment"]',
  'div[aria-label*="Escribe un comentario"]',
  'form div[role="textbox"][contenteditable="true"]',
].join(", ");

/**
 * Cómo se llama el botón que abre los comentarios.
 *
 * Va por coincidencia parcial (`*=`) y no exacta a propósito. En un post normal
 * el botón se llama "Comentar" a secas, pero en el visor de Reels —donde el
 * panel arranca cerrado y hay que abrirlo sí o sí— el rótulo trae el conteo o
 * el contexto ("398 comentarios", "Comentar en el reel"). Con `=` no matcheaba
 * ninguno, el panel nunca se abría, y el fallo aparecía un paso más tarde: como
 * un timeout de la caja de texto, que efectivamente no existía todavía.
 */
const FACEBOOK_COMMENT_OPEN_LABELS = ["Comentario", "Comentar", "Comment"];

const FACEBOOK_COMMENT_OPEN_SELECTOR = FACEBOOK_COMMENT_OPEN_LABELS.flatMap((label) => [
  `[role="button"][aria-label*="${label}"]`,
  `[aria-label*="${label}"]`,
  `div[role="button"]:has(svg[aria-label*="${label}"])`,
  `svg[aria-label*="${label}"]`,
]).join(", ");

/** Igual, pero solo lo enfocable: para el intento por teclado hace falta un botón real, no el <svg> de adentro. */
const FACEBOOK_COMMENT_OPEN_FOCUSABLE_SELECTOR = FACEBOOK_COMMENT_OPEN_LABELS.map(
  (label) => `[role="button"][aria-label*="${label}"]`,
).join(", ");

/**
 * La X de las capas que Facebook encima sobre la publicación.
 *
 * En el visor de Reels aparece un "cuadro de sugerencias" que cubre la columna
 * de acciones: el botón "Comentar" queda visible pero deja de recibir el
 * puntero, así que el click nunca llega y el panel no abre.
 *
 * Se apunta al rótulo específico y NUNCA a un "Cerrar" pelado: ese es el de la
 * X del propio visor de Reels, y clickearlo cerraría la publicación entera,
 * dejando a la tarea escribiendo en cualquier lado. La `i` del final hace la
 * comparación insensible a mayúsculas.
 */
const FACEBOOK_OVERLAY_DISMISS_SELECTOR = [
  '[aria-label*="cuadro de sugerencias" i]',
  '[aria-label*="suggestions box" i]',
  '[aria-label*="suggestion box" i]',
].join(", ");

/**
 * Cómo se llama el botón de reaccionar, por idioma de la interfaz.
 *
 * Facebook rotula sus botones en el idioma del perfil, no en el del país, y los
 * perfiles de AdsPower heredan el idioma que traiga su huella. Un perfil con la
 * huella en francés muestra "J'aime" aunque la cuenta sea mexicana, y el paso
 * fallaba con "0 match(es)" sin ninguna pista de por qué: el botón estaba ahí,
 * con otro nombre.
 */
const FACEBOOK_LIKE_LABELS = [
  "Like",
  "React",
  "Me gusta",
  "Reaccionar",
  "Reacciona",
  "J'aime",
  "Réagir",
  "Curtir",
  "Reagir",
  "Mi piace",
  "Gefällt mir",
];

/** Las que aparecen cuando la reacción YA está puesta — señal de trabajo hecho. */
const FACEBOOK_UNLIKE_LABELS = [
  "Remove Like",
  "Unlike",
  "Quitar Me gusta",
  "Ya no me gusta",
  "Retirer J'aime",
  "Je n'aime plus",
  "Descurtir",
  "Remover Curtir",
  "Non mi piace più",
];

/** Las cinco formas en que Facebook expone el mismo botón según el layout. */
function labelSelectors(labels: string[]): string {
  return labels
    .flatMap((label) => [
      `div[role="dialog"] [aria-label="${label}"]`,
      `[role="button"][aria-label="${label}"]`,
      `[aria-label="${label}"]`,
      `div[role="button"]:has(svg[aria-label="${label}"])`,
      `svg[aria-label="${label}"]`,
    ])
    .join(", ");
}

const FACEBOOK_LIKE_SELECTOR = labelSelectors(FACEBOOK_LIKE_LABELS);
// Solo por etiqueta, sin respaldo por `aria-pressed="true"`: ese atributo lo
// llevan también otros botones de la página, y confundir uno con la reacción
// haría reportar como hecho un like que nunca se dio. Ante un idioma que no
// esté en la lista, es preferible fallar de forma visible.
const FACEBOOK_ALREADY_LIKED_SELECTOR = labelSelectors(FACEBOOK_UNLIKE_LABELS);

/**
 * Atributo temporal con el que el runner marca, dentro de la página, el botón
 * de "Me gusta" del comentario buscado.
 *
 * Reaccionar a un comentario no se puede expresar con un selector CSS suelto:
 * el botón de un comentario es idéntico al del post y al de los demás
 * comentarios, y lo único que los distingue es el ancestro en el que viven.
 * Playwright no sabe subir por el árbol, así que la búsqueda se hace en el
 * navegador (localizar el permalink del comentario → subir a su contenedor →
 * bajar a su botón), se marca el resultado con este atributo y desde ahí se
 * vuelve a la maquinaria normal de clicks, que ya resuelve scroll, visibilidad
 * y capas encima.
 */
const FACEBOOK_COMMENT_LIKE_MARK = "data-godeye-comment-like";

/** Botones de "ver más comentarios/respuestas" que pueden estar escondiendo el comentario. */
const FACEBOOK_MORE_COMMENTS_SELECTOR = [
  "más comentarios",
  "more comments",
  "comentarios anteriores",
  "previous comments",
  "más respuestas",
  "respuesta más",
  "respuestas más",
  "more replies",
]
  .map((text) => `div[role="button"]:has-text("${text}")`)
  .join(", ");

const FACEBOOK_MAX_COMMENT_EXPANSIONS = 4;

type CommentLikeProbe = {
  status: "ready" | "already_liked" | "not_found" | "no_article" | "no_button";
  detail: string;
};

const FACEBOOK_BLOCKERS = [
  {
    label: "cuenta bloqueada",
    text: ["desbloquear tu cuenta", "bloqueamos tu cuenta", "unlock your account", "locked your account"],
  },
  {
    label: "checkpoint de persona real",
    text: [
      "confirma que eres una persona real",
      "ingresa el texto de la imagen",
      "confirm that you are a real person",
      "confirm that you're a real person",
      "enter the text from the image",
    ],
  },
  {
    label: "sesion requerida",
    text: ["iniciar sesion en facebook", "log in to facebook"],
  },
  {
    label: "revision de seguridad",
    text: ["checkpoint", "suspicious activity", "actividad sospechosa"],
  },
];

type ClickableTarget = {
  locator: Locator;
  position: { x: number; y: number };
};

type StepContext = {
  taskId: string;
  profileName: string;
  taskType: string;
  /** Lo llama "captureComment" con el permalink del comentario y el perfil del autor. */
  onResult?: (r: { url: string | null; perfilUrl: string | null }) => void;
  /** La publicación a la que la tarea navegó al arrancar. Ver ensureOnTargetUrl. */
  targetUrl?: string;
};

function normalizePageText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

async function knownFacebookBlocker(page: Page): Promise<string | null> {
  const url = page.url();
  if (!url.includes("facebook.com")) return null;

  const normalizedUrl = url.toLowerCase();
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 1000 })
    .then(normalizePageText)
    .catch(() => "");

  for (const blocker of FACEBOOK_BLOCKERS) {
    if (blocker.text.some((pattern) => bodyText.includes(pattern) || normalizedUrl.includes(pattern))) {
      return `Facebook detuvo este perfil por ${blocker.label}. Requiere accion manual en la cuenta antes de volver a usarla.`;
    }
  }

  return null;
}

async function assertNoKnownBlocker(page: Page) {
  const blocker = await knownFacebookBlocker(page);
  if (blocker) throw new Error(blocker);
}

function isFacebookCommentBoxSelector(selector: string) {
  return /Write a comment|Escribe un comentario/i.test(selector);
}

function isFacebookLikeSelector(selector: string) {
  return FACEBOOK_LIKE_LABELS.some((label) => selector.includes(`aria-label="${label}"`));
}

function selectorForStep(selector: string, ctx: StepContext) {
  if (ctx.taskType === "comment" && isFacebookCommentBoxSelector(selector)) {
    return `${selector}, ${FACEBOOK_COMMENT_BOX_SELECTOR}`;
  }
  if (ctx.taskType === "like" && isFacebookLikeSelector(selector)) {
    return `${selector}, ${FACEBOOK_LIKE_SELECTOR}`;
  }
  return selector;
}

async function hasVisibleLocator(page: Page, selector: string) {
  const locator = page.locator(selector);
  const count = await locator.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    if (await locator.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

/**
 * Los rótulos de los botones visibles de la página.
 *
 * Es puro diagnóstico. Cuando un selector no matchea, el log dice "0 match(es)"
 * y no hay forma de saber si el botón no está o si se llama distinto — averiguarlo
 * costaba bajarse la captura de fallo del servidor y mirarla a ojo. Con esto el
 * propio log trae los nombres reales y el arreglo es agregar el que falte.
 */
async function describeVisibleButtons(page: Page) {
  await defineEsbuildNameHelper(page);
  const labels = await page
    .evaluate(() => {
      const vistos = new Set<string>();
      for (const el of Array.from(document.querySelectorAll('[role="button"], button, svg[aria-label]'))) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (label) vistos.add(label.slice(0, 40));
      }
      return Array.from(vistos).slice(0, 40);
    })
    .catch(() => [] as string[]);

  return labels.length ? labels.map((l) => `"${l}"`).join(", ") : "(ninguno)";
}

/**
 * Vuelve a la publicación de la tarea si el navegador se fue a otra.
 *
 * El visor de Reels se pasa solo al siguiente video cuando termina el actual, y
 * los reels duran segundos. Entre que la tarea abre la página, espera, cierra
 * capas e intenta comentar, es normal que ya esté parada en otro reel: se vio
 * en el log a un perfil buscando el botón de comentar sobre una publicación de
 * otra cuenta.
 *
 * Sin esto, el mejor caso es que falle; el peor, que comente en la publicación
 * equivocada — un error silencioso y mucho más caro que un timeout.
 *
 * Se comparan solo los pathname: el visor le agrega y le saca parámetros a la
 * URL sin cambiar de publicación.
 */
async function ensureOnTargetUrl(page: Page, ctx: StepContext) {
  const objetivo = ctx.targetUrl;
  if (!objetivo) return;

  const rutaDe = (valor: string) => {
    try {
      return new URL(valor).pathname.replace(/\/+$/, "");
    } catch {
      return valor;
    }
  };

  const actual = page.url();
  if (rutaDe(actual) === rutaDe(objetivo)) return;

  await log(ctx.taskId, "warn", `El visor se movió a otra publicación (${actual}); se vuelve a la de la tarea.`);
  await gotoPage(page, objetivo, DEFAULT_GOTO_TIMEOUT_MS, ctx);
  await page.waitForTimeout(2500);
}

/** Cierra la capa de sugerencias, si la hay. Devuelve si cerró alguna. */
async function dismissFacebookOverlays(page: Page, ctx: StepContext) {
  const locator = page.locator(FACEBOOK_OVERLAY_DISMISS_SELECTOR);
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    await candidate.click({ timeout: 2000 }).catch(() => {});
    await log(ctx.taskId, "info", "Se cerró una capa de sugerencias que tapaba la publicación.");
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

/**
 * Abre los comentarios con el teclado en vez del mouse.
 *
 * Último recurso para cuando el botón está pero algo lo tapa: enfocarlo y
 * mandarle Enter no depende de que reciba el puntero. Es el mismo truco que ya
 * usa el paso de "like" cuando detecta que el botón está cubierto.
 */
async function openCommentsWithKeyboard(page: Page, ctx: StepContext) {
  const locator = page.locator(FACEBOOK_COMMENT_OPEN_FOCUSABLE_SELECTOR);
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    try {
      await candidate.focus({ timeout: 2000 });
      await page.keyboard.press("Enter");
      await page.waitForTimeout(1000);
    } catch {
      continue;
    }

    if (await hasVisibleLocator(page, FACEBOOK_COMMENT_BOX_SELECTOR)) {
      await log(ctx.taskId, "info", "Se abrieron los comentarios con el teclado (el botón estaba cubierto).");
      return true;
    }
  }
  return false;
}

const ABRIR_COMENTARIOS_INTENTOS = 3;

async function prepareSelectorTarget(page: Page, rawSelector: string, ctx: StepContext) {
  if (ctx.taskType !== "comment" || !isFacebookCommentBoxSelector(rawSelector)) return;
  if (await hasVisibleLocator(page, FACEBOOK_COMMENT_BOX_SELECTOR)) return;

  // Se reintenta porque en el visor de Reels esto no es determinista: los
  // mismos pasos sobre el mismo reel a veces abren el panel y a veces no,
  // según qué capa haya aparecido, si el video ya se pasó al siguiente, o si
  // la interfaz todavía estaba animando. Un solo intento fallaba seguido.
  for (let intento = 1; intento <= ABRIR_COMENTARIOS_INTENTOS; intento += 1) {
    await ensureOnTargetUrl(page, ctx);

    // Destapar: en los reels el botón de comentar está visible pero debajo del
    // cuadro de sugerencias, y así el click nunca le llega.
    await dismissFacebookOverlays(page, ctx);
    if (await hasVisibleLocator(page, FACEBOOK_COMMENT_BOX_SELECTOR)) return;

    let target: ClickableTarget | null = null;
    try {
      target = await firstClickableLocator(page, FACEBOOK_COMMENT_OPEN_SELECTOR, 2500);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Facebook detuvo este perfil")) throw err;
    }

    if (target) {
      await log(ctx.taskId, "info", "Abriendo panel/caja de comentarios de Facebook.");
      await target.locator.click({ position: target.position, timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(1000);
      if (await hasVisibleLocator(page, FACEBOOK_COMMENT_BOX_SELECTOR)) return;
    }

    // El botón puede seguir tapado por una capa que no sabemos cerrar; el
    // teclado no necesita que reciba el puntero.
    if (await openCommentsWithKeyboard(page, ctx)) return;

    if (intento < ABRIR_COMENTARIOS_INTENTOS) {
      await log(ctx.taskId, "info", `No se abrieron los comentarios; reintento ${intento + 1} de ${ABRIR_COMENTARIOS_INTENTOS}.`);
      await page.waitForTimeout(1500);
    }
  }

  // Salir en silencio dejaba el fallo apareciendo dos pasos después, como un
  // timeout de la caja de texto — que era una consecuencia, no la causa.
  await log(
    ctx.taskId,
    "warn",
    `No se pudo abrir los comentarios. Botones visibles en la página: ${await describeVisibleButtons(page)}`,
  );
}

function isNavigationTimeout(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return /page\.goto: Timeout|Timeout .* exceeded|waiting until "domcontentloaded"/i.test(message);
}

async function gotoPage(page: Page, url: string, timeoutMs: number, ctx: StepContext) {
  const beforeUrl = page.url();
  try {
    await page.goto(url, { waitUntil: "commit", timeout: timeoutMs });
  } catch (err) {
    const currentUrl = page.url();
    const hasUsableDocument =
      currentUrl !== "about:blank" && currentUrl !== beforeUrl && (await page.locator("body").count().catch(() => 0)) > 0;
    if (!isNavigationTimeout(err) || !hasUsableDocument) throw err;

    await log(
      ctx.taskId,
      "warn",
      "La navegacion tardo demasiado, pero la pagina ya tiene documento cargado; se continua con los selectores.",
    );
  }

  await page
    .locator("body")
    .waitFor({ state: "attached", timeout: Math.min(10000, timeoutMs) })
    .catch(() => {});

  await page.waitForLoadState("domcontentloaded", { timeout: GOTO_DOMCONTENTLOADED_GRACE_MS }).catch(() =>
    log(
      ctx.taskId,
      "warn",
      "Facebook no termino domcontentloaded a tiempo; se continua porque la navegacion ya inicio.",
    ),
  );

  await assertNoKnownBlocker(page);
}

async function clickablePosition(locator: Locator): Promise<{ x: number; y: number } | null> {
  const box = await locator.boundingBox().catch(() => null);
  if (!box || box.width <= 0 || box.height <= 0) return null;

  const rawPoints = [
    { x: box.width / 2, y: box.height / 2 },
    { x: Math.min(12, box.width - 1), y: box.height / 2 },
    { x: Math.max(box.width - 12, 1), y: box.height / 2 },
    { x: box.width / 2, y: Math.min(12, box.height - 1) },
    { x: box.width / 2, y: Math.max(box.height - 12, 1) },
  ];
  const points = rawPoints
    .filter((point) => point.x >= 0 && point.y >= 0 && point.x <= box.width && point.y <= box.height)
    .map((point) => ({ ...point, viewportX: box.x + point.x, viewportY: box.y + point.y }));

  if (!points.length) return null;

  return locator
    .evaluate((element, candidates) => {
      for (const point of candidates) {
        if (point.viewportX < 0 || point.viewportY < 0) continue;
        if (point.viewportX > window.innerWidth || point.viewportY > window.innerHeight) continue;

        const topElement = document.elementFromPoint(point.viewportX, point.viewportY);
        if (topElement && (topElement === element || element.contains(topElement))) {
          return { x: point.x, y: point.y };
        }
      }
      return null;
    }, points)
    .catch(() => null);
}

async function firstVisibleLocator(page: Page, selector: string, timeoutMs: number): Promise<Locator> {
  const locator = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  let lastBlockerCheckAt = 0;

  while (Date.now() <= deadline) {
    if (Date.now() - lastBlockerCheckAt >= BLOCKER_CHECK_INTERVAL_MS) {
      lastBlockerCheckAt = Date.now();
      await assertNoKnownBlocker(page);
    }

    lastCount = await locator.count();

    for (let i = 0; i < lastCount; i += 1) {
      const candidate = locator.nth(i);
      if (await candidate.isVisible().catch(() => false)) {
        return candidate;
      }
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await page.waitForTimeout(Math.min(VISIBLE_POLL_MS, remainingMs));
  }

  await assertNoKnownBlocker(page);
  throw new Error(
    `Timeout ${timeoutMs}ms esperando elemento visible para selector "${selector}" (${lastCount} match(es), ninguno visible)`,
  );
}

async function firstClickableLocator(page: Page, selector: string, timeoutMs: number): Promise<ClickableTarget> {
  const locator = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  let visibleCount = 0;
  let lastBlockerCheckAt = 0;

  while (Date.now() <= deadline) {
    if (Date.now() - lastBlockerCheckAt >= BLOCKER_CHECK_INTERVAL_MS) {
      lastBlockerCheckAt = Date.now();
      await assertNoKnownBlocker(page);
    }

    lastCount = await locator.count();
    visibleCount = 0;

    for (let i = 0; i < lastCount; i += 1) {
      const candidate = locator.nth(i);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      visibleCount += 1;

      await candidate.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      const position = await clickablePosition(candidate);
      if (position) return { locator: candidate, position };
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await page.waitForTimeout(Math.min(VISIBLE_POLL_MS, remainingMs));
  }

  await assertNoKnownBlocker(page);
  throw new Error(
    `Timeout ${timeoutMs}ms esperando elemento clickeable para selector "${selector}" (${lastCount} match(es), ${visibleCount} visible(s), ninguno recibe el puntero)`,
  );
}

/**
 * Busca el comentario en el DOM y deja marcado su botón de reaccionar.
 *
 * Corre entero dentro del navegador porque necesita `closest()`: se parte del
 * ancla del permalink (el "hace 2 h" de cada comentario, cuyo href lleva el
 * `comment_id`), se sube al `role="article"` que lo contiene — que es el
 * comentario, no el post — y ahí adentro se busca el botón cuyo rótulo o texto
 * sea "Me gusta" en alguno de los idiomas conocidos, descartando los que
 * pertenecen a respuestas anidadas.
 */
/**
 * Define en la página el helper `__name` que espera el código compilado.
 *
 * El worker corre bajo `tsx`, que transpila con esbuild, y esbuild envuelve
 * cada función con nombre en `__name(fn, "fn")` para que `fn.name` sobreviva a
 * la minificación. Ese helper se declara arriba del módulo, en Node — pero
 * Playwright serializa la función que se le pasa a `evaluate` y la manda sola
 * al navegador, sin el helper, así que la página revienta con "__name is not
 * defined" apenas el cuerpo declara una función con nombre. La web no lo sufre
 * porque el runner solo se ejecuta en el worker.
 *
 * Se manda como string a propósito: un string no pasa por esbuild, así que no
 * puede arrastrar la misma dependencia que viene a resolver. Y se reinyecta en
 * cada llamada porque cada navegación estrena el contexto de la página.
 */
async function defineEsbuildNameHelper(page: Page) {
  await page.evaluate("void (globalThis.__name = globalThis.__name || ((fn) => fn))");
}

/**
 * Busca en la página el comentario que contiene un texto y devuelve su
 * permalink.
 *
 * Se usa para comprobar que un comentario recién publicado existe de verdad.
 * Antes de esto la tarea se daba por exitosa apenas terminaba de teclear: si
 * Facebook lo descartaba en silencio —cosa que hace— quedaba como "EXITOSA"
 * igual.
 *
 * Corre entero dentro del navegador porque necesita `closest()` y comparar el
 * texto renderizado. Dos detalles del DOM de Facebook:
 *
 * - El post entero también es un `role="article"` y contiene el texto de todos
 *   sus comentarios, así que matchea igual que el comentario buscado. Por eso
 *   se descarta cualquier candidato que contenga a otro: el bueno es el más
 *   adentro.
 * - El `comment_id` no está en el comentario sino en el href del ancla de la
 *   fecha ("hace 2 h"), el mismo del que se cuelga markFacebookCommentLike.
 *
 * Devuelve null si no lo encuentra; el que llama decide si eso es un fallo.
 */
type CommentProbe = { encontrado: boolean; url: string | null; perfilUrl: string | null };

async function findPublishedComment(page: Page, texto: string): Promise<CommentProbe> {
  await defineEsbuildNameHelper(page);
  return page.evaluate((texto: string): CommentProbe => {
    const ausente: CommentProbe = { encontrado: false, url: null, perfilUrl: null };

    // Se comparan solo letras y números. Facebook reescribe lo que uno tipea
    // antes de renderizarlo —":)" sale como 🙂, y ahí una comparación literal
    // deja de encontrar el comentario que sí se publicó— y también toca
    // espacios y puntuación. Lo que sobrevive intacto son las palabras.
    const normalizar = (valor: string) =>
      valor
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();

    const buscado = normalizar(texto);
    if (!buscado) return ausente;
    if (!normalizar(document.body?.textContent ?? "").includes(buscado)) return ausente;

    // Se baja desde <body> al descendiente más chico que sigue conteniendo el
    // texto, en vez de recorrer todos los nodos preguntando por su contenido:
    // eso sería cuadrático sobre una página de Facebook.
    let comentario: Element = document.body;
    descender: for (;;) {
      for (const hijo of Array.from(comentario.children)) {
        if (normalizar(hijo.textContent ?? "").includes(buscado)) {
          comentario = hijo;
          continue descender;
        }
      }
      break;
    }

    // Los enlaces del comentario están fuera del texto (son hermanos, no
    // descendientes), así que se sube hasta el primer contenedor que tenga
    // alguno con `comment_id`.
    let contenedor: Element | null = comentario;
    let anclas: HTMLAnchorElement[] = [];
    for (let nivel = 0; nivel < 6 && contenedor; nivel += 1) {
      const encontradas = Array.from(contenedor.querySelectorAll("a[href]")) as HTMLAnchorElement[];
      if (encontradas.some((el) => /(^|[?&])(reply_)?comment_id=/.test(el.getAttribute("href") ?? ""))) {
        anclas = encontradas;
        break;
      }
      contenedor = contenedor.parentElement;
    }

    const absoluta = (el: HTMLAnchorElement) => {
      try {
        return new URL(el.getAttribute("href") ?? "", location.origin).href;
      } catch {
        return null;
      }
    };

    // Dentro de un comentario hay al menos dos enlaces y los DOS llevan
    // `comment_id`: el del nombre del autor y el de la hora. Solo el de la hora
    // es el permalink; el del nombre abre el perfil. Se distinguen por el
    // texto: la hora es corta y relativa ("2 min", "18 h", "Ahora").
    // Exige un número (o "ahora"). Sin eso, "Responder" —que también es un
    // enlace dentro del comentario— pasaba por hora.
    const esHora = (valor: string) =>
      valor.length <= 14 && /^(ahora|(hace\s+)?\d+\s*[a-záéíóú]{0,10})$/i.test(valor);

    const conComentario = anclas.filter((el) => /(^|[?&])(reply_)?comment_id=/.test(el.getAttribute("href") ?? ""));
    const permalink =
      conComentario.find((el) => esHora((el.textContent ?? "").trim())) ?? conComentario[conComentario.length - 1];

    // El perfil del que comentó: el enlace del nombre. Se le sacan los
    // parámetros, que traen el comment_id y basura de seguimiento.
    const autor = anclas.find((el) => {
      const texto = (el.textContent ?? "").trim();
      return texto.length > 0 && !esHora(texto);
    });

    let perfilUrl: string | null = null;
    if (autor) {
      const cruda = absoluta(autor);
      if (cruda) {
        try {
          const u = new URL(cruda);
          perfilUrl = `${u.origin}${u.pathname}`;
        } catch {
          perfilUrl = cruda;
        }
      }
    }

    // Que no haya permalink no significa que el comentario no esté: recién
    // publicado Facebook tarda en darle enlace propio, y en el panel de un reel
    // a veces no se lo da nunca. Por eso el hallazgo y el link van separados.
    return { encontrado: true, url: permalink ? absoluta(permalink) : null, perfilUrl };
  }, texto);
}

/**
 * Lo mismo, pero reintentando: el comentario tarda en aparecer en el DOM
 * después de enviarlo, y cuánto depende de la red y de lo cargada que esté la
 * publicación. Un timeout fijo sería o muy corto o desperdicio de tiempo.
 */
async function waitForPublishedComment(page: Page, texto: string, timeoutMs: number): Promise<CommentProbe> {
  const limite = Date.now() + timeoutMs;
  let ultimo: CommentProbe = { encontrado: false, url: null, perfilUrl: null };
  for (;;) {
    ultimo = await findPublishedComment(page, texto);
    // Con el comentario ya encontrado se sigue esperando un poco por su
    // enlace, que aparece después — pero sin dejar que la falta de enlace
    // consuma todo el tiempo restante.
    if (ultimo.url) return ultimo;
    if (Date.now() >= limite) return ultimo;
    await page.waitForTimeout(VISIBLE_POLL_MS * 4);
  }
}

async function markFacebookCommentLike(page: Page, commentId: string): Promise<CommentLikeProbe> {
  await defineEsbuildNameHelper(page);
  return page.evaluate(
    ({ commentId, mark, likeLabels, unlikeLabels }): CommentLikeProbe => {
      // Comparación insensible a mayúsculas y a acentos ("Gefällt mir" vs
      // "gefallt mir"): la interfaz de Facebook no siempre respeta el
      // capitalizado del rótulo entre layouts.
      const sameLabel = (value: string, label: string) =>
        value.trim().localeCompare(label, undefined, { sensitivity: "base" }) === 0;
      const matchesAny = (value: string, labels: string[]) =>
        Boolean(value.trim()) && labels.some((label) => sameLabel(value, label));

      for (const marked of Array.from(document.querySelectorAll(`[${mark}]`))) {
        marked.removeAttribute(mark);
      }

      // El href del DOM puede traer el id escapado (`%3D` del padding base64)
      // y el link del que salió, decodificado — o al revés. Se prueban las dos
      // formas contra las dos versiones del href.
      const wantedIds = [commentId];
      const encoded = encodeURIComponent(commentId);
      if (encoded !== commentId) wantedIds.push(encoded);

      const patterns = wantedIds.map(
        (id) => new RegExp(`(^|[?&])(reply_)?comment_id=${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(&|#|$)`),
      );

      const hrefMatches = (href: string) => {
        const variants = [href];
        try {
          const decoded = decodeURIComponent(href);
          if (decoded !== href) variants.push(decoded);
        } catch {
          // href con escapes inválidos: basta con la forma cruda
        }
        return variants.some((variant) => patterns.some((pattern) => pattern.test(variant)));
      };

      const anchors = Array.from(document.querySelectorAll("a[href]")).filter((a) =>
        hrefMatches(a.getAttribute("href") ?? ""),
      );
      if (!anchors.length) {
        const articles = document.querySelectorAll('[role="article"]').length;
        return { status: "not_found", detail: `${articles} comentario(s) renderizado(s) en la página` };
      }

      // El mismo id puede aparecer en más de un link (el permalink del
      // comentario, un "responder", el menú de compartir): sirve el primero que
      // esté realmente dentro de un comentario.
      const article = anchors.map((a) => a.closest('[role="article"]')).find(Boolean);
      if (!article) {
        return {
          status: "no_article",
          detail: `${anchors.length} link(s) con ese id, ninguno dentro de un contenedor de comentario`,
        };
      }

      // Los botones de las respuestas viven en artículos anidados: solo cuentan
      // los que tienen a este artículo como contenedor más cercano.
      const buttons = Array.from(article.querySelectorAll('[role="button"]')).filter(
        (button) => button.closest('[role="article"]') === article,
      );

      const labelOf = (el: Element) => el.getAttribute("aria-label") ?? "";
      const textOf = (el: Element) => (el as HTMLElement).innerText || el.textContent || "";
      const isLikeButton = (el: Element) =>
        matchesAny(labelOf(el), likeLabels) || matchesAny(textOf(el), likeLabels);

      const liked = buttons.find(
        (button) =>
          matchesAny(labelOf(button), unlikeLabels) ||
          (button.getAttribute("aria-pressed") === "true" && isLikeButton(button)),
      );
      if (liked) return { status: "already_liked", detail: "" };

      const likeButton = buttons.find(isLikeButton);
      if (!likeButton) {
        return {
          status: "no_button",
          detail: `${buttons.length} botón(es) en el comentario, ninguno rotulado como "Me gusta"`,
        };
      }

      likeButton.setAttribute(mark, "1");
      // El picker de reacciones se abre hacia arriba: el comentario tiene que
      // quedar a media pantalla para que quepa.
      article.scrollIntoView({ block: "center" });
      return { status: "ready", detail: "" };
    },
    {
      commentId,
      mark: FACEBOOK_COMMENT_LIKE_MARK,
      likeLabels: FACEBOOK_LIKE_LABELS,
      unlikeLabels: FACEBOOK_UNLIKE_LABELS,
    },
  );
}

/**
 * Reintenta la búsqueda mientras el comentario no aparezca: Facebook carga los
 * comentarios de a poco y el que se busca puede estar detrás de un "Ver más
 * comentarios", sobre todo en publicaciones con mucha conversación.
 */
async function resolveFacebookCommentLike(
  page: Page,
  commentId: string,
  timeoutMs: number,
  ctx: StepContext,
): Promise<CommentLikeProbe> {
  const deadline = Date.now() + timeoutMs;
  let probe = await markFacebookCommentLike(page, commentId);
  let expansions = 0;

  while (probe.status === "not_found" && Date.now() < deadline) {
    await assertNoKnownBlocker(page);

    if (expansions < FACEBOOK_MAX_COMMENT_EXPANSIONS && (await hasVisibleLocator(page, FACEBOOK_MORE_COMMENTS_SELECTOR))) {
      expansions += 1;
      await log(ctx.taskId, "info", `El comentario aún no está cargado; abriendo más comentarios (intento ${expansions}).`);
      const target = await firstClickableLocator(page, FACEBOOK_MORE_COMMENTS_SELECTOR, 3000).catch(() => null);
      if (target) await target.locator.click({ position: target.position, timeout: 3000 }).catch(() => {});
    }

    await page.waitForTimeout(1000);
    probe = await markFacebookCommentLike(page, commentId);
  }

  return probe;
}

function commentProbeError(probe: CommentLikeProbe, commentId: string) {
  const suffix = probe.detail ? ` (${probe.detail})` : "";
  switch (probe.status) {
    case "not_found":
      return `No se encontró el comentario ${commentId} en la página${suffix}. Revisa que el link siga vivo y que el perfil pueda ver la publicación.`;
    case "no_article":
      return `Se encontró el link del comentario ${commentId} pero no su contenedor${suffix}.`;
    case "no_button":
      return `El comentario ${commentId} está en la página pero no expone un botón de "Me gusta" reconocible${suffix}. Suele ser la interfaz del perfil en un idioma que el runner no tiene mapeado.`;
    default:
      return `No se pudo preparar el like del comentario ${commentId}${suffix}.`;
  }
}

async function runStep(page: Page, step: Step, ctx: StepContext) {
  switch (step.action) {
    case "goto":
      if (!step.url) throw new Error("Step 'goto' requiere 'url'");
      await gotoPage(page, step.url, step.ms ?? DEFAULT_GOTO_TIMEOUT_MS, ctx);
      return;
    case "click":
      if (!step.selector) throw new Error("Step 'click' requiere 'selector'");
      {
        const timeoutMs = step.ms ?? DEFAULT_CLICK_TIMEOUT_MS;
        const selector = selectorForStep(step.selector, ctx);
        await prepareSelectorTarget(page, step.selector, ctx);
        try {
          const target = await firstClickableLocator(page, selector, timeoutMs);
          await target.locator.click({ position: target.position, timeout: timeoutMs });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);

          // Una publicación que ya tiene la reacción no muestra el botón de
          // dar like, sino el de quitarla. Eso es la tarea cumplida, no un
          // fallo: reportarlo como error obliga a revisar a mano algo que ya
          // estaba hecho.
          if (
            ctx.taskType === "like" &&
            (await hasVisibleLocator(page, FACEBOOK_ALREADY_LIKED_SELECTOR))
          ) {
            await log(ctx.taskId, "info", "La publicación ya tenía la reacción puesta; nada que hacer.");
            return;
          }

          const pointerBlocked = /ninguno recibe el puntero|intercepts pointer events/i.test(message);

          // La caja de comentario visible pero cubierta. Alcanza con enfocarla:
          // el paso `type` que viene después escribe con el teclado, que no
          // necesita el puntero, y su propio click ya va con catch. Se enfoca
          // en vez de mandar Enter como en el like — acá Enter enviaría un
          // comentario vacío.
          //
          // Antes de rendirse se reintenta destapar: al abrir el panel de
          // comentarios Facebook a veces encima una capa nueva, distinta de la
          // que se cerró para llegar hasta acá.
          if (ctx.taskType === "comment" && pointerBlocked && isFacebookCommentBoxSelector(step.selector)) {
            if (await dismissFacebookOverlays(page, ctx)) {
              const reintento = await firstClickableLocator(page, selector, 3000).catch(() => null);
              if (reintento) {
                await reintento.locator.click({ position: reintento.position, timeout: timeoutMs });
                return;
              }
            }

            await log(
              ctx.taskId,
              "warn",
              "La caja de comentario está visible pero cubierta por otra capa; se la enfoca con teclado y se escribe igual.",
            );
            const fallback = await firstVisibleLocator(page, selector, Math.min(3000, timeoutMs));
            await fallback.focus({ timeout: 3000 });
            return;
          }

          if (ctx.taskType !== "like" || !pointerBlocked) throw err;

          await log(
            ctx.taskId,
            "warn",
            "El botón de like está visible pero cubierto por otra capa; se intenta activarlo con teclado.",
          );
          const fallback = await firstVisibleLocator(page, selector, Math.min(3000, timeoutMs));
          await fallback.focus({ timeout: 3000 });
          await page.keyboard.press("Enter");
          await page.waitForTimeout(700);
        }
      }
      return;
    case "captureComment": {
      const texto = step.value?.trim();
      if (!texto) throw new Error("Step 'captureComment' requiere 'value' con el texto publicado");

      const probe = await waitForPublishedComment(page, texto, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
      if (!probe.encontrado) {
        throw new Error(
          "El comentario no apareció en la publicación después de enviarlo. Puede que Facebook lo haya " +
            "descartado, que el perfil esté limitado, o que la publicación no permita comentar.",
        );
      }

      ctx.onResult?.({ url: probe.url, perfilUrl: probe.perfilUrl });

      // Lo que se verifica es que el comentario esté. El permalink es un
      // extra: en el panel de un reel Facebook a veces no le da enlace propio,
      // y quedarse sin él no es motivo para dar la tarea por fallida.
      await log(
        ctx.taskId,
        "info",
        probe.url
          ? `Comentario publicado y verificado: ${probe.url}`
          : "Comentario publicado y verificado (Facebook no le dio enlace propio).",
      );
      return;
    }
    case "likeComment": {
      const commentId = step.commentId?.trim();
      if (!commentId) throw new Error("Step 'likeComment' requiere 'commentId'");

      const timeoutMs = step.ms ?? DEFAULT_ACTION_TIMEOUT_MS;
      const probe = await resolveFacebookCommentLike(page, commentId, timeoutMs, ctx);

      // Volver a clickear un "Me gusta" ya puesto lo quita: si el comentario
      // ya trae la reacción, la tarea está cumplida y no se toca nada.
      if (probe.status === "already_liked") {
        await log(ctx.taskId, "info", "El comentario ya tenía la reacción puesta; nada que hacer.");
        return;
      }
      if (probe.status !== "ready") throw new Error(commentProbeError(probe, commentId));

      const markedSelector = `[${FACEBOOK_COMMENT_LIKE_MARK}]`;
      const target = await firstClickableLocator(page, markedSelector, DEFAULT_CLICK_TIMEOUT_MS);

      if (step.reactionSelector) {
        await target.locator.hover({ position: target.position, timeout: DEFAULT_CLICK_TIMEOUT_MS });
        await page.waitForTimeout(800);
        const reaction = await firstClickableLocator(page, step.reactionSelector, 5000);
        await reaction.locator.click({ position: reaction.position, timeout: DEFAULT_CLICK_TIMEOUT_MS });
        return;
      }

      try {
        await target.locator.click({ position: target.position, timeout: DEFAULT_CLICK_TIMEOUT_MS });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/intercepts pointer events/i.test(message)) throw err;

        await log(
          ctx.taskId,
          "warn",
          "El botón de like del comentario está cubierto por otra capa; se intenta activarlo con teclado.",
        );
        await target.locator.focus({ timeout: 3000 });
        await page.keyboard.press("Enter");
        await page.waitForTimeout(700);
      }
      return;
    }
    case "hover":
      // Dispara el picker de reacciones de Facebook (aparece al mantener el
      // cursor sobre el botón de "Me gusta" en vez de clickearlo directo).
      // Usa firstClickableLocator (igual que "click") en vez de
      // firstVisibleLocator: un post abierto en dialog suele tener la barra
      // de reacciones fuera del scroll interno del modal, y isVisible() no
      // detecta eso — hacía falta el scrollIntoViewIfNeeded + validación de
      // "recibe el puntero" que ya tiene firstClickableLocator.
      if (!step.selector) throw new Error("Step 'hover' requiere 'selector'");
      {
        const timeoutMs = step.ms ?? DEFAULT_ACTION_TIMEOUT_MS;
        const selector = selectorForStep(step.selector, ctx);
        await prepareSelectorTarget(page, step.selector, ctx);
        const target = await firstClickableLocator(page, selector, timeoutMs);
        await target.locator.hover({ position: target.position, timeout: timeoutMs });
      }
      return;
    case "fill":
      if (!step.selector) throw new Error("Step 'fill' requiere 'selector'");
      {
        const selector = selectorForStep(step.selector, ctx);
        await prepareSelectorTarget(page, step.selector, ctx);
        const target = await firstVisibleLocator(page, selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
        await target.fill(step.value ?? "", { timeout: step.ms ?? DEFAULT_ACTION_TIMEOUT_MS });
      }
      return;
    case "type":
      if (!step.selector) throw new Error("Step 'type' requiere 'selector'");
      {
        const selector = selectorForStep(step.selector, ctx);
        await prepareSelectorTarget(page, step.selector, ctx);
        const target = await firstVisibleLocator(page, selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
        await target.click({ timeout: 5000 }).catch(() => {});
        await target.type(step.value ?? "", { delay: 60, timeout: step.ms ?? DEFAULT_ACTION_TIMEOUT_MS });
      }
      return;
    case "press":
      if (!step.key) throw new Error("Step 'press' requiere 'key'");
      if (step.selector) {
        const selector = selectorForStep(step.selector, ctx);
        await prepareSelectorTarget(page, step.selector, ctx);
        const target = await firstVisibleLocator(page, selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
        await target.press(step.key, { timeout: step.ms ?? DEFAULT_ACTION_TIMEOUT_MS });
      } else {
        await page.keyboard.press(step.key);
      }
      return;
    case "waitForSelector":
      if (!step.selector) throw new Error("Step 'waitForSelector' requiere 'selector'");
      {
        const selector = selectorForStep(step.selector, ctx);
        await prepareSelectorTarget(page, step.selector, ctx);
        await firstVisibleLocator(page, selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
      }
      return;
    case "waitForTimeout":
      await page.waitForTimeout(step.ms ?? 1000);
      await assertNoKnownBlocker(page);
      return;
    case "scroll":
      await page.mouse.wheel(0, step.ms ?? 800);
      return;
    case "uploadFile":
      if (!step.selector) throw new Error("Step 'uploadFile' requiere 'selector'");
      if (!step.value) throw new Error("Step 'uploadFile' requiere 'value' (ruta del archivo)");
      await page.setInputFiles(step.selector, step.value);
      return;
    case "screenshot": {
      await mkdir("./screenshots", { recursive: true });
      const safeProfileName = ctx.profileName.replace(/[^a-z0-9-_]+/gi, "_");
      await page.screenshot({ path: `./screenshots/${ctx.taskId}_${safeProfileName}_${Date.now()}.png` });
      return;
    }
    default:
      throw new Error(`Acción desconocida: ${(step as Step).action}`);
  }
}

async function log(taskId: string, level: "info" | "warn" | "error", message: string) {
  await TaskLogModel.create({ taskId, level, message });
}

async function captureFailureScreenshot(page: Page | undefined, taskId: string, profileName: string) {
  if (!page) return;
  await mkdir("./screenshots/errors", { recursive: true });
  const safeProfileName = profileName.replace(/[^a-z0-9-_]+/gi, "_");
  const path = `./screenshots/errors/${taskId}_${safeProfileName}_${Date.now()}.png`;
  await page.screenshot({ path, fullPage: false });
  await log(taskId, "info", `Screenshot de fallo guardado en ${path}`);
}

/**
 * Ejecuta una tarea de principio a fin: abre el perfil en AdsPower,
 * corre cada step contra la página y cierra el navegador al terminar
 * (éxito o error).
 */
export async function runTask(taskId: string) {
  await dbConnect();
  const task = await TaskModel.findById(taskId);
  if (!task) throw new Error(`Task ${taskId} no encontrada`);

  const profile = await ProfileModel.findById(task.profileId);
  if (!profile) throw new Error(`Profile ${task.profileId} no encontrado`);

  task.status = "running";
  task.startedAt = new Date();
  await task.save();
  await log(taskId, "info", `Iniciando tarea "${task.name}" en perfil ${profile.name}`);

  // La publicación de la tarea: a dónde volver si el visor de Reels se pasa
  // solo a otro video mientras la tarea trabaja.
  const targetUrl = (task.steps as Step[]).find((s) => s.action === "goto" && s.url)?.url;

  let browser;
  let page: Page | undefined;
  try {
    const connection = await connectToProfile(profile.adsPowerProfileId);
    browser = connection.browser;
    page = connection.page;

    for (const [i, step] of task.steps.entries()) {
      const s = step as Step;
      await log(taskId, "info", `Step ${i + 1}/${task.steps.length}: ${s.action}${s.optional ? " (opcional)" : ""}`);
      try {
        await runStep(page, s, {
          taskId,
          profileName: profile.name,
          taskType: task.type,
          targetUrl,
          onResult: ({ url, perfilUrl }) => {
            if (url) task.resultUrl = url;
            if (perfilUrl) task.resultProfileUrl = perfilUrl;
          },
        });
      } catch (err) {
        if (!s.optional) throw err;
        const message = err instanceof Error ? err.message : String(err);
        await log(taskId, "warn", `Step opcional ${i + 1} no aplicó, se continúa: ${message}`);
      }
    }

    task.status = "success";
    await log(taskId, "info", "Tarea completada con éxito");
  } catch (err) {
    task.status = "failed";
    task.error = err instanceof Error ? err.message : String(err);
    await log(taskId, "error", task.error);
    await captureFailureScreenshot(page, taskId, profile.name).catch((screenshotErr) =>
      log(
        taskId,
        "warn",
        `No se pudo guardar screenshot de fallo: ${
          screenshotErr instanceof Error ? screenshotErr.message : String(screenshotErr)
        }`,
      ),
    );
  } finally {
    task.finishedAt = new Date();
    await task.save();
    if (browser) await disconnectProfile(browser, profile.adsPowerProfileId);
  }

  return task;
}
