import { mkdir } from "node:fs/promises";
import type { Locator, Page } from "playwright-core";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import CampaignModel from "@/lib/models/Campaign";
import TaskLogModel from "@/lib/models/TaskLog";
import ProfileModel from "@/lib/models/Profile";
import { connectToProfile, disconnectProfile } from "./browser";
import {
  INSTAGRAM_COMMENT_BOX_SELECTOR,
  INSTAGRAM_COMMENT_OPEN_SELECTOR,
  INSTAGRAM_DISMISS_SELECTOR,
  platformFromUrl,
} from "./socialSelectors";
import { parseFacebookCommentTarget } from "@/lib/commentLinks";
import { leerNombreGrupo, unirseAlGrupo, type JoinGroupResult, type Persona } from "./groupJoin";

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
    | "captureComment"
    | "replyComment"
    | "joinGroup"
    | "followProfile"
    | "readGroupName";
  selector?: string;
  value?: string;
  url?: string;
  key?: string;
  ms?: number;
  // Para "likeComment" y "replyComment".
  commentId?: string;
  reactionSelector?: string;
  /**
   * El `commentId` —y la `url` del goto— salen del comentario que publicó la
   * tarea padre, no se saben al crear la campaña. Los resuelve runTask antes
   * de ejecutar. Ver Ramificaciones.
   */
  fromParent?: boolean;
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
const FACEBOOK_FOLLOW_MARK = "data-godeye-follow-profile";

const FACEBOOK_COMMENT_BOX_SELECTOR = [
  'div[role="textbox"][contenteditable="true"][aria-label*="Write a comment"]',
  'div[role="textbox"][contenteditable="true"][aria-label*="Escribe un comentario"]',
  'div[role="textbox"][contenteditable="true"][aria-placeholder*="Write a comment"]',
  'div[role="textbox"][contenteditable="true"][aria-placeholder*="Escribe un comentario"]',
  'div[aria-label*="Write a comment"]',
  'div[aria-label*="Escribe un comentario"]',
  'form div[role="textbox"][contenteditable="true"]',
  // "Comenta como Johana…" en el build actual; en minúsculas y por subcadena
  // para que alcance también a "Comment as…" y "Escribe un comentario…".
  'div[role="textbox"][contenteditable="true"][aria-label*="coment" i]',
  'div[role="textbox"][contenteditable="true"][aria-label*="comment" i]',
  'div[role="textbox"][contenteditable="true"][aria-placeholder*="coment" i]',
  'div[role="textbox"][contenteditable="true"][aria-placeholder*="comment" i]',
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
  "Eliminar Me gusta",
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

/**
 * El mismo truco, para el botón de reaccionar de la publicación.
 *
 * Hizo falta porque Facebook tiene builds en los que la barra de acciones del
 * post no lleva `aria-label`: el botón es un `div[role="button"]` con el texto
 * "Me gusta" adentro y nada más. Ahí los once idiomas mapeados daban igual —el
 * selector devolvía "0 match(es)" con el botón en pantalla— y encima la barra
 * suele quedar por debajo del scroll interno del dialog, sin renderizar todavía.
 *
 * Buscarlo por texto suelto sería peligroso: los comentarios también tienen un
 * "Me gusta". Lo que lo distingue es la compañía —el botón del post vive en la
 * misma fila que "Comentar" y "Compartir", el de un comentario vive al lado de
 * "Responder"—, así que la búsqueda exige esa fila.
 */
const FACEBOOK_POST_LIKE_MARK = "data-godeye-post-like";

/** El de la publicación que YA tiene la reacción puesta. Ver FACEBOOK_POST_LIKE_MARK. */
const FACEBOOK_POST_LIKED_MARK = "data-godeye-post-liked";

/**
 * Cómo se llama el botón de reaccionar cuando Facebook lo rotula con una frase
 * entera en vez de con una palabra.
 *
 * FACEBOOK_LIKE_LABELS —los rótulos sueltos, "Me gusta"/"Like"— sirvió mientras
 * el botón se llamó así. En el build que está sirviendo ahora el rótulo es
 * "Reaccionar a la publicación de Dale Poder al Poder": lleva el nombre del
 * autor adentro, así que no hay lista de rótulos exactos que lo alcance y el
 * selector devolvía "0 match(es)" con el botón a la vista.
 *
 * Van anclados al principio de la frase y no como subcadena suelta a propósito.
 * "Me gusta" aparece también en "Me gusta: 8 personas" —el contador, que abre
 * la lista de quién reaccionó— y clickear eso daría la tarea por hecha sin
 * haber reaccionado a nada. Las anclas son las que separan el botón del
 * contador.
 *
 * Se comparan contra el rótulo normalizado: en minúsculas y sin acentos.
 *
 * En el visor de reels el pulgar se rotula con su contador después de una coma
 * ("Like, 3 reactions", "Me gusta, 3 reacciones"), y al lado hay un "React" de
 * 16 px —la flechita que abre el selector— que queda tapado hasta que el mouse
 * pasa por el pulgar. Sin la coma en los exactos se elegía esa flechita: el
 * hover de las reacciones ("Me enoja", "Me encanta"…) esperaba quince segundos
 * a que recibiera el puntero y fallaban todas. La coma —no los dos puntos— es
 * lo que lo separa del contador "Me gusta: 8 personas" de arriba.
 */
const FACEBOOK_LIKE_ARIA_PATTERNS = [
  "^reaccionar\\b",
  "^react\\b",
  "^reagir\\b",
  "^reagire\\b",
  "^reagieren\\b",
  "^indicar que te gusta",
  "^me gusta(, [^:]*)?$",
  "^like(, [^:]*)?$",
  "^j'aime(, [^:]*)?$",
  "^curtir(, [^:]*)?$",
  "^mi piace(, [^:]*)?$",
  "^gefallt mir(, [^:]*)?$",
];

/**
 * Y cómo se llama cuando la reacción YA está puesta.
 *
 * Se miran antes que los de arriba: "Quitar Me gusta de la publicación de X"
 * empieza por otra palabra, pero un patrón mal escrito que lo dejara pasar
 * haría que la tarea quitara la reacción en vez de ponerla — un fallo que se
 * reporta como éxito.
 */
const FACEBOOK_UNLIKE_ARIA_PATTERNS = [
  "quitar me gusta",
  "quitar la reaccion",
  // El build actual: "Eliminar Me gusta de la publicación de X" y, al lado,
  // "Cambiar reacción Me gusta". Sin estos, un post ya reaccionado no se
  // reconocía como tal y la tarea fallaba con "no se encontró el botón".
  "^eliminar me gusta",
  "^eliminar (la )?reaccion",
  "^cambiar (la )?reaccion",
  "^change reaction",
  "^remove reaction",
  "ya no me gusta",
  "^unlike",
  "remove like",
  "descurtir",
  "remover curtir",
  "je n'aime plus",
  "retirer j'aime",
  "non mi piace piu",
  "gefallt mir nicht mehr",
];

/** Los vecinos que delatan a la barra de acciones de una publicación. */
const FACEBOOK_ACTION_ROW_LABELS = [
  "Comentar",
  "Comment",
  "Comentario",
  "Commenter",
  "Compartir",
  "Share",
  "Partager",
  "Compartilhar",
  "Condividi",
  "Teilen",
];

/** Cómo se rotula el botón de responder, por idioma de la interfaz. */
const FACEBOOK_REPLY_LABELS = [
  "Responder",
  "Reply",
  "Répondre",
  "Rispondi",
  "Antworten",
  "Responder a",
];

/** El mismo truco del marcado, para el botón de responder. Ver FACEBOOK_COMMENT_LIKE_MARK. */
const FACEBOOK_COMMENT_REPLY_MARK = "data-godeye-comment-reply";

/**
 * La caja de una respuesta, que NO es la del post.
 *
 * Al abrir "Responder" aparece un segundo `textbox` rotulado con "respuesta"
 * en vez de "comentario". Reutilizar el selector del comentario escribía en la
 * caja del post —o sea, un comentario suelto en vez de una respuesta al hilo—,
 * que es justo lo que Ramificaciones no quiere.
 */
const FACEBOOK_REPLY_BOX_SELECTOR = [
  'div[role="textbox"][contenteditable="true"][aria-label*="respuesta" i]',
  'div[role="textbox"][contenteditable="true"][aria-label*="reply" i]',
  'div[role="textbox"][contenteditable="true"][aria-placeholder*="respuesta" i]',
  'div[role="textbox"][contenteditable="true"][aria-placeholder*="reply" i]',
  'div[role="textbox"][contenteditable="true"][aria-label*="responde" i]',
].join(", ");

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

/**
 * Un freno de la red: la pantalla que aparece cuando la cuenta ya no puede
 * seguir trabajando hasta que alguien entre a mano.
 *
 * `text` se busca en el cuerpo de la página (normalizado, sin acentos) y
 * tambien en la URL —Facebook manda el motivo en la ruta, como /checkpoint/—.
 * `url` es solo para la URL, para rutas que no querriamos ir a buscar dentro
 * del texto de la página.
 */
type PlatformBlocker = {
  label: string;
  text: string[];
  url?: string[];
};

const FACEBOOK_BLOCKERS: PlatformBlocker[] = [
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
    // Diálogo "Abre Facebook en tu dispositivo móvil para confirmar tu
    // identidad · Se restringieron algunas acciones debido a actividad
    // inusual". Sale al intentar una acción (p. ej. unirse a un grupo). La
    // cuenta NO está bloqueada: se libera confirmando desde la app de Facebook
    // del celular de la cuenta, y reintentar desde aquí solo suma intentos.
    // Por eso tiene su propio mensaje (FACEBOOK_CONFIRMAR_IDENTIDAD) y no el de
    // "detuvo este perfil", que en campañas ofrece eliminar el perfil. Frases
    // completas y no "actividad inusual" a secas, porque el texto se busca en
    // toda la página y un post del feed podría decirlo.
    label: "confirmar identidad en el celular",
    text: [
      "se restringieron algunas acciones",
      "en tu dispositivo movil para confirmar tu identidad",
      "restricted some actions",
      "on your mobile device to confirm your identity",
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

/**
 * Los frenos de Instagram.
 *
 * La cuenta suspendida se reconoce sobre todo por la ruta: Instagram manda a
 * /accounts/suspended/ y ahi muestra "Confirma que eres una persona real para
 * usar tu cuenta, <usuario>" con un boton de Continuar. Sin esto la tarea
 * fallaba con el timeout de la caja de comentario —un sintoma que manda a
 * revisar selectores— en vez de decir que la cuenta ya no sirve.
 *
 * La sesion caida queda afuera a proposito: se resuelve volviendo a loguear el
 * perfil, no eliminandolo, y ya tiene su mensaje propio en
 * prepareInstagramCommentBox.
 */
const INSTAGRAM_BLOCKERS: PlatformBlocker[] = [
  {
    label: "cuenta suspendida",
    url: ["/accounts/suspended", "/accounts/disabled"],
    text: [
      "suspendimos tu cuenta",
      "tu cuenta fue suspendida",
      "we suspended your account",
      "your account has been suspended",
      "cuenta inhabilitada",
      "your account has been disabled",
    ],
  },
  {
    label: "checkpoint de persona real",
    text: [
      "confirma que eres una persona real",
      "confirm that you are a real person",
      "confirm that you're a real person",
      "confirma tu identidad",
      "confirm your identity",
    ],
  },
  {
    label: "revision de seguridad",
    url: ["/challenge"],
    text: [
      "actividad sospechosa",
      "suspicious activity",
      "detectamos actividad inusual",
      "unusual activity",
      "ayudanos a confirmar que eres tu",
      "help us confirm it's you",
    ],
  },
];

const PLATAFORMAS_CON_FRENOS = [
  { host: "facebook.com", nombre: "Facebook", blockers: FACEBOOK_BLOCKERS },
  { host: "instagram.com", nombre: "Instagram", blockers: INSTAGRAM_BLOCKERS },
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
  /** Lo llama "joinGroup" con en qué quedó el perfil frente al grupo. */
  onJoinState?: (state: JoinGroupResult) => void;
  /** Y con el nombre del grupo, que se lee antes de intentar unirse. */
  onGroupName?: (name: string) => void;
  /** La publicación a la que la tarea navegó al arrancar. Ver ensureOnTargetUrl. */
  targetUrl?: string;
  /** Quién es el perfil: con esto "joinGroup" contesta las preguntas del grupo en su voz. */
  persona?: Persona;
  /** El envío del comentario escrito, escuchado en la red. Ver vigilarEnvioComentario. */
  envioComentario?: EnvioComentario;
};

function normalizePageText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * El mensaje cuando Facebook pide confirmar la identidad desde el celular.
 * Detiene la tarea igual que un freno, pero a propósito NO dice "detuvo este
 * perfil": la cuenta se recupera sola en cuanto alguien confirma en la app, y
 * con ese texto la pantalla de campañas ofrecería eliminarla.
 */
const FACEBOOK_CONFIRMAR_IDENTIDAD =
  "Facebook pide confirmar la identidad desde el celular de la cuenta: restringió algunas acciones por actividad inusual. No está bloqueado; confírmalo en la app de Facebook de ese celular y relanza la tarea.";

/**
 * El freno que la red esta mostrando en esta pagina, si es uno de los conocidos.
 *
 * El texto del mensaje lo lee la pantalla de campañas para ofrecer el boton de
 * eliminar el perfil (ver `redQueFreno`), asi que la forma
 * "<Red> detuvo este perfil" es parte del contrato: cambiarla apaga ese boton.
 */
async function knownPlatformBlocker(page: Page): Promise<string | null> {
  const url = page.url();
  const normalizedUrl = url.toLowerCase();
  const plataforma = PLATAFORMAS_CON_FRENOS.find((p) => normalizedUrl.includes(p.host));
  if (!plataforma) return null;

  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 1000 })
    .then(normalizePageText)
    .catch(() => "");

  for (const blocker of plataforma.blockers) {
    const porTexto = blocker.text.some((pattern) => bodyText.includes(pattern) || normalizedUrl.includes(pattern));
    const porUrl = (blocker.url ?? []).some((pattern) => normalizedUrl.includes(pattern));
    if (porTexto || porUrl) {
      // La pantalla de login no es un bloqueo de la cuenta: el perfil solo
      // perdió la sesión. "detuvo este perfil" además hace que la pantalla de
      // campañas ofrezca eliminarlo.
      if (blocker.label === "sesion requerida") return USUARIO_NO_LOGEADO;
      if (blocker.label === "confirmar identidad en el celular") return FACEBOOK_CONFIRMAR_IDENTIDAD;
      return `${plataforma.nombre} detuvo este perfil por ${blocker.label}. Requiere accion manual en la cuenta antes de volver a usarla.`;
    }
  }

  return null;
}

/** Si el error que subio es el freno de la red y no un fallo del paso. */
function esFrenoDeLaRed(message: string) {
  return /^(Facebook|Instagram) detuvo este perfil/.test(message) || message.startsWith(FACEBOOK_CONFIRMAR_IDENTIDAD);
}

async function assertNoKnownBlocker(page: Page) {
  const blocker = await knownPlatformBlocker(page);
  if (blocker) throw new Error(blocker);
}

function isFacebookCommentBoxSelector(selector: string) {
  return /Write a comment|Escribe un comentario/i.test(selector);
}

/**
 * Si el selector guardado en la tarea apunta a la caja de comentario de
 * Instagram.
 *
 * Se reconoce por forma y no por el texto exacto porque hay campañas viejas en
 * la base con el rótulo literal ("Add a comment…") que fue lo que rompió: así
 * esas tareas también se benefician del selector ancho sin recrearlas.
 */
function isInstagramCommentBoxSelector(selector: string) {
  return /textarea/i.test(selector) && /comment|comentario/i.test(selector);
}

function isFacebookLikeSelector(selector: string) {
  return FACEBOOK_LIKE_LABELS.some((label) => selector.includes(`aria-label="${label}"`));
}

function selectorForStep(selector: string, ctx: StepContext) {
  if (ctx.taskType === "comment" && isFacebookCommentBoxSelector(selector)) {
    return `${selector}, ${FACEBOOK_COMMENT_BOX_SELECTOR}`;
  }
  if (esTareaDeComentario(ctx.taskType) && isInstagramCommentBoxSelector(selector)) {
    return `${selector}, ${INSTAGRAM_COMMENT_BOX_SELECTOR}`;
  }
  if (ctx.taskType === "like" && isFacebookLikeSelector(selector)) {
    return `${selector}, ${FACEBOOK_LIKE_SELECTOR}, [${FACEBOOK_POST_LIKE_MARK}]`;
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
/**
 * Frena el autoavance del visor de Reels.
 *
 * El visor pasa al siguiente video cuando el actual termina, y un reel dura
 * segundos: entre abrir la página, cerrar capas, abrir comentarios y escribir,
 * la tarea se quedaba comentando en otra publicación. Volver desde ahí ya
 * costaba perder el texto escrito.
 *
 * Se toca el elemento <video> directo en vez de buscar un botón de pausa: no
 * depende de rótulos ni de idioma, y `loop` evita el evento "ended", que es el
 * que dispara el salto. Es idempotente y hay que repetirlo, porque Facebook
 * monta elementos nuevos a medida que uno navega el visor.
 */
async function freezeReelPlayback(page: Page) {
  await page
    .evaluate(() => {
      for (const video of Array.from(document.querySelectorAll("video"))) {
        video.loop = true;
        video.pause();
      }
    })
    .catch(() => {});
}

function rutaDePublicacion(valor: string) {
  try {
    return new URL(valor).pathname.replace(/\/+$/, "");
  } catch {
    return valor;
  }
}

/**
 * Corta la tarea si el navegador ya no está en la publicación pedida.
 *
 * Se usa donde volver ya no sirve porque el daño sería irreversible: una vez
 * escrito el comentario, renavegar lo pierde, y enviarlo lo publica en la
 * publicación equivocada. Fallar es el único desenlace honesto.
 */
async function assertOnTargetUrl(page: Page, ctx: StepContext) {
  const objetivo = ctx.targetUrl;
  if (!objetivo) return;

  const actual = page.url();
  if (rutaDePublicacion(actual) === rutaDePublicacion(objetivo)) return;

  throw new Error(
    `El navegador quedó en otra publicación (${actual}) en vez de la de la tarea (${objetivo}) con el ` +
      `comentario ya escrito. Se aborta para no publicarlo donde no corresponde. Suele pasar en reels, que ` +
      `se pasan solos al siguiente video.`,
  );
}

/** Lo mismo que assertOnTargetUrl, con el mensaje del like. */
async function assertLikeOnTargetUrl(page: Page, ctx: StepContext) {
  const objetivo = ctx.targetUrl;
  if (!objetivo || rutaDePublicacion(page.url()) === rutaDePublicacion(objetivo)) return;
  throw new Error(
    `El navegador quedó en otra publicación (${page.url()}) en vez de la de la tarea (${objetivo}). ` +
      "No se dio el like para no reaccionar donde no corresponde. Suele pasar en reels, que se pasan solos al siguiente video.",
  );
}

/** Devuelve si tuvo que volver a cargar la publicación. */
async function ensureOnTargetUrl(page: Page, ctx: StepContext) {
  const objetivo = ctx.targetUrl;
  if (!objetivo) return false;

  const actual = page.url();
  if (rutaDePublicacion(actual) === rutaDePublicacion(objetivo)) return false;

  await log(ctx.taskId, "warn", `El visor se movió a otra publicación (${actual}); se vuelve a la de la tarea.`);
  await gotoPage(page, objetivo, DEFAULT_GOTO_TIMEOUT_MS, ctx);
  await page.waitForTimeout(2500);
  await freezeReelPlayback(page);
  return true;
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

/**
 * Escribe en una caja de comentario y comprueba que quedó completo.
 *
 * `type()` manda tecla por tecla, y el editor de Facebook se re-renderiza
 * mientras tanto —al expandirse la caja, al aparecer el autocompletado de
 * menciones o el de emojis— y se come caracteres del medio. Se vio publicado
 * "Excelente, aestaremos!" donde debía decir "Excelente, ahi estaremos!".
 *
 * `insertText` mete el texto entero de una sola vez, así que no hay ventana
 * para perder nada. Y aun así se relee la caja antes de enviar: publicar un
 * comentario mutilado no se puede deshacer, y el intento anterior terminaba
 * además culpando a Facebook de haberlo descartado.
 */
/**
 * Lo que la caja tiene escrito ahora mismo.
 *
 * Facebook comenta sobre un div contenteditable e Instagram sobre un
 * <textarea>, y en un textarea `innerText` devuelve el contenido inicial del
 * HTML —vacío—, no lo que se acaba de tipear. Leyendo siempre con innerText, la
 * verificación de Instagram fallaba con la caja llena.
 */
async function leerCaja(caja: Locator) {
  return caja
    .evaluate((el) =>
      el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement
        ? el.value
        : (el as HTMLElement).innerText,
    )
    .catch(() => "");
}

async function escribirEnCaja(page: Page, caja: Locator, texto: string, ctx: StepContext) {
  const normalizar = (valor: string) =>
    valor
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const esperado = normalizar(texto);

  for (let intento = 1; intento <= 2; intento += 1) {
    await caja.click({ timeout: 5000 }).catch(() => {});
    await caja.focus({ timeout: 5000 }).catch(() => {});
    await page.keyboard.insertText(texto);
    await page.waitForTimeout(600);

    const escrito = normalizar(await leerCaja(caja));
    if (escrito.includes(esperado)) return;

    if (intento === 2) {
      throw new Error(
        `La caja quedó con "${escrito}" en vez de "${esperado}". No se envía para no publicar un comentario ` +
          `incompleto; suele pasar cuando el editor de la red se re-renderiza mientras se escribe.`,
      );
    }

    await log(ctx.taskId, "warn", `El texto quedó incompleto en la caja ("${escrito}"); se limpia y se reintenta.`);
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
    await page.waitForTimeout(400);
  }
}

/**
 * Si la tarea publica un comentario en una publicación.
 *
 * El padre de una ramificación hace exactamente eso —lo único distinto es que
 * después se le cuelgan hijos—, así que necesita el mismo trato que una tarea
 * de comentario: abrir el panel, escribir con la caja tapada, y las guardias
 * que evitan publicar en la publicación equivocada.
 */
function esTareaDeComentario(taskType: string) {
  return taskType === "comment" || taskType === "ramificacion";
}

/**
 * Deja a Instagram en condiciones de recibir el comentario.
 *
 * El equivalente de lo que ya se hacía con Facebook, con las diferencias de la
 * casa: en una publicación abierta el composer ya está montado, pero en reels y
 * videos el panel arranca cerrado, y encima Instagram monta capas propias
 * ("Activa las notificaciones", el aviso de cookies, el modal de inicio de
 * sesión) que lo tapan.
 *
 * La sesión caída se corta acá con un mensaje propio: sin esto el síntoma era
 * el timeout de la caja de texto —"0 match(es)"—, que manda a buscar un
 * selector roto cuando el problema es que la cuenta no está logueada.
 */
const INSTAGRAM_COMMENT_BOX_MARK = "data-lotificadora-ig-comment-box";
const INSTAGRAM_COMMENT_BOX_MARKED = `[${INSTAGRAM_COMMENT_BOX_MARK}]`;

/**
 * Busca el composer de Instagram por forma y no por atributos, y lo marca.
 *
 * El panel de comentarios del visor de reels muestra "Agrega un comentario…"
 * pero el selector por atributos daba "0 match(es)": ese composer no trae el
 * rótulo en `placeholder`/`aria-label` del propio editable (lo pinta en un
 * elemento hermano, al estilo Lexical), o directamente no es editable hasta
 * que se lo clickea. Se reconoce entonces cualquier editable visible cuyo
 * rótulo propio o el texto de su contenedor inmediato hable de comentar; y si
 * no hay editable, se clickea el texto "Agrega un comentario…" para que monte.
 *
 * Devuelve si quedó una caja marcada.
 */
async function markInstagramCommentBox(page: Page) {
  await defineEsbuildNameHelper(page);
  const marcar = () =>
    page
      .evaluate((mark) => {
        const habla = (t: string | null | undefined) => /coment|comment/i.test(t ?? "");
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== "hidden";
        };
        // Una vez escrito el texto el placeholder desaparece y la caja ya no
        // se reconoce por rótulo: la marcada antes sigue siendo la buena.
        const previas = Array.from(document.querySelectorAll(`[${mark}]`));
        if (previas.some(visible)) return true;
        for (const el of previas) el.removeAttribute(mark);

        const editables = Array.from(
          document.querySelectorAll(
            'textarea, input[type="text"], input:not([type]), [contenteditable="true"], [contenteditable=""], [role="textbox"]',
          ),
        ).filter(visible);

        const rotulado = (el: Element) => {
          if (
            ["aria-label", "placeholder", "aria-placeholder", "data-placeholder", "title"].some((a) =>
              habla(el.getAttribute(a)),
            )
          )
            return true;
          // El placeholder pintado aparte vive en un ancestro cercano.
          let p: Element | null = el.parentElement;
          for (let i = 0; p && i < 4; i += 1, p = p.parentElement) {
            const texto = (p as HTMLElement).innerText ?? "";
            if (texto.length < 120 && habla(texto)) return true;
          }
          return false;
        };

        // Preferir la del panel de comentarios, si hay dialog abierto.
        const ordenados = editables.sort(
          (a, b) => Number(!!b.closest('[role="dialog"]')) - Number(!!a.closest('[role="dialog"]')),
        );
        const caja = ordenados.find(rotulado) ?? (ordenados.length === 1 ? ordenados[0] : null);
        if (!caja) return false;
        caja.setAttribute(mark, "1");
        return true;
      }, INSTAGRAM_COMMENT_BOX_MARK)
      .catch(() => false);

  if (await marcar()) return true;

  // Composer perezoso: un texto "Agrega un comentario…" que recién al
  // clickearlo se vuelve editable.
  const disparador = page
    .locator("span, div, p")
    .filter({ hasText: /^\s*((agrega|añade) un comentario|add a comment)/i })
    .last();
  if (await disparador.isVisible().catch(() => false)) {
    await disparador.click({ timeout: 2500 }).catch(() => {});
    await page.waitForTimeout(800);
    return marcar();
  }
  return false;
}

/** Los editables visibles de la página, para el log cuando no se encuentra la caja. */
async function describeEditables(page: Page) {
  await defineEsbuildNameHelper(page);
  const items = await page
    .evaluate(() =>
      Array.from(document.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]'))
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 1 && r.height > 1;
        })
        .slice(0, 10)
        .map((el) => {
          const attrs = ["role", "contenteditable", "aria-label", "placeholder", "aria-placeholder", "type"]
            .map((a) => (el.hasAttribute(a) ? `${a}="${el.getAttribute(a)}"` : ""))
            .filter(Boolean)
            .join(" ");
          return `<${el.tagName.toLowerCase()} ${attrs}>`;
        }),
    )
    .catch(() => [] as string[]);
  return items.length ? items.join(", ") : "(ninguno)";
}

/** Devuelve el selector de la caja marcada, o `null` para usar el del paso. */
async function prepareInstagramCommentBox(page: Page, ctx: StepContext): Promise<string | null> {
  await ensureOnTargetUrl(page, ctx);
  await freezeReelPlayback(page);

  // Antes que nada: si la cuenta esta suspendida no hay caja que buscar, y
  // los intentos de abrir el panel se comen el error de a uno con `.catch`.
  await assertNoKnownBlocker(page);

  // `undefined` = todavía no hay caja; `null` = la encuentra el selector del
  // paso; string = la caja que se marcó a mano.
  const lista = async (): Promise<string | null | undefined> => {
    if (await hasVisibleLocator(page, INSTAGRAM_COMMENT_BOX_SELECTOR)) return null;
    return (await markInstagramCommentBox(page)) ? INSTAGRAM_COMMENT_BOX_MARKED : undefined;
  };

  let encontrada = await lista();
  if (encontrada !== undefined) return encontrada;

  if (page.url().includes("/accounts/login") || (await hasVisibleLocator(page, 'input[name="password"]'))) {
    throw new Error(
      "Instagram pidió iniciar sesión con este perfil, así que no hay caja de comentario. Hay que dejar la " +
        "sesión abierta en el perfil de AdsPower antes de volver a correr la tarea.",
    );
  }

  for (let intento = 1; intento <= ABRIR_COMENTARIOS_INTENTOS; intento += 1) {
    await ensureOnTargetUrl(page, ctx);
    await dismissInstagramOverlays(page, ctx);
    encontrada = await lista();
    if (encontrada !== undefined) return encontrada;

    const target = await firstClickableLocator(page, INSTAGRAM_COMMENT_OPEN_SELECTOR, 2500).catch(() => null);
    if (target) {
      await log(ctx.taskId, "info", "Abriendo el panel de comentarios de Instagram.");
      await target.locator.click({ position: target.position, timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(1500);
      encontrada = await lista();
      if (encontrada !== undefined) return encontrada;
    }

    if (intento < ABRIR_COMENTARIOS_INTENTOS) {
      await log(
        ctx.taskId,
        "info",
        `No apareció la caja de comentario; reintento ${intento + 1} de ${ABRIR_COMENTARIOS_INTENTOS}.`,
      );
      await page.waitForTimeout(1500);
    }
  }

  await log(
    ctx.taskId,
    "warn",
    `No se encontró la caja de comentario de Instagram. Editables visibles: ${await describeEditables(page)}. ` +
      `Botones visibles en la página: ${await describeVisibleButtons(page)}`,
  );
  return null;
}

/** Cierra las capas de Instagram que tapan el composer. Devuelve si cerró alguna. */
async function dismissInstagramOverlays(page: Page, ctx: StepContext) {
  const locator = page.locator(INSTAGRAM_DISMISS_SELECTOR);
  const count = await locator.count().catch(() => 0);

  for (let i = 0; i < count; i += 1) {
    const candidate = locator.nth(i);
    if (!(await candidate.isVisible().catch(() => false))) continue;

    await candidate.click({ timeout: 2000 }).catch(() => {});
    await log(ctx.taskId, "info", "Se cerró una capa de Instagram que tapaba la publicación.");
    await page.waitForTimeout(800);
    return true;
  }
  return false;
}

/**
 * Frases con las que Facebook responde cuando la publicación ya no se puede
 * ver: borrada, con la privacidad cambiada, o de una cuenta que bloqueó al
 * perfil. La página carga bien y sin bloqueo de seguridad, pero no trae ningún
 * botón de reaccionar — y el fallo salía como un timeout de selector, que hace
 * pensar en un selector roto cuando lo que no hay es publicación.
 */
const FACEBOOK_UNAVAILABLE_TEXT = [
  "este contenido no esta disponible",
  "contenido no disponible",
  "this content isn't available",
  "this content isnt available",
  "esta pagina no esta disponible",
  "this page isn't available",
  "this page isnt available",
];

async function facebookContentUnavailable(page: Page) {
  const texto = await page
    .locator("body")
    .innerText({ timeout: 1000 })
    .then(normalizePageText)
    .catch(() => "");
  return FACEBOOK_UNAVAILABLE_TEXT.some((frase) => texto.includes(frase));
}

/**
 * Por qué no apareció el botón de reaccionar.
 *
 * El timeout pelado dice "0 match(es)" y ahí se corta: no distingue entre la
 * publicación que ya no existe, el perfil con la interfaz en un idioma sin
 * mapear y el botón que Facebook movió de lugar. Las tres se arreglan distinto,
 * y averiguar cuál era costaba bajarse la captura del VPS. Ahora el propio
 * error lo dice, y en el caso del idioma trae los rótulos reales de la página
 * para agregar el que falte a FACEBOOK_LIKE_LABELS.
 */
async function explicarFalloDeLike(page: Page, message: string) {
  if (await facebookContentUnavailable(page)) {
    return new Error(
      "La publicación no está disponible para este perfil (borrada, con la privacidad cambiada, o la cuenta " +
        `bloqueó al perfil). No hay botón de reaccionar que buscar. Detalle: ${message}`,
    );
  }

  return new Error(
    `${message}. Botones visibles en la página: ${await describeVisibleButtons(page)}. Si alguno es el de ` +
      "reaccionar con otro nombre, hay que agregar ese rótulo a FACEBOOK_LIKE_ARIA_PATTERNS en runner.ts.",
  );
}

function yaReaccionadaSelector() {
  return `${FACEBOOK_ALREADY_LIKED_SELECTOR}, [${FACEBOOK_POST_LIKED_MARK}]`;
}

type PostLikeProbe = {
  status: "ready" | "already_liked" | "not_found";
  detail: string;
};

/**
 * Busca en la página el botón de reaccionar de la publicación y lo deja marcado.
 *
 * Corre dentro del navegador porque necesita subir por el árbol (`parentElement`)
 * para comprobar la fila de acciones, y Playwright no sabe hacer eso desde un
 * selector. Reconoce el botón por su nombre accesible —`aria-label` si lo tiene,
 * el texto renderizado si no— y solo acepta el que comparte fila con "Comentar"
 * o "Compartir".
 *
 * El texto se usa únicamente como respaldo, y con una salvaguarda: cuando la
 * reacción ya está puesta el rótulo sigue diciendo "Me gusta" (en azul), así que
 * clickearlo la quitaría en vez de ponerla. `aria-pressed="true"` es lo que
 * separa un caso del otro sobre un botón que ya sabemos cuál es —como pista
 * para encontrarlo no sirve, porque medio Facebook lo lleva.
 */
async function markFacebookPostLike(page: Page, soloEnPantalla = false): Promise<PostLikeProbe> {
  await defineEsbuildNameHelper(page);
  return page.evaluate(
    ({ likeMark, likedMark, likePatterns, unlikePatterns, rowLabels, replyLabels, soloEnPantalla }): PostLikeProbe => {
      // Sin acentos y en minúsculas: "Gefällt mir" y "gefallt mir" son el mismo
      // botón, y el rótulo no siempre respeta el capitalizado entre layouts.
      const normalizar = (valor: string) =>
        valor
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

      const coincide = (valor: string, patrones: string[]) => {
        const limpio = normalizar(valor);
        return Boolean(limpio) && patrones.some((patron) => new RegExp(patron).test(limpio));
      };

      const contiene = (valor: string, palabras: string[]) => {
        const limpio = normalizar(valor);
        return Boolean(limpio) && palabras.some((palabra) => limpio.includes(normalizar(palabra)));
      };

      for (const marked of Array.from(document.querySelectorAll(`[${likeMark}], [${likedMark}]`))) {
        marked.removeAttribute(likeMark);
        marked.removeAttribute(likedMark);
      }

      const ariaOf = (el: Element) => (el.getAttribute("aria-label") ?? "").trim();
      const textOf = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const nombreDe = (el: Element) => ariaOf(el) || textOf(el);

      // "Responder" o "Responder a Juan", nunca como subcadena suelta: un post
      // puede llevar la palabra en el texto de un botón cualquiera.
      const esRespuesta = (valor: string) => {
        const limpio = normalizar(valor);
        return replyLabels.some((r) => {
          const rotulo = normalizar(r);
          return limpio === rotulo || limpio.startsWith(`${rotulo} `);
        });
      };

      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      // En el visor de reels están montados también el reel anterior y los
      // siguientes, cada uno con su columna de "Me gusta". Tienen tamaño pero
      // están fuera de pantalla; aceptarlos era marcar el like de otro reel, y
      // el scrollIntoView de abajo llevaba el visor hasta ese reel.
      const enPantalla = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
      };
      const botonesDe = (root: ParentNode) =>
        (Array.from(root.querySelectorAll('[role="button"], button')) as HTMLElement[]).filter(
          (el) => visible(el) && (!soloEnPantalla || enPantalla(el)),
        );

      // El post abierto en dialog manda: en esa vista la página de atrás sigue
      // montada con su propio feed, y sus botones son los de otras publicaciones.
      // Pero Facebook tiene varios `role="dialog"` montados —vacíos, ocultos, el
      // de una notificación— y quedarse con el primero del DOM era buscar en uno
      // que no tenía el post: "0 match(es)" con el botón a la vista. Vale el
      // dialog visible que tenga barra de acciones, el de más arriba primero.
      // Si ninguno la tiene, el post no está en un dialog y se busca en la página.
      const dialogs = (Array.from(document.querySelectorAll('div[role="dialog"]')) as HTMLElement[])
        .filter(visible)
        .filter((d) => botonesDe(d).some((b) => contiene(nombreDe(b), rowLabels)))
        .reverse();
      const root: ParentNode = dialogs[0] ?? document;
      const botones = botonesDe(root);

      // La compañía es lo que distingue al botón del post del de un comentario:
      // el del post comparte fila con "Comentar…" y "Compartir…", el de un
      // comentario vive al lado de "Responder". Por subcadena porque esos
      // vecinos también traen la frase larga ("Comentar la publicación de X").
      //
      // Sube hasta 8 niveles porque en el layout de nota larga la fila queda más
      // arriba que en el de foto. Lo que impide que de tanto subir el "Me gusta"
      // de un comentario alcance la barra del post es cortar en cuanto aparece
      // un "Responder": ese ancestro ya es el de un comentario.
      const enBarraDeAcciones = (el: HTMLElement) => {
        let nodo: HTMLElement | null = el;
        for (let i = 0; i < 8; i += 1) {
          nodo = nodo?.parentElement ?? null;
          if (!nodo || nodo === root) return false;
          const vecinos = Array.from(nodo.querySelectorAll('[role="button"], button')) as HTMLElement[];
          if (vecinos.some((v) => v !== el && esRespuesta(nombreDe(v)))) return false;
          if (vecinos.some((v) => v !== el && contiene(nombreDe(v), rowLabels))) return true;
        }
        return false;
      };

      const yaPuesto = botones.filter((el) => coincide(nombreDe(el), unlikePatterns)).find(enBarraDeAcciones) ?? null;
      if (yaPuesto) {
        yaPuesto.setAttribute(likedMark, "1");
        yaPuesto.scrollIntoView({ block: "center" });
        return { status: "already_liked", detail: nombreDe(yaPuesto).slice(0, 60) };
      }

      // El rótulo exacto ("Me gusta", "Like") antes que "Reaccionar…": en los
      // reels "Reaccionar" es la flechita de al lado del pulgar, que abre el
      // selector de emojis en vez de reaccionar. Con Enter quedaba el selector
      // abierto y la reacción sin poner. "Reaccionar a la publicación de X"
      // sigue valiendo en los builds donde es el único botón.
      const exactos = likePatterns.filter((p) => p.endsWith("$"));
      const candidatos = botones.filter((el) => coincide(nombreDe(el), likePatterns)).filter(enBarraDeAcciones);
      const boton = candidatos.find((el) => coincide(nombreDe(el), exactos)) ?? candidatos[0] ?? null;
      if (!boton) {
        const donde = dialogs.length ? "en el dialog del post" : "en la página (sin dialog con barra de acciones)";
        return { status: "not_found", detail: `${botones.length} boton(es) mirados ${donde}` };
      }

      // Hay builds donde el rótulo no cambia al reaccionar: sigue diciendo
      // "Me gusta", solo que en azul. Clickearlo ahí quitaría la reacción en vez
      // de ponerla. `aria-pressed` no sirve para encontrar el botón —medio
      // Facebook lo lleva— pero sobre uno que ya sabemos cuál es dice exactamente
      // eso: si está presionado o no.
      if (boton.closest('[aria-pressed="true"]')) {
        boton.setAttribute(likedMark, "1");
        boton.scrollIntoView({ block: "center" });
        return { status: "already_liked", detail: `${nombreDe(boton).slice(0, 60)} (aria-pressed)` };
      }

      boton.setAttribute(likeMark, "1");
      boton.scrollIntoView({ block: "center" });
      return { status: "ready", detail: `"${nombreDe(boton).slice(0, 60)}"` };
    },
    {
      likeMark: FACEBOOK_POST_LIKE_MARK,
      likedMark: FACEBOOK_POST_LIKED_MARK,
      likePatterns: FACEBOOK_LIKE_ARIA_PATTERNS,
      unlikePatterns: FACEBOOK_UNLIKE_ARIA_PATTERNS,
      rowLabels: FACEBOOK_ACTION_ROW_LABELS,
      replyLabels: FACEBOOK_REPLY_LABELS,
      soloEnPantalla,
    },
  );
}

/**
 * Si la URL es de un visor de video vertical (reels, watch, videos).
 *
 * Ahí hacer scroll no baja dentro de la publicación: pasa al video siguiente.
 * Y el DOM tiene montados varios videos a la vez, cada uno con su "Me gusta".
 */
function esVisorDeReels(url: string | undefined) {
  if (!url) return false;
  return /facebook\.com\/(reels?\/|watch|share\/[rv]\/|[^/?#]+\/videos\/)|fb\.watch\//i.test(url);
}

/**
 * Baja un tramo dentro de la publicación.
 *
 * Con el post abierto en dialog, el scroll que importa no es el de la ventana
 * sino el del contenedor interno: la barra de acciones queda debajo de la
 * imagen, fuera de la vista y —cuando Facebook la monta tarde— fuera del DOM.
 * Mover la rueda del mouse no alcanza si el puntero no está encima del dialog.
 */
async function scrollFacebookPost(page: Page) {
  await page
    .evaluate(() => {
      // El dialog visible de más arriba, no el primero del DOM: Facebook deja
      // montados dialogs vacíos u ocultos, y con el primero se terminaba
      // bajando el feed de atrás, que es el de otras publicaciones.
      const dialog =
        (Array.from(document.querySelectorAll('div[role="dialog"]')) as HTMLElement[])
          .filter((d) => {
            const r = d.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .pop() ?? null;
      const contenedores = (Array.from((dialog ?? document.body).querySelectorAll("*")) as HTMLElement[]).filter(
        (el) => {
          const estilo = getComputedStyle(el);
          return /(auto|scroll)/.test(estilo.overflowY) && el.scrollHeight > el.clientHeight + 40;
        },
      );

      if (!contenedores.length) {
        window.scrollBy(0, Math.round(window.innerHeight * 0.6));
        return;
      }

      const objetivo = contenedores.sort((a, b) => b.clientHeight - a.clientHeight)[0];
      objetivo.scrollTop = Math.min(objetivo.scrollTop + objetivo.clientHeight * 0.8, objetivo.scrollHeight);
    })
    .catch(() => {});
}

const BUSCAR_LIKE_INTENTOS = 6;

/**
 * Deja la publicación en condiciones de que se pueda reaccionar.
 *
 * Es el equivalente, para el like, de lo que prepareSelectorTarget ya hacía
 * para la caja de comentario: el visor de reels se pasa solo al siguiente video
 * y el cuadro de sugerencias tapa la columna de acciones. Sin esto, el paso
 * esperaba quince segundos un botón que estaba en otra publicación o debajo de
 * una capa.
 */
async function prepareFacebookLike(page: Page, ctx: StepContext): Promise<PostLikeProbe> {
  await ensureOnTargetUrl(page, ctx);
  await freezeReelPlayback(page);
  await dismissFacebookOverlays(page, ctx);

  // Siempre por el sondeo de fila de acciones, nunca por `aria-label` suelto.
  // Antes se salía apenas había algún `[aria-label="Like"]` visible, y eso lo
  // cumple también el "Me gusta" de cualquier comentario: la tarea terminaba
  // reaccionando al primer comentario en vez de a la publicación. Lo mismo con
  // "ya reaccionada": un comentario con like hacía creer que el post lo tenía.
  //
  // El sondeo además baja dentro del post: la barra suele estar debajo de la
  // imagen, y en el dialog eso es scroll interno.
  //
  // En reels no se hace scroll: ahí el scroll no baja dentro del post, pasa al
  // reel siguiente, y el like terminaba en otro video. Se espera a que cargue
  // la columna de acciones y se mira solo lo que está en pantalla.
  const reel = esVisorDeReels(ctx.targetUrl) || esVisorDeReels(page.url());
  let ultimo: PostLikeProbe = { status: "not_found", detail: "" };
  for (let intento = 1; intento <= BUSCAR_LIKE_INTENTOS; intento += 1) {
    // Si algo movió el visor (autoavance, un scroll) se vuelve a la
    // publicación antes de mirar: marcar el botón de otra es reaccionarle.
    if (await ensureOnTargetUrl(page, ctx)) await dismissFacebookOverlays(page, ctx);
    await freezeReelPlayback(page);

    const probe = await markFacebookPostLike(page, reel);
    ultimo = probe;

    if (probe.status === "ready") {
      await log(ctx.taskId, "info", `Botón de reaccionar localizado por ${probe.detail}.`);
      return probe;
    }
    if (probe.status === "already_liked") {
      await log(ctx.taskId, "info", `La publicación ya tenía la reacción puesta (${probe.detail}).`);
      return probe;
    }

    if (intento < BUSCAR_LIKE_INTENTOS) {
      if (!reel) await scrollFacebookPost(page);
      await page.waitForTimeout(reel ? 1200 : 900);
    }
  }

  // El último scroll pudo haber cambiado de publicación sin que se mirara.
  await ensureOnTargetUrl(page, ctx);
  await log(ctx.taskId, "warn", `No se encontró el botón de reaccionar en la barra de acciones (${ultimo.detail}).`);
  return ultimo;
}

const FACEBOOK_PICKER_LIKE_MARK = "data-godeye-picker-like";

/** "Me encanta" en los idiomas mapeados: solo existe dentro del selector de reacciones. */
const FACEBOOK_LOVE_LABELS = ["me encanta", "love", "j'adore", "amei", "adoro", "mi piace molto", "gefallt mir sehr", "bayildim"];

/**
 * Si está abierto el selector de reacciones (👍 ❤️ 😆 …), marca su "Me gusta".
 *
 * Se reconoce por "Me encanta", que fuera del selector no aparece, y el
 * "Me gusta" que se marca es el que comparte contenedor con ese.
 */
async function marcarLikeEnSelectorDeReacciones(page: Page): Promise<boolean> {
  await defineEsbuildNameHelper(page);
  return page
    .evaluate(
      ({ mark, loveLabels, likePatterns }) => {
        const normalizar = (v: string) =>
          v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
        for (const m of Array.from(document.querySelectorAll(`[${mark}]`))) m.removeAttribute(mark);
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const etiquetados = (Array.from(document.querySelectorAll("[aria-label]")) as HTMLElement[]).filter(visible);
        const loves = etiquetados.filter((el) => loveLabels.includes(normalizar(el.getAttribute("aria-label") ?? "")));
        for (const love of loves) {
          let nodo: HTMLElement | null = love;
          for (let i = 0; i < 4 && nodo; i += 1) {
            nodo = nodo.parentElement;
            if (!nodo) break;
            const like = (Array.from(nodo.querySelectorAll("[aria-label]")) as HTMLElement[]).find(
              (el) =>
                el !== love &&
                visible(el) &&
                likePatterns.some((p) => new RegExp(p).test(normalizar(el.getAttribute("aria-label") ?? ""))),
            );
            if (like) {
              like.setAttribute(mark, "1");
              return true;
            }
          }
        }
        return false;
      },
      {
        mark: FACEBOOK_PICKER_LIKE_MARK,
        loveLabels: FACEBOOK_LOVE_LABELS,
        likePatterns: FACEBOOK_LIKE_ARIA_PATTERNS.filter((p) => p.endsWith("$")),
      },
    )
    .catch(() => false);
}

const POST_LIKE_SELECTOR = `[${FACEBOOK_POST_LIKE_MARK}]`;
const POST_LIKED_SELECTOR = `[${FACEBOOK_POST_LIKED_MARK}]`;

/**
 * Huella visual del botón de reaccionar marcado: rótulo, `aria-pressed` y los
 * colores del botón y de lo que tiene adentro. Al reaccionar Facebook pinta el
 * pulgar de azul aunque no cambie el rótulo, así que comparar la huella antes
 * y después del click es lo que dice si la reacción quedó puesta.
 */
async function huellaDelLikeDelPost(page: Page): Promise<string | null> {
  return page
    .evaluate((mark) => {
      const el = document.querySelector(`[${mark}]`);
      if (!el) return null;
      const boton = (el.closest('[role="button"], button') as Element | null) ?? el;
      const partes = [boton.getAttribute("aria-label") ?? "", boton.getAttribute("aria-pressed") ?? ""];
      const nodos = [boton, ...Array.from(boton.querySelectorAll("*")).slice(0, 40)];
      for (const nodo of nodos) {
        const estilo = getComputedStyle(nodo);
        partes.push(estilo.color, estilo.fill, estilo.backgroundColor);
      }
      return partes.join("|");
    }, FACEBOOK_POST_LIKE_MARK)
    .catch(() => null);
}

/**
 * Le da like a la publicación de Facebook —solo a ella— y confirma que quedó.
 *
 * Se clickea únicamente el botón que marcó el sondeo de fila de acciones. Si
 * está tapado se activa ESE mismo con teclado; nunca otro "Like" de la página,
 * que era como terminaba reaccionando a un comentario. Y la tarea solo sale
 * por éxito si Facebook muestra la reacción puesta después del click.
 */
async function likeFacebookPost(page: Page, ctx: StepContext, timeoutMs: number) {
  const reel = esVisorDeReels(ctx.targetUrl) || esVisorDeReels(page.url());
  let probe = await prepareFacebookLike(page, ctx);

  // Entre el sondeo y el click el visor de reels puede haberse pasado al
  // siguiente video: el botón marcado ya sería el de otra publicación.
  if (await ensureOnTargetUrl(page, ctx)) probe = await prepareFacebookLike(page, ctx);

  if (probe.status === "already_liked") return;
  if (probe.status !== "ready") {
    throw await explicarFalloDeLike(
      page,
      `No se encontró el botón de reaccionar de la publicación (${probe.detail}). No se clickeó ningún otro "Me gusta" para no reaccionar a un comentario`,
    );
  }

  await freezeReelPlayback(page);
  await assertLikeOnTargetUrl(page, ctx);
  const antes = await huellaDelLikeDelPost(page);
  const target = await firstClickableLocator(page, POST_LIKE_SELECTOR, Math.min(timeoutMs, 6000)).catch(() => null);
  if (target) {
    await target.locator.click({ position: target.position, timeout: timeoutMs });
  } else {
    await log(
      ctx.taskId,
      "warn",
      "El botón de like de la publicación está visible pero cubierto por otra capa; se lo activa con teclado.",
    );
    const fallback = await firstVisibleLocator(page, POST_LIKE_SELECTOR, 3000);
    const boton = fallback.locator('xpath=ancestor-or-self::*[@role="button" or self::button][1]');
    const foco = (await boton.count().catch(() => 0)) ? boton.first() : fallback;
    await foco.focus({ timeout: 3000 });
    await page.keyboard.press("Enter");
  }

  // Si lo que se activó fue la flechita de reacciones (o el botón abre el
  // selector al mantenerlo), queda abierto el selector de emojis y no hay
  // reacción puesta: se elige el 👍 de adentro.
  await page.waitForTimeout(800);
  if (await marcarLikeEnSelectorDeReacciones(page)) {
    await log(ctx.taskId, "info", 'Se abrió el selector de reacciones; se elige "Me gusta" adentro.');
    const enSelector = await firstClickableLocator(page, `[${FACEBOOK_PICKER_LIKE_MARK}]`, 3000).catch(() => null);
    if (enSelector) await enSelector.locator.click({ position: enSelector.position, timeout: 3000 }).catch(() => {});
  }

  // Sacar el mouse y el foco de encima: el hover y el anillo de foco también
  // cambian colores y darían por buena una reacción que no se puso.
  await page.mouse.move(1, 1).catch(() => {});
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()).catch(() => {});

  const deadline = Date.now() + 6000;
  while (Date.now() <= deadline) {
    await page.waitForTimeout(700);
    const ahora = await huellaDelLikeDelPost(page);
    if (antes && ahora && ahora !== antes) {
      await log(ctx.taskId, "info", "Reacción confirmada en la publicación.");
      return;
    }
    // Si el visor se fue a otro reel, lo que se lea ya no es esta publicación.
    if (ctx.targetUrl && rutaDePublicacion(page.url()) !== rutaDePublicacion(ctx.targetUrl)) break;
    const despues = await markFacebookPostLike(page, reel);
    if (despues.status === "already_liked") {
      await log(ctx.taskId, "info", `Reacción confirmada en la publicación (${despues.detail}).`);
      return;
    }
  }

  throw new Error(
    'Se activó el "Me gusta" de la publicación pero Facebook no mostró la reacción puesta. ' +
      "Puede que el click no haya llegado al botón o que el perfil esté limitado para reaccionar.",
  );
}

/**
 * Marca del corazón de la publicación en Instagram. Ver markInstagramPostLike.
 */
const INSTAGRAM_POST_LIKE_MARK = "data-lotificadora-ig-like";

/** Cómo se rotula el corazón vacío, por idioma. Se comparan normalizados. */
const INSTAGRAM_LIKE_LABELS = ["like", "me gusta", "j'aime", "curtir", "mi piace", "gefallt mir", "begen"];

/** Y el corazón lleno: la publicación ya tiene el like de este perfil. */
const INSTAGRAM_UNLIKE_LABELS = [
  "unlike",
  "ya no me gusta",
  "je n'aime plus",
  "descurtir",
  "non mi piace piu",
  "gefallt mir nicht mehr",
  "begenmekten vazgec",
];

/** El globito de comentar: solo existe en la barra de acciones de un post o reel. */
const INSTAGRAM_COMMENT_ICON_LABELS = ["comment", "comentar", "comentario", "commenter", "commenta", "kommentieren", "yorum yap"];

const INSTAGRAM_LIKE_VERIFY_MS = 6000;

/** Si el paso es el like de una publicación de Instagram. */
function esLikeDeInstagram(page: Page, selector: string, ctx: StepContext) {
  if (ctx.taskType !== "like") return false;
  const url = (ctx.targetUrl ?? page.url()).toLowerCase();
  if (!url.includes("instagram.com")) return false;
  return /svg\[aria-label=/.test(selector);
}

/**
 * Busca el corazón de la publicación de Instagram y lo deja marcado.
 *
 * El preset de Instagram es `svg[aria-label="Like"]`, y ese corazón no es solo
 * el del post: cada comentario lleva uno idéntico, con el mismo rótulo. En la
 * vista de una publicación la lista de comentarios va ANTES que la barra de
 * acciones en el DOM, así que el primer match era el corazón del primer
 * comentario. La tarea le daba like a un comentario, no a la publicación, y
 * salía por éxito porque el click había funcionado.
 *
 * Lo que separa al corazón del post es la compañía: comparte barra con el
 * globito de comentar, que los comentarios no tienen. Se parte de ese globito y
 * se sube hasta el primer ancestro que contenga un corazón.
 *
 * Con varios posts montados (el visor de reels) se queda con el que está en
 * pantalla.
 */
async function markInstagramPostLike(page: Page): Promise<PostLikeProbe> {
  await defineEsbuildNameHelper(page);
  return page.evaluate(
    ({ mark, likeLabels, unlikeLabels, commentLabels }): PostLikeProbe => {
      const normalizar = (valor: string) =>
        valor
          .normalize("NFD")
          .replace(/[̀-ͯ]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
      const rotulo = (el: Element) => normalizar(el.getAttribute("aria-label") ?? "");
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const enPantalla = (el: Element) => {
        const rect = el.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      };

      for (const marked of Array.from(document.querySelectorAll(`[${mark}]`))) marked.removeAttribute(mark);

      const svgs = Array.from(document.querySelectorAll("svg[aria-label]")).filter(visible);
      const globitos = svgs.filter((el) => commentLabels.includes(rotulo(el)));
      if (!globitos.length) return { status: "not_found", detail: "no hay barra de acciones en la página" };

      const ordenados = [...globitos.filter(enPantalla), ...globitos.filter((el) => !enPantalla(el))];
      for (const globito of ordenados) {
        let nodo: Element | null = globito;
        for (let i = 0; i < 6 && nodo; i += 1) {
          nodo = nodo.parentElement;
          if (!nodo) break;
          const corazon = Array.from(nodo.querySelectorAll("svg[aria-label]")).find((el) => {
            const r = rotulo(el);
            return visible(el) && (likeLabels.includes(r) || unlikeLabels.includes(r));
          });
          if (!corazon) continue;

          const boton = corazon.closest('[role="button"], button') ?? corazon;
          boton.setAttribute(mark, "1");
          (boton as HTMLElement).scrollIntoView?.({ block: "center" });
          const etiqueta = corazon.getAttribute("aria-label") ?? "";
          return unlikeLabels.includes(rotulo(corazon))
            ? { status: "already_liked", detail: etiqueta }
            : { status: "ready", detail: etiqueta };
        }
      }

      return { status: "not_found", detail: `${globitos.length} barra(s) sin corazón reconocible` };
    },
    {
      mark: INSTAGRAM_POST_LIKE_MARK,
      likeLabels: INSTAGRAM_LIKE_LABELS,
      unlikeLabels: INSTAGRAM_UNLIKE_LABELS,
      commentLabels: INSTAGRAM_COMMENT_ICON_LABELS,
    },
  );
}

/** Espera hasta que el corazón de la publicación esté en pantalla, puesto o no. */
async function waitForInstagramPostLike(page: Page, ctx: StepContext, timeoutMs: number) {
  await ensureOnTargetUrl(page, ctx);
  await freezeReelPlayback(page);

  const deadline = Date.now() + timeoutMs;
  let probe: PostLikeProbe = { status: "not_found", detail: "" };
  let cerroCapa = false;
  while (Date.now() <= deadline) {
    await assertNoKnownBlocker(page);
    probe = await markInstagramPostLike(page);
    if (probe.status !== "not_found") return probe;

    if (page.url().includes("/accounts/login") || (await hasVisibleLocator(page, 'input[name="password"]'))) {
      throw new Error(
        "Instagram pidió iniciar sesión con este perfil, así que no hay botón de like. Hay que dejar la " +
          "sesión abierta en el perfil de AdsPower antes de volver a correr la tarea.",
      );
    }
    if (!cerroCapa) cerroCapa = await dismissInstagramOverlays(page, ctx);
    await page.waitForTimeout(VISIBLE_POLL_MS);
  }

  throw new Error(
    `No se encontró el botón de like de la publicación de Instagram (${probe.detail}). Botones visibles en la ` +
      `página: ${await describeVisibleButtons(page)}`,
  );
}

/**
 * Da like a la publicación de Instagram y comprueba que quedó puesto.
 *
 * La comprobación es lo que faltaba: antes el paso terminaba en el click, y
 * cualquier click que no tirara error —sobre el corazón de un comentario, o uno
 * que Instagram ignoró por tener al perfil limitado— daba la tarea por exitosa.
 * Ahora solo es éxito si el corazón de la barra pasa a "Ya no me gusta".
 */
async function likeInstagramPost(page: Page, ctx: StepContext, timeoutMs: number) {
  const probe = await waitForInstagramPostLike(page, ctx, timeoutMs);
  if (probe.status === "already_liked") {
    await log(ctx.taskId, "info", `La publicación ya tenía el like de este perfil (${probe.detail}); nada que hacer.`);
    return;
  }

  const marcado = `[${INSTAGRAM_POST_LIKE_MARK}]`;
  try {
    const target = await firstClickableLocator(page, marcado, DEFAULT_CLICK_TIMEOUT_MS);
    await target.locator.click({ position: target.position, timeout: DEFAULT_CLICK_TIMEOUT_MS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/ninguno recibe el puntero|intercepts pointer events/i.test(message)) throw err;

    await log(ctx.taskId, "warn", "El corazón de la publicación está tapado por otra capa; se activa con teclado.");
    await page.locator(marcado).first().focus({ timeout: 3000 });
    await page.keyboard.press("Enter");
  }

  const deadline = Date.now() + INSTAGRAM_LIKE_VERIFY_MS;
  let despues: PostLikeProbe = probe;
  while (Date.now() <= deadline) {
    await page.waitForTimeout(VISIBLE_POLL_MS);
    despues = await markInstagramPostLike(page);
    if (despues.status === "already_liked") {
      await log(ctx.taskId, "info", `Like puesto y verificado (el corazón ahora dice "${despues.detail}").`);
      return;
    }
  }

  await assertNoKnownBlocker(page);
  throw new Error(
    `Se clickeó el corazón de la publicación pero Instagram no registró el like (sigue diciendo ` +
      `"${despues.detail}"). Suele ser el perfil con las acciones limitadas ("Inténtalo más tarde") o una capa ` +
      `que se comió el click.`,
  );
}

/**
 * Marcas de la caja de comentario y del botón de comentar de LA publicación.
 *
 * Con el post abierto en dialog, la página de atrás sigue montada con el feed,
 * y cada post del feed tiene su propio "Comentar…". El selector suelto se
 * quedaba con el primero del documento —el de otra publicación—: la tarea abría
 * ese post, el chequeo de URL la devolvía a la suya, y así cada reintento hasta
 * el timeout. Igual que con el like, se busca solo adentro del dialog del post.
 */
const FACEBOOK_COMMENT_BOX_MARK = "data-godeye-comment-box";
const FACEBOOK_COMMENT_OPEN_MARK = "data-godeye-comment-open";

type CommentTargets = { enDialog: boolean; caja: boolean; boton: boolean };

/**
 * Busca la caja de comentario y el botón de comentar del post y los deja marcados.
 *
 * La caja se reconoce por subcadena de su rótulo, en minúsculas y sin acentos:
 * "coment" alcanza a "Escribe un comentario…", "Comenta como Johana…" (el
 * rótulo del build actual, que el selector fijo no conocía) y "Comente como…";
 * "comment" a "Write a comment…", "Comment as…" y al francés. Se descartan las
 * cajas de respuesta, que viven en el mismo dialog.
 */
async function markFacebookCommentTargets(page: Page): Promise<CommentTargets> {
  await defineEsbuildNameHelper(page);
  return page
    .evaluate(
      ({ boxMark, openMark, rowLabels, openLabels, replyLabels }): CommentTargets => {
        const normalizar = (valor: string) =>
          valor
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();
        const contiene = (valor: string, palabras: string[]) => {
          const limpio = normalizar(valor);
          return Boolean(limpio) && palabras.some((palabra) => limpio.includes(normalizar(palabra)));
        };
        const visible = (el: Element) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const nombreDe = (el: Element) =>
          (el.getAttribute("aria-label") ?? "").trim() || (el.textContent ?? "").replace(/\s+/g, " ").trim();
        const botonesDe = (root: ParentNode) =>
          (Array.from(root.querySelectorAll('[role="button"], button')) as HTMLElement[]).filter(visible);

        for (const marked of Array.from(document.querySelectorAll(`[${boxMark}], [${openMark}]`))) {
          marked.removeAttribute(boxMark);
          marked.removeAttribute(openMark);
        }

        // Mismo criterio que markFacebookPostLike: el dialog visible que tenga
        // barra de acciones, el de más arriba primero.
        const dialogs = (Array.from(document.querySelectorAll('div[role="dialog"]')) as HTMLElement[])
          .filter(visible)
          .filter((d) => botonesDe(d).some((b) => contiene(nombreDe(b), rowLabels)))
          .reverse();
        const root: ParentNode = dialogs[0] ?? document;

        const cajas = (
          Array.from(root.querySelectorAll('[role="textbox"][contenteditable="true"]')) as HTMLElement[]
        ).filter(visible);
        const rotuloDeCaja = (el: HTMLElement) =>
          `${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("aria-placeholder") ?? ""}`;
        const esRespuesta = (el: HTMLElement) =>
          contiene(rotuloDeCaja(el), [...replyLabels, "respuesta", "resposta", "reponse"]);
        const caja =
          cajas.find((el) => !esRespuesta(el) && contiene(rotuloDeCaja(el), ["coment", "comment"])) ??
          cajas.find((el) => !esRespuesta(el) && el.closest("form")) ??
          null;
        if (caja) caja.setAttribute(boxMark, "1");

        // El de la barra de acciones del post —el que comparte fila con
        // "Compartir"— antes que cualquier otro con "comentar" en el nombre.
        const compartir = rowLabels.filter((r) => !contiene(r, ["coment", "comment"]));
        const enFilaConCompartir = (el: HTMLElement) => {
          let nodo: HTMLElement | null = el;
          for (let i = 0; i < 8; i += 1) {
            nodo = nodo?.parentElement ?? null;
            if (!nodo || nodo === root) return false;
            if (botonesDe(nodo).some((v) => v !== el && contiene(nombreDe(v), compartir))) return true;
          }
          return false;
        };
        const candidatos = botonesDe(root).filter((el) => contiene(nombreDe(el), openLabels));
        const boton = candidatos.find(enFilaConCompartir) ?? candidatos[0] ?? null;
        if (boton) boton.setAttribute(openMark, "1");

        return { enDialog: dialogs.length > 0, caja: Boolean(caja), boton: Boolean(boton) };
      },
      {
        boxMark: FACEBOOK_COMMENT_BOX_MARK,
        openMark: FACEBOOK_COMMENT_OPEN_MARK,
        rowLabels: FACEBOOK_ACTION_ROW_LABELS,
        openLabels: FACEBOOK_COMMENT_OPEN_LABELS,
        replyLabels: FACEBOOK_REPLY_LABELS,
      },
    )
    .catch(() => ({ enDialog: false, caja: false, boton: false }));
}

const FACEBOOK_COMMENT_BOX_MARKED = `[${FACEBOOK_COMMENT_BOX_MARK}]`;

/**
 * Prepara la página para el paso y, si encontró el elemento exacto, devuelve
 * el selector que apunta solo a él. `null` es usar el selector del paso.
 */
async function prepareSelectorTarget(page: Page, rawSelector: string, ctx: StepContext): Promise<string | null> {
  if (ctx.taskType === "like" && isFacebookLikeSelector(rawSelector)) {
    // Solo el botón marcado del post: el selector ancho por `aria-label`
    // también agarra el "Me gusta" de los comentarios.
    const probe = await prepareFacebookLike(page, ctx);
    if (probe.status === "ready") return POST_LIKE_SELECTOR;
    if (probe.status === "already_liked") return POST_LIKED_SELECTOR;
    throw await explicarFalloDeLike(page, `No se encontró el botón de reaccionar de la publicación (${probe.detail})`);
  }

  if (!esTareaDeComentario(ctx.taskType)) return null;

  if (isInstagramCommentBoxSelector(rawSelector)) {
    return prepareInstagramCommentBox(page, ctx);
  }

  if (!isFacebookCommentBoxSelector(rawSelector)) return null;

  // La comprobación de publicación va ANTES de darse por satisfecho con la
  // caja visible. Al revés —que es como estaba— el visor podía haberse pasado
  // a otro reel, y como ese otro reel también muestra su caja de comentarios,
  // la función salía por acá contenta y se terminaba comentando en la
  // publicación equivocada.
  await ensureOnTargetUrl(page, ctx);

  // Congelar el video antes de tocar nada: si sigue corriendo, cualquier
  // espera de las que vienen es una oportunidad para que el visor derive.
  await freezeReelPlayback(page);

  // La caja del post, si ya está a la vista. Con dialog, solo la de adentro:
  // una caja del feed de atrás es la de otra publicación. Sin dialog, la
  // página es la publicación y vale también el selector ancho.
  const buscarCaja = async () => {
    const marcas = await markFacebookCommentTargets(page);
    if (marcas.caja) return { marcas, selector: FACEBOOK_COMMENT_BOX_MARKED as string | null, lista: true };
    const lista = !marcas.enDialog && (await hasVisibleLocator(page, FACEBOOK_COMMENT_BOX_SELECTOR));
    return { marcas, selector: null, lista };
  };

  let estado = await buscarCaja();
  if (estado.lista) return estado.selector;

  // El panel de un reel con miles de comentarios tarda varios segundos en
  // cargar: primero muestra los esqueletos grises y recién después la caja.
  const esperarCaja = async (ms: number) => {
    const limite = Date.now() + ms;
    for (;;) {
      estado = await buscarCaja();
      if (estado.lista || Date.now() >= limite) return estado.lista;
      await page.waitForTimeout(700);
    }
  };

  // Se reintenta porque en el visor de Reels esto no es determinista: los
  // mismos pasos sobre el mismo reel a veces abren el panel y a veces no,
  // según qué capa haya aparecido, si el video ya se pasó al siguiente, o si
  // la interfaz todavía estaba animando. Un solo intento fallaba seguido.
  //
  // Pero "Comentar" abre Y CIERRA el panel. Clickearlo de nuevo —o mandarle
  // Enter— mientras el panel todavía cargaba lo cerraba, el visor se pasaba al
  // reel siguiente, la tarea volvía, y así hasta el timeout. Por eso se
  // clickea una sola vez por carga de la página y después se espera.
  let clickeado = false;
  for (let intento = 1; intento <= ABRIR_COMENTARIOS_INTENTOS; intento += 1) {
    if (await ensureOnTargetUrl(page, ctx)) clickeado = false;

    // Destapar: en los reels el botón de comentar está visible pero debajo del
    // cuadro de sugerencias, y así el click nunca le llega.
    await dismissFacebookOverlays(page, ctx);
    estado = await buscarCaja();
    if (estado.lista) return estado.selector;

    if (clickeado) {
      await log(ctx.taskId, "info", "El panel de comentarios ya se abrió; se espera a que cargue la caja.");
      if (await esperarCaja(6000)) return estado.selector;
      continue;
    }

    // Con dialog se clickea solo el "Comentar" de adentro. El selector suelto
    // agarraba el primero del documento, que es el de un post del feed de
    // atrás: abría otra publicación y la tarea volvía a empezar.
    const abrir = estado.marcas.boton
      ? `[${FACEBOOK_COMMENT_OPEN_MARK}]`
      : estado.marcas.enDialog
        ? null
        : FACEBOOK_COMMENT_OPEN_SELECTOR;

    let target: ClickableTarget | null = null;
    if (abrir) {
      try {
        target = await firstClickableLocator(page, abrir, 2500);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (esFrenoDeLaRed(message)) throw err;
      }
    }

    if (target) {
      await log(ctx.taskId, "info", "Abriendo panel/caja de comentarios de Facebook.");
      await target.locator.click({ position: target.position, timeout: 2500 }).catch(() => {});
      clickeado = true;
      if (await esperarCaja(8000)) return estado.selector;
      continue;
    }

    // El botón puede estar tapado por una capa que no sabemos cerrar; el
    // teclado no necesita que reciba el puntero. Solo cuando el click no fue
    // posible —si no, cerraría el panel que el click abrió— y sin dialog: el
    // selector de teclado no distingue el post de la tarea de los del feed.
    if (!estado.marcas.enDialog && (await openCommentsWithKeyboard(page, ctx))) {
      return (await buscarCaja()).selector;
    }

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
    `No se pudo abrir los comentarios (${
      estado.marcas.enDialog ? "buscando en el dialog del post" : "buscando en la página"
    }). Botones visibles en la página: ${await describeVisibleButtons(page)}`,
  );
  return null;
}

function isNavigationTimeout(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return /page\.goto: Timeout|Timeout .* exceeded|waiting until "domcontentloaded"/i.test(message);
}

// Cortes de red de la conexión (casi siempre el proxy del perfil): el mismo
// goto unos segundos después suele entrar. No incluye timeouts, que ya tienen
// su propio manejo, ni errores de la página en sí.
function isTransientNetworkError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return /net::ERR_(CONNECTION_(CLOSED|RESET|REFUSED|ABORTED|FAILED)|EMPTY_RESPONSE|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR|SSL_PROTOCOL_ERROR|TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE)/.test(
    message,
  );
}

const GOTO_NETWORK_RETRY_DELAYS_MS = [3000, 6000, 10000];

// web.facebook.com es un alias regional; si esa conexión se corta, se prueba
// por www. La comparación con la URL de la tarea es solo por ruta, así que el
// cambio de host no la afecta.
function alternateFacebookHost(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "web.facebook.com") return null;
    parsed.hostname = "www.facebook.com";
    return parsed.toString();
  } catch {
    return null;
  }
}

async function gotoWithNetworkRetries(page: Page, url: string, timeoutMs: number, ctx: StepContext) {
  const alternate = alternateFacebookHost(url);
  for (let intento = 0; ; intento += 1) {
    // A partir del segundo reintento se alterna con el host de www.
    const destino = alternate && intento >= 2 && intento % 2 === 0 ? alternate : url;
    try {
      await page.goto(destino, { waitUntil: "commit", timeout: timeoutMs });
      return;
    } catch (err) {
      const delay = GOTO_NETWORK_RETRY_DELAYS_MS[intento];
      if (!isTransientNetworkError(err) || delay === undefined) throw err;
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      await log(
        ctx.taskId,
        "warn",
        `Se cortó la conexión al abrir la publicación (${message}); reintento ${intento + 1} de ${
          GOTO_NETWORK_RETRY_DELAYS_MS.length
        } en ${delay / 1000}s.`,
      );
      await page.waitForTimeout(delay);
    }
  }
}

async function gotoPage(page: Page, url: string, timeoutMs: number, ctx: StepContext) {
  const beforeUrl = page.url();
  try {
    await gotoWithNetworkRetries(page, url, timeoutMs, ctx);
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
 *   fecha ("hace 2 h"), el mismo del que se cuelga markFacebookComment.
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

    // Lo que se encontró es el texto todavía en la caja, sin enviar: eso no
    // es un comentario publicado.
    if (comentario.closest('[contenteditable="true"], [contenteditable=""], textarea')) return ausente;

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
      valor.length <= 14 && /^(ahora|just now|now|(hace\s+)?\d+\s*[a-záéíóú]{0,10})$/i.test(valor);

    // Al enviar, Facebook pinta el comentario al instante con un id provisorio
    // del navegador (`comment_id=client:4fc59b57-…`) y recién después lo
    // reemplaza por el definitivo que asigna el servidor. Guardar el provisorio
    // deja un enlace que no le sirve a nadie, así que se descarta y se sigue
    // esperando al de verdad.
    const esProvisorio = (href: string) => /(^|[?&])(reply_)?comment_id=client(%3A|:)/i.test(href);

    const conComentario = anclas.filter((el) => {
      const href = el.getAttribute("href") ?? "";
      return /(^|[?&])(reply_)?comment_id=/.test(href) && !esProvisorio(href);
    });

    // El permalink apunta a la publicación; el link del nombre, al perfil del
    // autor. Comparar la ruta es lo que mejor los separa —no depende del idioma
    // ni de que la hora ya se haya renderizado— y es justo lo que faltaba
    // cuando se guardó un `profile.php` como si fuera el comentario.
    const rutaActual = location.pathname.replace(/\/+$/, "");
    const mismaRuta = (el: HTMLAnchorElement) => {
      try {
        return new URL(el.getAttribute("href") ?? "", location.origin).pathname.replace(/\/+$/, "") === rutaActual;
      } catch {
        return false;
      }
    };

    // Sin candidato bueno se prefiere no devolver nada: un permalink
    // equivocado es peor que ninguno, porque el resto del sistema lo cree.
    const permalink =
      conComentario.find((el) => mismaRuta(el) && esHora((el.textContent ?? "").trim())) ??
      conComentario.find((el) => mismaRuta(el)) ??
      null;

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
          // Se conserva `id` y se descarta todo lo demás. Los perfiles sin
          // nombre de usuario son `/profile.php?id=100058…`: ahí el
          // identificador está en la query, y limpiarla entera deja un
          // `profile.php` pelado que abre el perfil de quien esté logueado.
          // El resto de los parámetros son el comment_id y seguimiento.
          const id = u.searchParams.get("id");
          perfilUrl = id ? `${u.origin}${u.pathname}?id=${encodeURIComponent(id)}` : `${u.origin}${u.pathname}`;
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
async function waitForPublishedComment(
  page: Page,
  texto: string,
  timeoutMs: number,
  opciones: { alNoEncontrar?: () => Promise<unknown>; sinEnlace?: boolean } = {},
): Promise<CommentProbe> {
  const limite = Date.now() + timeoutMs;
  let ultimo: CommentProbe = { encontrado: false, url: null, perfilUrl: null };
  for (;;) {
    ultimo = await findPublishedComment(page, texto);
    // Con el comentario ya encontrado se sigue esperando un poco por su
    // enlace, que aparece después — pero sin dejar que la falta de enlace
    // consuma todo el tiempo restante. Donde la red nunca da ese enlace
    // (Instagram), esperarlo es tiempo perdido.
    if (ultimo.url || (ultimo.encontrado && opciones.sinEnlace)) return ultimo;
    if (Date.now() >= limite) return ultimo;
    if (!ultimo.encontrado) await opciones.alNoEncontrar?.();
    await page.waitForTimeout(VISIBLE_POLL_MS * 4);
  }
}

/**
 * Lo que respondió el servidor de la red al envío del comentario.
 *
 * `ok` es que lo creó; `error`, que lo rechazó y por qué (perfil limitado,
 * spam, publicación sin comentarios). `id`/`url`/`perfilUrl` salen de la propia
 * respuesta cuando vienen.
 */
type ConfirmacionDeEnvio =
  | { ok: true; id: string | null; url: string | null; perfilUrl: string | null }
  | { ok: false; error: string };

type EnvioComentario = {
  /** Se resuelve con la respuesta del servidor, o `null` si no se vio ningún envío. */
  esperar: (timeoutMs: number) => Promise<ConfirmacionDeEnvio | null>;
  cancelar: () => void;
  /** Los POST a la red que pasaron mientras se escuchaba; para el log si no se reconoció ninguno. */
  vistos: string[];
};

const ENVIO_ESCUCHA_MAX_MS = 120_000;

/**
 * Escucha en la red el envío del comentario que se acaba de escribir.
 *
 * Buscar el comentario en pantalla daba falsos "no apareció": Instagram lo
 * mete en el medio de la lista y el panel solo renderiza lo scrolleado, y el
 * operador relanzaba una tarea que ya había publicado — comentario duplicado.
 * El servidor, en cambio, contesta en el acto si lo creó.
 *
 * El envío se reconoce por contenido y no por dirección, porque Facebook e
 * Instagram cambian los endpoints seguido: un POST a un endpoint de graphql o
 * de comentarios cuyo cuerpo lleva el texto. Para contarlo como creado, la
 * respuesta tiene que traer el texto de vuelta (las dos redes devuelven el
 * comentario creado); eso descarta pedidos que solo lo mencionan, como los de
 * telemetría. Se arranca a escuchar después de escribir, así no entran las
 * búsquedas de menciones que salen mientras se tipea.
 */
function vigilarEnvioComentario(page: Page, texto: string): EnvioComentario {
  const normalizar = (valor: string) =>
    valor
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  const buscado = normalizar(texto);

  const decodificarCuerpo = (crudo: string) => {
    let valor = crudo;
    try {
      valor = decodeURIComponent(crudo.replace(/\+/g, " "));
    } catch {
      // No era form-urlencoded: se compara tal cual.
    }
    return desescaparJson(valor);
  };

  let resolver: (r: ConfirmacionDeEnvio | null) => void = () => {};
  const resultado = new Promise<ConfirmacionDeEnvio | null>((r) => (resolver = r));
  let terminado = false;
  const vistos: string[] = [];

  const terminar = (r: ConfirmacionDeEnvio | null) => {
    if (terminado) return;
    terminado = true;
    page.off("response", alResponder);
    clearTimeout(tope);
    resolver(r);
  };

  const alResponder = async (response: import("playwright-core").Response) => {
    if (terminado || !buscado) return;
    const request = response.request();
    if (request.method() !== "POST") return;
    const url = request.url();
    if (/(facebook|instagram)\.com/i.test(url) && vistos.length < 15) {
      vistos.push(`${url.replace(/^https:\/\/(www\.)?/, "").split("?")[0]} ${response.status()}`);
    }
    if (!/(facebook|instagram)\.com/i.test(url) || !/graphql|comment/i.test(url)) return;
    const enviado = request.postData();
    if (!enviado || !normalizar(decodificarCuerpo(enviado)).includes(buscado)) return;

    const cuerpo = desescaparJson(await response.text().catch(() => ""));
    // Facebook manda avisos en `errors` aun en respuestas exitosas, así que el
    // eco del texto manda: si el comentario volvió creado, está creado.
    const creado =
      response.status() < 400 && !/"status"\s*:\s*"fail"/.test(cuerpo) && normalizar(cuerpo).includes(buscado);
    if (creado) {
      terminar({ ok: true, ...datosDelComentarioCreado(cuerpo, page.url()) });
      return;
    }
    const rechazo = rechazoDeLaRed(response.status(), cuerpo);
    if (rechazo) terminar({ ok: false, error: rechazo });
  };

  page.on("response", alResponder);
  const tope = setTimeout(() => terminar(null), ENVIO_ESCUCHA_MAX_MS);

  return {
    esperar: (timeoutMs) =>
      Promise.race([resultado, new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]),
    cancelar: () => terminar(null),
    vistos,
  };
}

/** Deshace los escapes de JSON que traen las respuestas de Facebook (`á`, `\/`). */
function desescaparJson(valor: string) {
  return valor
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/");
}

/** El motivo, si la respuesta es un rechazo explícito del comentario. */
function rechazoDeLaRed(status: number, cuerpo: string): string | null {
  const mensaje =
    cuerpo.match(/"status"\s*:\s*"fail"[\s\S]{0,400}?"message"\s*:\s*"([^"]{1,200})"/)?.[1] ??
    cuerpo.match(/"message"\s*:\s*"([^"]{1,200})"[\s\S]{0,400}?"status"\s*:\s*"fail"/)?.[1] ??
    cuerpo.match(/"errors"\s*:\s*\[\s*\{[\s\S]{0,400}?"(?:message|description|summary)"\s*:\s*"([^"]{1,200})"/)?.[1] ??
    null;
  if (mensaje) return mensaje;
  if (/"status"\s*:\s*"fail"/.test(cuerpo)) return "la red rechazó el comentario sin dar motivo";
  if (status >= 400) return `la red respondió ${status} al enviar el comentario`;
  return null;
}

/** El id, el permalink y el perfil del autor, de la respuesta de creación. */
function datosDelComentarioCreado(cuerpo: string, paginaUrl: string) {
  // Facebook: la respuesta trae el permalink entero con `comment_id`.
  const urlFacebook = cuerpo.match(/"url"\s*:\s*"(https:\/\/www\.facebook\.com[^"]*[?&]comment_id=[^"]+)"/)?.[1] ?? null;

  // Instagram: solo el id, para el log. La respuesta trae también ids y
  // usuarios de la publicación y de su dueño, y armar con eso un permalink o
  // un perfil es arriesgar uno equivocado, que es peor que ninguno.
  if (/instagram\.com/i.test(paginaUrl)) {
    return { id: cuerpo.match(/"id"\s*:\s*"(\d{10,})"/)?.[1] ?? null, url: null, perfilUrl: null };
  }

  return { id: urlFacebook?.match(/comment_id=([^&]+)/)?.[1] ?? null, url: urlFacebook, perfilUrl: null };
}

/**
 * Avanza el scroll del panel de comentarios de Instagram.
 *
 * Instagram no pone el comentario recién enviado arriba de la lista: lo mete
 * más abajo, entre los demás, y el panel solo renderiza lo que se fue
 * scrolleando. La verificación miraba el DOM sin moverse, no lo encontraba, y
 * la tarea fallaba con el comentario ya publicado; al relanzarla salía
 * duplicado. Se baja de a una pantalla y al llegar al fondo se vuelve arriba.
 */
async function scrollInstagramComments(page: Page) {
  await defineEsbuildNameHelper(page);
  await page
    .evaluate(() => {
      const raiz = document.querySelector('[role="dialog"]') ?? document.body;
      for (const el of Array.from(raiz.querySelectorAll("div, ul"))) {
        const h = el as HTMLElement;
        if (h.scrollHeight <= h.clientHeight + 20 || h.clientHeight < 80) continue;
        const overflow = getComputedStyle(h).overflowY;
        if (overflow !== "auto" && overflow !== "scroll") continue;
        const alFondo = h.scrollTop + h.clientHeight >= h.scrollHeight - 5;
        h.scrollTop = alFondo ? 0 : h.scrollTop + h.clientHeight * 0.8;
      }
    })
    .catch(() => {});
}

/**
 * Qué botón hay que marcar dentro del comentario.
 *
 * Like y responder compartían el 80% del código —ubicar el comentario por su
 * `comment_id` y subir a su contenedor es exactamente el mismo problema— en dos
 * copias que ya habían empezado a divergir. Van por una sola función porque la
 * parte difícil, emparejar el id, acaba de crecer y no puede vivir duplicada.
 */
type MarcaDeComentario = {
  /** Atributo con el que se marca el botón encontrado, para que Playwright lo pulse. */
  mark: string;
  /** Rótulos del botón que se busca, en todos los idiomas mapeados. */
  targetLabels: string[];
  /** Cómo se llama ese botón en el mensaje de error. */
  targetName: string;
  /**
   * Rótulos del botón ya pulsado. Solo el like los tiene: si el comentario ya
   * está likeado hay que decirlo y no volver a pulsarlo, que lo desharía.
   * Responder no tiene estado, así que va sin esto.
   */
  pressedLabels?: string[];
};

const MARCA_LIKE: MarcaDeComentario = {
  mark: FACEBOOK_COMMENT_LIKE_MARK,
  targetLabels: FACEBOOK_LIKE_LABELS,
  targetName: "Me gusta",
  pressedLabels: FACEBOOK_UNLIKE_LABELS,
};

const MARCA_RESPUESTA: MarcaDeComentario = {
  mark: FACEBOOK_COMMENT_REPLY_MARK,
  targetLabels: FACEBOOK_REPLY_LABELS,
  targetName: "Responder",
};

/**
 * Ubica el comentario en la página y marca su botón, o dice por qué no pudo.
 */
async function markFacebookComment(
  page: Page,
  commentId: string,
  marca: MarcaDeComentario,
): Promise<CommentLikeProbe> {
  await defineEsbuildNameHelper(page);
  return page.evaluate(
    ({ commentId, mark, targetLabels, targetName, pressedLabels }): CommentLikeProbe => {
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

      /**
       * Todas las formas en las que un mismo comentario puede venir escrito.
       *
       * Facebook identifica un comentario de dos maneras: numérica
       * (`comment_id=2459428374544479`) y base64 en los permalinks nuevos
       * (`comment_id=Y29tbWVudDo...`), que decodifica a
       * `comment:<id_del_post>_<id_del_comentario>`. El link que pegó el
       * operador y el href que Facebook renderiza no tienen por qué usar la
       * misma, y compararlas como cadenas era justo lo que fallaba: el
       * comentario estaba a la vista y el runner decía no encontrarlo.
       *
       * Reduciendo las dos formas a los números que contienen, las dos se
       * encuentran. El mínimo de seis dígitos deja afuera los números sueltos
       * de un permalink (`?_rdr=1`, un índice de página) sin llegar nunca a
       * excluir un id real, que tiene quince o dieciséis.
       */
      const digitos = (valor: string) => valor.match(/\d{6,}/g) ?? [];

      const formasDe = (valor: string) => {
        const formas = new Set<string>();
        const bruto = valor.trim();
        if (!bruto) return formas;

        formas.add(bruto);

        let plano = bruto;
        try {
          plano = decodeURIComponent(bruto);
        } catch {
          // Escapes inválidos: queda la forma cruda, que ya está adentro.
        }
        formas.add(plano);
        for (const numero of digitos(plano)) formas.add(numero);

        // base64, con el padding `%3D` ya resuelto arriba y aceptando la
        // variante url-safe. Solo vale si lo que sale es texto imprimible: un
        // id numérico largo también "decodifica", pero a basura binaria.
        try {
          const texto = atob(plano.replace(/-/g, "+").replace(/_/g, "/"));
          if (texto && /^[\x20-\x7e]+$/.test(texto)) {
            formas.add(texto);
            for (const numero of digitos(texto)) formas.add(numero);
          }
        } catch {
          // No era base64.
        }

        return formas;
      };

      /** Los `comment_id` / `reply_comment_id` que lleva un href. */
      const valoresDelHref = (href: string) => {
        const valores: string[] = [];
        const variantes = [href];
        try {
          const plano = decodeURIComponent(href);
          if (plano !== href) variantes.push(plano);
        } catch {
          // href con escapes inválidos: basta con la forma cruda.
        }

        for (const variante of variantes) {
          const patron = /(?:^|[?&])(?:reply_)?comment_id=([^&#]+)/g;
          for (let m = patron.exec(variante); m; m = patron.exec(variante)) {
            valores.push(m[1]);
          }
        }
        return valores;
      };

      const buscadas = formasDe(commentId);
      const links = Array.from(document.querySelectorAll("a[href]"));
      const anchors = links.filter((a) =>
        valoresDelHref(a.getAttribute("href") ?? "").some((valor) => {
          for (const forma of formasDe(valor)) {
            if (buscadas.has(forma)) return true;
          }
          return false;
        }),
      );

      if (!anchors.length) {
        const articles = document.querySelectorAll('[role="article"]').length;

        // Qué ids SÍ hay. Antes el error solo decía "no está", y con eso no se
        // podía distinguir "el link es de otra publicación" de "Facebook los
        // renderiza con otro formato" o de "esta vista no pone permalinks en
        // los comentarios". Con la muestra, el log lo dice solo.
        const vistos = new Set<string>();
        for (const a of links) {
          for (const valor of valoresDelHref(a.getAttribute("href") ?? "")) {
            vistos.add(valor.slice(0, 60));
          }
        }
        const muestra = Array.from(vistos).slice(0, 5);
        const restantes = vistos.size - muestra.length;
        const idsEnPagina = muestra.length
          ? `ids en la página: ${muestra.join(", ")}${restantes > 0 ? ` y ${restantes} más` : ""}`
          : "ningún link con comment_id en la página";

        return {
          status: "not_found",
          detail: `${articles} comentario(s) renderizado(s); ${idsEnPagina}`,
        };
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
      const esObjetivo = (el: Element) =>
        matchesAny(labelOf(el), targetLabels) || matchesAny(textOf(el), targetLabels);

      if (pressedLabels && pressedLabels.length) {
        const pulsado = buttons.find(
          (button) =>
            matchesAny(labelOf(button), pressedLabels) ||
            (button.getAttribute("aria-pressed") === "true" && esObjetivo(button)),
        );
        if (pulsado) return { status: "already_liked", detail: "" };
      }

      const objetivo = buttons.find(esObjetivo);
      if (!objetivo) {
        return {
          status: "no_button",
          detail: `${buttons.length} botón(es) en el comentario, ninguno rotulado como "${targetName}"`,
        };
      }

      objetivo.setAttribute(mark, "1");
      // El picker de reacciones se abre hacia arriba: el comentario tiene que
      // quedar a media pantalla para que quepa.
      article.scrollIntoView({ block: "center" });
      return { status: "ready", detail: "" };
    },
    {
      commentId,
      mark: marca.mark,
      targetLabels: marca.targetLabels,
      targetName: marca.targetName,
      pressedLabels: marca.pressedLabels ?? [],
    },
  );
}

/**
 * Reintenta la búsqueda mientras el comentario no aparezca: Facebook carga los
 * comentarios de a poco y el que se busca puede estar detrás de un "Ver más
 * comentarios", sobre todo en publicaciones con mucha conversación.
 */
async function resolveFacebookComment(
  page: Page,
  commentId: string,
  marca: MarcaDeComentario,
  timeoutMs: number,
  ctx: StepContext,
): Promise<CommentLikeProbe> {
  const deadline = Date.now() + timeoutMs;
  let probe = await markFacebookComment(page, commentId, marca);
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
    probe = await markFacebookComment(page, commentId, marca);
  }

  return probe;
}

function resolveFacebookCommentLike(page: Page, commentId: string, timeoutMs: number, ctx: StepContext) {
  return resolveFacebookComment(page, commentId, MARCA_LIKE, timeoutMs, ctx);
}

function resolveFacebookCommentReply(page: Page, commentId: string, timeoutMs: number, ctx: StepContext) {
  return resolveFacebookComment(page, commentId, MARCA_RESPUESTA, timeoutMs, ctx);
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

type FacebookFollowButtonState = "follow" | "following" | "requested" | "missing";

/**
 * El perfil a seguir no admite seguidores: solo ofrece "Agregar a amigos". No
 * es un fallo de esta cuenta sino del destino, así que ninguna otra tarea de la
 * campaña contra ese perfil va a poder; runTask la usa para frenarlas.
 */
class FollowNotAllowedError extends Error {}

const FOLLOW_NOT_ALLOWED_MESSAGE =
  'Este perfil solo permite "Agregar a amigos": no tiene activada la opción de seguir. No se envió solicitud de amistad.';

type FacebookProfileHeader = {
  state: FacebookFollowButtonState;
  /** Cuántos menús de opciones ("⌄" junto a Mensaje, "⋯" de las pestañas) quedaron marcados. */
  menuCount: number;
  /** Tiene "Agregar a amigos" / "Añadir amigo": sirve para explicar por qué no se pudo seguir. */
  hasFriendButton: boolean;
  debug: string;
};

const FACEBOOK_FOLLOW_MAX_MENUS = 4;

/**
 * Lee el encabezado del perfil: en qué estado está el botón de seguir y qué
 * menús de opciones hay. Se queda con los botones más cercanos al nombre (el
 * h1) para no confundirlos con los "Seguir" de publicaciones o sugerencias.
 *
 * Con `markButtons` deja marcado el botón "Seguir" (`follow`) y los menús
 * (`menu-0`, `menu-1`…, del más cercano al nombre al más lejano) para
 * clickearlos después desde Playwright.
 */
async function readFacebookProfileHeader(page: Page, markButtons = false): Promise<FacebookProfileHeader> {
  await defineEsbuildNameHelper(page);
  return page.evaluate(
    ({ mark, shouldMark, maxMenus }: { mark: string; shouldMark: boolean; maxMenus: number }): FacebookProfileHeader => {
      const normalize = (value: string) =>
        value
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();
      const visible = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return Boolean(element.getClientRects().length) && style.visibility !== "hidden" && style.display !== "none";
      };
      const labels = (element: HTMLElement) =>
        [element.getAttribute("aria-label") ?? "", element.innerText ?? "", element.textContent ?? ""]
          .map(normalize)
          .filter(Boolean);
      // El rótulo puede venir solo ("Seguir") o con el nombre ("Seguir a Ana",
      // "Follow Ana"), así que se compara el inicio del texto.
      const startsWithAny = (value: string, prefixes: string[]) =>
        prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix} `));
      const followingPrefixes = ["following", "siguiendo", "unfollow", "dejar de seguir"];
      const requestedPrefixes = ["requested", "solicitud enviada", "solicitado", "solicitada"];
      const followPrefixes = ["follow", "seguir"];
      const friendPrefixes = ["agregar a amigos", "anadir amigo", "anadir a amigos", "add friend"];
      // Los menús del perfil son botones de solo ícono ("⌄", "⋯"): o dicen
      // "opciones" en el aria-label, o despliegan algo y no tienen texto.
      const isOptions = (element: HTMLElement, values: string[]) =>
        values.some((value) => /\b(options|opciones)\b/.test(value)) ||
        ((element.hasAttribute("aria-haspopup") || element.hasAttribute("aria-expanded")) &&
          !normalize(element.innerText ?? ""));
      // La barra de arriba, el menú lateral y los chats también tienen h1 y
      // botones; nada de eso es el perfil.
      const outsideProfile = (element: Element) =>
        Boolean(element.closest('[role="banner"], [role="navigation"], [role="complementary"], [role="dialog"]'));
      const main = document.querySelector<HTMLElement>('[role="main"]');
      const headings = Array.from(document.querySelectorAll<HTMLElement>("h1")).filter(
        (element) => visible(element) && !outsideProfile(element) && normalize(element.innerText ?? ""),
      );
      const heading = headings.find((element) => main?.contains(element)) ?? headings[0] ?? null;

      if (shouldMark) {
        document.querySelectorAll(`[${mark}]`).forEach((element) => element.removeAttribute(mark));
      }

      const distanceFromHeading = (element: HTMLElement) => {
        if (!heading) return 0;
        const ancestors = new Map<Element, number>();
        let distance = 0;
        for (let node: Element | null = heading; node; node = node.parentElement) {
          ancestors.set(node, distance);
          distance += 1;
        }
        distance = 0;
        for (let node: Element | null = element; node; node = node.parentElement) {
          const headingDistance = ancestors.get(node);
          if (headingDistance !== undefined) return distance + headingDistance;
          distance += 1;
        }
        return Number.MAX_SAFE_INTEGER;
      };

      const matches: { element: HTMLElement; state: FacebookFollowButtonState; distance: number }[] = [];
      const menus: { element: HTMLElement; distance: number }[] = [];
      const seen: { label: string; distance: number }[] = [];
      let hasFriendButton = false;
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
        if (!visible(element) || outsideProfile(element)) continue;
        const values = labels(element);
        const distance = distanceFromHeading(element);
        seen.push({ label: values[0] ?? "(sin texto)", distance });
        if (values.some((value) => startsWithAny(value, friendPrefixes))) {
          hasFriendButton = true;
          continue;
        }
        if (isOptions(element, values)) {
          menus.push({ element, distance });
          continue;
        }
        let state: FacebookFollowButtonState = "missing";
        if (values.some((value) => startsWithAny(value, followingPrefixes))) state = "following";
        else if (values.some((value) => startsWithAny(value, requestedPrefixes))) state = "requested";
        else if (values.some((value) => startsWithAny(value, followPrefixes))) state = "follow";
        if (state === "missing") continue;
        matches.push({ element, state, distance });
      }
      matches.sort((a, b) => a.distance - b.distance);
      menus.sort((a, b) => a.distance - b.distance);
      const first = matches[0];
      const nearMenus = menus.slice(0, maxMenus);
      if (shouldMark) {
        if (first?.state === "follow") first.element.setAttribute(mark, "follow");
        nearMenus.forEach((menu, index) => menu.element.setAttribute(mark, `menu-${index}`));
      }
      seen.sort((a, b) => a.distance - b.distance);
      return {
        state: first?.state ?? "missing",
        menuCount: nearMenus.length,
        hasFriendButton,
        debug:
          `h1: ${heading ? JSON.stringify(normalize(heading.innerText ?? "").slice(0, 60)) : "ninguno"}; ` +
          `botones cercanos: ${seen
            .slice(0, 15)
            .map((item) => JSON.stringify(item.label.slice(0, 40)))
            .join(", ")}`,
      };
    },
    { mark: FACEBOOK_FOLLOW_MARK, shouldMark: markButtons, maxMenus: FACEBOOK_FOLLOW_MAX_MENUS },
  );
}

/**
 * Lee el menú desplegable abierto ("⋯" del perfil) y marca la opción "Seguir"
 * si está. "Dejar de seguir" en el menú significa que ya se sigue.
 */
type FacebookFollowMenu = { state: "follow" | "following" | "missing"; items: string[] };

async function readFacebookFollowMenu(page: Page): Promise<FacebookFollowMenu> {
  await defineEsbuildNameHelper(page);
  return page.evaluate((mark: string): FacebookFollowMenu => {
    const normalize = (value: string) =>
      value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
    const visible = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      return Boolean(element.getClientRects().length) && style.visibility !== "hidden" && style.display !== "none";
    };
    // Las opciones a veces traen una descripción debajo: solo cuenta la
    // primera línea, que es el rótulo.
    const firstLine = (element: HTMLElement) => normalize((element.innerText ?? "").split("\n")[0] ?? "");
    const startsWithAny = (value: string, prefixes: string[]) =>
      prefixes.some((prefix) => value === prefix || value.startsWith(`${prefix} `));

    document.querySelectorAll(`[${mark}="item"]`).forEach((element) => element.removeAttribute(mark));
    let state: FacebookFollowMenu["state"] = "missing";
    const items: string[] = [];
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))) {
      if (!visible(element)) continue;
      const values = [firstLine(element), normalize(element.getAttribute("aria-label") ?? "")];
      items.push(values[0] || values[1]);
      if (values.some((value) => startsWithAny(value, ["unfollow", "dejar de seguir"]))) {
        return { state: "following", items };
      }
      if (state === "missing" && values.some((value) => startsWithAny(value, ["follow", "seguir"]))) {
        element.setAttribute(mark, "item");
        state = "follow";
      }
    }
    return { state, items };
  }, FACEBOOK_FOLLOW_MARK);
}

/** Abre uno de los menús del perfil (por orden de cercanía al nombre) y espera sus opciones. */
async function openFacebookProfileOptions(page: Page, index: number): Promise<FacebookFollowMenu> {
  await readFacebookProfileHeader(page, true);
  const target = await firstClickableLocator(page, `[${FACEBOOK_FOLLOW_MARK}="menu-${index}"]`, DEFAULT_CLICK_TIMEOUT_MS);
  await target.locator.click({ position: target.position, timeout: DEFAULT_CLICK_TIMEOUT_MS });
  const deadline = Date.now() + 5000;
  let menu = await readFacebookFollowMenu(page);
  while (menu.state === "missing" && Date.now() < deadline) {
    await page.waitForTimeout(300);
    menu = await readFacebookFollowMenu(page);
  }
  return menu;
}

/**
 * Muchos perfiles personales muestran "Agregar a amigos" como botón principal
 * y dejan "Seguir" escondido en un menú: el "⌄" junto a "Mensaje" o el "⋯" de
 * las pestañas. Se prueban en orden hasta dar con "Seguir", se sigue desde ahí
 * y se confirma reabriendo ese menú, que pasa a ofrecer "Dejar de seguir".
 *
 * Si ninguno lo tiene, el perfil no permite seguidores. No se manda solicitud
 * de amistad en su lugar: es otra acción, y Facebook vigila más las masivas.
 */
async function followFromProfileOptions(page: Page, ctx: StepContext, header: FacebookProfileHeader) {
  const seen: string[] = [];
  let menuIndex = -1;
  for (let index = 0; index < header.menuCount; index += 1) {
    const menu = await openFacebookProfileOptions(page, index);
    if (menu.state === "following") {
      await page.keyboard.press("Escape");
      await log(ctx.taskId, "info", "Este perfil ya seguía a la cuenta; no se hizo ningún cambio.");
      return;
    }
    if (menu.state === "follow") {
      menuIndex = index;
      break;
    }
    seen.push(`[${menu.items.map((item) => JSON.stringify(item)).join(", ") || "vacío"}]`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }
  if (menuIndex < 0) {
    if (header.hasFriendButton) {
      throw new FollowNotAllowedError(`${FOLLOW_NOT_ALLOWED_MESSAGE} Menús revisados: ${seen.join(" ")}.`);
    }
    throw new Error(
      'El perfil no tiene "Seguir" ni en el encabezado ni en sus menús. Puede que la cuenta no permita seguidores o que Facebook no se lo muestre a este perfil. ' +
        `Menús revisados: ${seen.join(" ")}. Lo que se vio: ${header.debug}.`,
    );
  }

  const item = await firstClickableLocator(page, `[${FACEBOOK_FOLLOW_MARK}="item"]`, DEFAULT_CLICK_TIMEOUT_MS);
  await item.locator.click({ position: item.position, timeout: DEFAULT_CLICK_TIMEOUT_MS });
  await page.waitForTimeout(2000);
  await assertNoKnownBlocker(page);

  const after = await readFacebookProfileHeader(page);
  if (after.state === "following" || after.state === "requested") {
    await log(ctx.taskId, "info", "Seguimiento confirmado en el perfil (desde su menú de opciones).");
    return;
  }
  const confirm = await openFacebookProfileOptions(page, menuIndex);
  await page.keyboard.press("Escape");
  if (confirm.state === "following") {
    await log(ctx.taskId, "info", "Seguimiento confirmado en el perfil (desde su menú de opciones).");
    return;
  }
  throw new Error(
    'Se hizo clic en "Seguir" desde el menú de opciones, pero Facebook no confirmó el seguimiento. Verifica el perfil antes de reintentar.',
  );
}

async function followFacebookProfile(page: Page, ctx: StepContext) {
  await assertNoKnownBlocker(page);
  let header = await readFacebookProfileHeader(page, true);
  if (header.state === "missing" && !header.menuCount && !header.hasFriendButton) {
    // Pasa cuando la página todavía no terminó de pintar el encabezado.
    await page.waitForTimeout(4000);
    await assertNoKnownBlocker(page);
    header = await readFacebookProfileHeader(page, true);
  }
  if (header.state === "following") {
    await log(ctx.taskId, "info", "Este perfil ya seguía a la cuenta; no se hizo ningún cambio.");
    return;
  }
  if (header.state === "requested") {
    await log(ctx.taskId, "info", "Ya había una solicitud de seguimiento pendiente para esta cuenta.");
    return;
  }
  if (header.state === "missing") {
    if (header.menuCount) {
      await followFromProfileOptions(page, ctx, header);
      return;
    }
    if (header.hasFriendButton) throw new FollowNotAllowedError(FOLLOW_NOT_ALLOWED_MESSAGE);
    throw new Error(
      'No se encontró un botón "Seguir" reconocible en el perfil. Revisa el link, el idioma de Facebook y que esta cuenta permita seguirlo. ' +
        `Lo que se vio: ${header.debug}.`,
    );
  }

  const target = await firstClickableLocator(page, `[${FACEBOOK_FOLLOW_MARK}="follow"]`, DEFAULT_CLICK_TIMEOUT_MS);
  await target.locator.click({ position: target.position, timeout: DEFAULT_CLICK_TIMEOUT_MS });

  const deadline = Date.now() + 10000;
  let lastBlockerCheckAt = 0;
  while (Date.now() <= deadline) {
    if (Date.now() - lastBlockerCheckAt >= BLOCKER_CHECK_INTERVAL_MS) {
      lastBlockerCheckAt = Date.now();
      await assertNoKnownBlocker(page);
    }
    const { state } = await readFacebookProfileHeader(page);
    if (state === "following") {
      await log(ctx.taskId, "info", "Seguimiento confirmado en el perfil.");
      return;
    }
    if (state === "requested") {
      await log(ctx.taskId, "info", "Facebook registró la solicitud de seguimiento.");
      return;
    }
    await page.waitForTimeout(300);
  }

  throw new Error(
    'Se hizo clic en "Seguir", pero Facebook no confirmó que el seguimiento quedara activo. Verifica el perfil antes de reintentar.',
  );
}

/**
 * El error de una tarea cuyo perfil no tiene sesión de Facebook. Dice
 * "no logeado" y no "cerró la sesión" para que no se lea como que se cerró
 * la cuenta.
 */
const USUARIO_NO_LOGEADO = "Usuario no logeado";

/**
 * La sesión de Facebook se cayó y no se pudo recuperar.
 *
 * Tiene clase propia porque el paso que la detecta es opcional, y un error de
 * paso opcional se traga: esta tiene que cortar la tarea igual. El mensaje no
 * empieza con "Facebook detuvo este perfil" a propósito, para que la pantalla
 * de campañas no ofrezca eliminar el perfil — esto se arregla volviendo a
 * iniciar sesión, no tirando la cuenta.
 */
class SesionCaidaError extends Error {}

const FACEBOOK_LOGIN_SUBMIT_SELECTOR = 'button[name="login"]';

/**
 * Si el perfil tiene sesión de Facebook, mirando la cookie `c_user`.
 *
 * La cookie no depende del idioma, a diferencia de cualquier texto de la
 * página: un perfil deslogueado con proxy en otro país ve Facebook en árabe, y
 * así el detector por texto ("iniciar sesion en facebook") no lo veía y la
 * tarea moría con un timeout de la caja de comentario. Si no se pueden leer
 * las cookies se da por logueado, para no frenar tareas por un fallo nuestro.
 */
async function hasFacebookSession(page: Page) {
  try {
    const cookies = await page.context().cookies("https://www.facebook.com");
    return cookies.some((c) => c.name === "c_user" && c.value);
  } catch {
    return true;
  }
}

/**
 * El paso `button[name="login"]` de `loginIfNeededSteps`, hecho bien.
 *
 * Antes clickeaba el botón del formulario clásico, que Facebook ya casi no
 * muestra: el paso "no aplicaba" y la tarea seguía como si hubiera sesión,
 * hasta morir con un timeout que no decía nada de la sesión.
 *
 * Ahora: si hay sesión (cookie `c_user`), nada. Si no, corta la tarea con un
 * mensaje que dice lo que pasa.
 */
async function ensureFacebookSession(page: Page) {
  if (await hasFacebookSession(page)) return;
  // No se intenta volver a entrar: sin sesión Facebook pide 2FA, y mandar el
  // formulario desde la IP del proxy solo suma intentos de login sospechosos
  // a la cuenta. Se corta la tarea; los demás bloqueos (checkpoint, cuenta
  // bloqueada) se informan con su propio mensaje.
  await assertNoKnownBlocker(page);
  throw new SesionCaidaError(USUARIO_NO_LOGEADO);
}

async function runStep(page: Page, step: Step, ctx: StepContext) {
  switch (step.action) {
    case "goto":
      if (!step.url) throw new Error("Step 'goto' requiere 'url'");
      await gotoPage(page, step.url, step.ms ?? DEFAULT_GOTO_TIMEOUT_MS, ctx);
      return;
    case "click":
      if (!step.selector) throw new Error("Step 'click' requiere 'selector'");
      if (esLikeDeInstagram(page, step.selector, ctx)) {
        await likeInstagramPost(page, ctx, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
        return;
      }
      if (ctx.taskType === "like" && isFacebookLikeSelector(step.selector)) {
        await likeFacebookPost(page, ctx, step.ms ?? DEFAULT_CLICK_TIMEOUT_MS);
        return;
      }
      if (step.selector === FACEBOOK_LOGIN_SUBMIT_SELECTOR && page.url().includes("facebook.com")) {
        await ensureFacebookSession(page);
        return;
      }
      {
        const timeoutMs = step.ms ?? DEFAULT_CLICK_TIMEOUT_MS;
        const selector =
          (await prepareSelectorTarget(page, step.selector, ctx)) ?? selectorForStep(step.selector, ctx);
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
            (await hasVisibleLocator(page, yaReaccionadaSelector()))
          ) {
            await log(ctx.taskId, "info", "La publicación ya tenía la reacción puesta; nada que hacer.");
            return;
          }

          // "0 visible(s)" no es un botón tapado: es que no hay nada que
          // clickear (el paso opcional de login, por ejemplo). Tratarlo como
          // tapado disparaba el respaldo del like sobre un selector que no era.
          const pointerBlocked =
            /ninguno recibe el puntero|intercepts pointer events/i.test(message) && !/\b0 visible\(s\)/.test(message);

          // La caja de comentario visible pero cubierta. Alcanza con enfocarla:
          // el paso `type` que viene después escribe con el teclado, que no
          // necesita el puntero, y su propio click ya va con catch. Se enfoca
          // en vez de mandar Enter como en el like — acá Enter enviaría un
          // comentario vacío.
          //
          // Antes de rendirse se reintenta destapar: al abrir el panel de
          // comentarios Facebook a veces encima una capa nueva, distinta de la
          // que se cerró para llegar hasta acá.
          if (esTareaDeComentario(ctx.taskType) && pointerBlocked && isFacebookCommentBoxSelector(step.selector)) {
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

          if (ctx.taskType !== "like") throw err;
          if (!pointerBlocked) throw await explicarFalloDeLike(page, message);

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
    case "replyComment": {
      const commentId = step.commentId?.trim();
      const texto = step.value?.trim();
      if (!commentId) throw new Error("Step 'replyComment' requiere 'commentId'");
      if (!texto) throw new Error("Step 'replyComment' requiere 'value' con el texto de la respuesta");

      const timeoutMs = step.ms ?? DEFAULT_ACTION_TIMEOUT_MS;
      const probe = await resolveFacebookCommentReply(page, commentId, timeoutMs, ctx);
      if (probe.status !== "ready") {
        throw new Error(commentProbeError(probe, commentId).replace('"Me gusta"', '"Responder"'));
      }

      const marcado = `[${FACEBOOK_COMMENT_REPLY_MARK}]`;
      const boton = await firstClickableLocator(page, marcado, DEFAULT_CLICK_TIMEOUT_MS);
      await boton.locator.click({ position: boton.position, timeout: DEFAULT_CLICK_TIMEOUT_MS });
      await page.waitForTimeout(1200);

      // Facebook suele dejar el cursor dentro de la caja de respuesta apenas se
      // abre. Se prefiere igual el selector —es más explícito y deja el error
      // claro si algo cambió— y solo se cae al teclado cuando no aparece, que
      // pasa cuando la caja está tapada por alguna capa.
      const caja = await firstVisibleLocator(page, FACEBOOK_REPLY_BOX_SELECTOR, 12000).catch(() => null);
      if (caja) {
        await escribirEnCaja(page, caja, texto, ctx);
        await page.waitForTimeout(500);
        await caja.press("Enter", { timeout: timeoutMs });
      } else {
        const enfocada = await page
          .evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return Boolean(el && (el.isContentEditable || el.getAttribute("role") === "textbox"));
          })
          .catch(() => false);

        if (!enfocada) {
          throw new Error(
            `Se abrió "Responder" en el comentario ${commentId} pero no apareció la caja de respuesta. ` +
              `Botones visibles: ${await describeVisibleButtons(page)}`,
          );
        }

        await log(ctx.taskId, "warn", "La caja de respuesta no matcheó ningún selector; se escribe sobre el foco actual.");
        await page.keyboard.insertText(texto);
        await page.waitForTimeout(800);
        await page.keyboard.press("Enter");
      }

      await page.waitForTimeout(1500);

      // Misma verificación que para un comentario suelto: sin esto la respuesta
      // se daría por puesta apenas se termina de teclear.
      const publicada = await waitForPublishedComment(page, texto, timeoutMs);
      if (!publicada.encontrado) {
        throw new Error(
          "La respuesta no apareció en el hilo después de enviarla. Puede que Facebook la haya descartado, " +
            "que el perfil esté limitado, o que el comentario ya no acepte respuestas.",
        );
      }

      ctx.onResult?.({ url: publicada.url, perfilUrl: publicada.perfilUrl });
      await log(
        ctx.taskId,
        "info",
        publicada.url
          ? `Respuesta publicada y verificada: ${publicada.url}`
          : "Respuesta publicada y verificada (Facebook no le dio enlace propio).",
      );
      return;
    }
    case "captureComment": {
      const texto = step.value?.trim();
      if (!texto) throw new Error("Step 'captureComment' requiere 'value' con el texto publicado");

      const esperaMs = step.ms ?? DEFAULT_ACTION_TIMEOUT_MS;
      const enInstagram = platformFromUrl(page.url()) === "instagram";
      const red = enInstagram ? "Instagram" : "Facebook";
      const opcionesIg = enInstagram ? { alNoEncontrar: () => scrollInstagramComments(page), sinEnlace: true } : {};

      // Primero, lo que contestó el servidor al envío: es inmediato y no
      // depende de que el comentario se vea. La pantalla queda de respaldo
      // para cuando no se detectó ningún envío en la red.
      const envio = ctx.envioComentario;
      ctx.envioComentario = undefined;
      const confirmacion = envio ? await envio.esperar(15000) : null;
      envio?.cancelar();

      if (confirmacion?.ok) {
        // En Facebook el permalink hace falta (las ramificaciones responden
        // sobre él) y el perfil del autor solo se lee en pantalla: se los
        // busca un rato, pero la tarea ya está cumplida los encuentre o no.
        let url = confirmacion.url;
        let perfilUrl = confirmacion.perfilUrl;
        if (!enInstagram) {
          const enPantalla = await waitForPublishedComment(page, texto, Math.min(esperaMs, 8000));
          url = url ?? enPantalla.url;
          perfilUrl = perfilUrl ?? enPantalla.perfilUrl;
        }

        if (ctx.targetUrl && url && rutaDePublicacion(url) !== rutaDePublicacion(ctx.targetUrl)) {
          throw new Error(
            `El comentario se publicó en otra publicación (${url}) en vez de la pedida. El visor se movió ` +
              `durante la tarea. Hay que borrarlo a mano.`,
          );
        }

        ctx.onResult?.({ url, perfilUrl });
        await log(
          ctx.taskId,
          "info",
          `Comentario publicado: ${red} confirmó la creación` +
            (url ? ` (${url}).` : confirmacion.id ? ` (id ${confirmacion.id}).` : "."),
        );
        return;
      }

      if (confirmacion && !confirmacion.ok) {
        await log(ctx.taskId, "warn", `${red} respondió con un rechazo al envío: ${confirmacion.error}. Se revisa en pantalla.`);
      } else {
        await log(
          ctx.taskId,
          "info",
          envio
            ? `No se reconoció el envío en la red; se verifica el comentario en pantalla. POST vistos: ${envio.vistos.join(", ") || "(ninguno)"}`
            : "No se escuchó el envío en la red; se verifica el comentario en pantalla.",
        );
      }

      let probe = await waitForPublishedComment(page, texto, esperaMs, opcionesIg);

      // Último intento antes de declararlo perdido: recargar y volver a abrir
      // el panel. Un falso "no apareció" es caro —el operador relanza y el
      // comentario queda duplicado—, así que se busca a fondo.
      if (!probe.encontrado && enInstagram && ctx.targetUrl) {
        await log(ctx.taskId, "info", "El comentario no se ve en el panel; se recarga la publicación para buscarlo.");
        await gotoPage(page, ctx.targetUrl, DEFAULT_GOTO_TIMEOUT_MS, ctx);
        await page.waitForTimeout(2500);
        await prepareInstagramCommentBox(page, ctx).catch(() => null);
        await page.waitForTimeout(1500);
        probe = await waitForPublishedComment(page, texto, esperaMs, opcionesIg);
      }

      if (!probe.encontrado && confirmacion && !confirmacion.ok) {
        throw new Error(`${red} rechazó el comentario: ${confirmacion.error}`);
      }

      if (!probe.encontrado) {
        throw new Error(
          `El comentario no apareció en la publicación después de enviarlo. Puede que ${red} lo haya ` +
            "descartado, que el perfil esté limitado, o que la publicación no permita comentar." +
            (enInstagram ? " Antes de relanzar, revisá la publicación: si sí salió, relanzar lo duplica." : ""),
        );
      }

      // Encontrar el comentario no alcanza: hay que confirmar que quedó en la
      // publicación pedida. Sin esto, un comentario publicado en el reel al que
      // el visor derivó daba la tarea por EXITOSA — el error más caro posible,
      // porque no deja rastro de que algo salió mal.
      if (ctx.targetUrl && probe.url && rutaDePublicacion(probe.url) !== rutaDePublicacion(ctx.targetUrl)) {
        throw new Error(
          `El comentario se publicó en otra publicación (${probe.url}) en vez de la pedida. El visor se movió ` +
            `durante la tarea. Hay que borrarlo a mano.`,
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
          : "Comentario publicado y verificado (la red no le dio enlace propio).",
      );
      return;
    }
    case "joinGroup": {
      // `value` es el contexto que escribió el operador para responder el
      // formulario de ingreso (de dónde es la gente, por qué le interesa).
      // El nombre se guarda aunque después falle el ingreso: es lo que
      // identifica al grupo en /tasks/unirse-grupo.
      const nombre = await leerNombreGrupo(page);
      if (nombre) ctx.onGroupName?.(nombre);
      const estado = await unirseAlGrupo(page, {
        persona: ctx.persona ?? { name: ctx.profileName },
        contexto: step.value ?? "",
        log: (level, message) => log(ctx.taskId, level, message),
        assertNoBlocker: () => assertNoKnownBlocker(page),
      });
      ctx.onJoinState?.(estado);
      return;
    }
    case "readGroupName": {
      // Las tareas de unirse anteriores a groupName no lo tienen. Este step lo
      // lee con el perfil parado en el grupo y se lo pone a todas las tareas
      // de ese grupo, que es de donde sale el nombre en /tasks/unirse-grupo.
      if (!step.url) throw new Error("Step 'readGroupName' requiere 'url'");
      const nombre = await leerNombreGrupo(page);
      if (!nombre) {
        await log(ctx.taskId, "warn", `No se pudo leer el nombre de ${step.url}`);
        return;
      }
      await TaskModel.updateMany({ type: "joingroup", "steps.url": step.url }, { $set: { groupName: nombre } });
      await log(ctx.taskId, "info", `${step.url} → ${nombre}`);
      return;
    }
    case "followProfile":
      await followFacebookProfile(page, ctx);
      return;
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
        const selector =
          (await prepareSelectorTarget(page, step.selector, ctx)) ?? selectorForStep(step.selector, ctx);
        const target = await firstClickableLocator(page, selector, timeoutMs);
        await target.locator.hover({ position: target.position, timeout: timeoutMs });
      }
      return;
    case "fill":
      if (!step.selector) throw new Error("Step 'fill' requiere 'selector'");
      {
        const selector =
          (await prepareSelectorTarget(page, step.selector, ctx)) ?? selectorForStep(step.selector, ctx);
        const target = await firstVisibleLocator(page, selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
        await target.fill(step.value ?? "", { timeout: step.ms ?? DEFAULT_ACTION_TIMEOUT_MS });
      }
      return;
    case "type":
      if (!step.selector) throw new Error("Step 'type' requiere 'selector'");
      {
        const selector =
          (await prepareSelectorTarget(page, step.selector, ctx)) ?? selectorForStep(step.selector, ctx);
        const target = await firstVisibleLocator(page, selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);

        // Solo la caja de comentario pasa por la escritura verificada: es la
        // que se re-renderiza mientras uno tipea. En un formulario común
        // conviene seguir mandando teclas de verdad, que es lo que esperan sus
        // validaciones al vuelo.
        if (
          esTareaDeComentario(ctx.taskType) &&
          (isFacebookCommentBoxSelector(step.selector) || isInstagramCommentBoxSelector(step.selector))
        ) {
          await escribirEnCaja(page, target, step.value ?? "", ctx);
          ctx.envioComentario?.cancelar();
          ctx.envioComentario = vigilarEnvioComentario(page, step.value ?? "");
        } else {
          await target.click({ timeout: 5000 }).catch(() => {});
          await target.type(step.value ?? "", { delay: 60, timeout: step.ms ?? DEFAULT_ACTION_TIMEOUT_MS });
        }
      }
      return;
    case "press":
      if (!step.key) throw new Error("Step 'press' requiere 'key'");
      // Enviar es el punto de no retorno: si el visor derivó mientras se
      // escribía, el texto está en la caja de otra publicación y presionar
      // Enter lo publica ahí.
      if (esTareaDeComentario(ctx.taskType)) await assertOnTargetUrl(page, ctx);
      if (step.selector) {
        const selector =
          (await prepareSelectorTarget(page, step.selector, ctx)) ?? selectorForStep(step.selector, ctx);
        const target = await firstVisibleLocator(page, selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
        await target.press(step.key, { timeout: step.ms ?? DEFAULT_ACTION_TIMEOUT_MS });
      } else {
        await page.keyboard.press(step.key);
      }
      return;
    case "waitForSelector":
      if (!step.selector) throw new Error("Step 'waitForSelector' requiere 'selector'");
      if (esLikeDeInstagram(page, step.selector, ctx)) {
        await waitForInstagramPostLike(page, ctx, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
        return;
      }
      {
        const selector =
          (await prepareSelectorTarget(page, step.selector, ctx)) ?? selectorForStep(step.selector, ctx);
        try {
          await firstVisibleLocator(page, selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
        } catch (err) {
          if (ctx.taskType !== "like" || !isFacebookLikeSelector(step.selector)) throw err;

          // Una publicación que ya tiene la reacción no muestra el botón de
          // ponerla, así que este paso no puede pasar nunca: lo que hay es el
          // de quitarla. Es la tarea cumplida, no un fallo — se deja seguir y
          // el "click" que viene después lo reconoce igual y sale por éxito.
          if (await hasVisibleLocator(page, POST_LIKED_SELECTOR)) {
            await log(ctx.taskId, "info", "La publicación ya tenía la reacción puesta; nada que esperar.");
            return;
          }

          throw await explicarFalloDeLike(page, err instanceof Error ? err.message : String(err));
        }
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
/**
 * Rellena en los steps del hijo el comentario que publicó su padre.
 *
 * Devuelve `null` si quedó todo resuelto, o el motivo por el que la rama no se
 * puede colgar. Ese motivo cancela la tarea en vez de dejarla fallar: no es que
 * la automatización se haya roto, es que no hay comentario al que responder.
 *
 * El caso más común de cancelación no es que el padre falle sino que Facebook
 * no le dé enlace propio a su comentario — pasa seguido en los reels. Sin
 * `comment_id` no hay a qué apuntar, y adivinar sería responderle al comentario
 * de otro.
 */
async function resolverPasosDelHijo(task: InstanceType<typeof TaskModel>): Promise<string | null> {
  const padre = await TaskModel.findById(task.parentTaskId);
  if (!padre) return "La tarea del comentario padre ya no existe.";
  if (padre.status !== "success") {
    return `El comentario padre no se publicó (quedó en "${padre.status}"), así que no hay a qué responder.`;
  }
  if (!padre.resultUrl) {
    return (
      "El comentario padre se publicó pero Facebook no le dio un enlace propio, así que no se puede " +
      "identificar para responderle. Suele pasar en reels."
    );
  }

  const target = parseFacebookCommentTarget(padre.resultUrl);
  if (!target) return `El enlace del comentario padre no trae comment_id (${padre.resultUrl}).`;

  for (const step of task.steps as Step[]) {
    if (!step.fromParent) continue;
    if (step.action === "goto") step.url = padre.resultUrl;
    else step.commentId = target.commentId;
  }
  task.markModified("steps");

  return null;
}

/**
 * Abre o cierra las ramas que dependen de esta tarea.
 *
 * Los hijos nacen en "pending" justamente para que nadie los tome antes de
 * tiempo: la cola solo mira "queued". Al terminar el padre pasan a la cola, o
 * se cancelan con el motivo si no hay comentario al que colgarse.
 */
async function resolverRamasDe(task: InstanceType<typeof TaskModel>) {
  const pendientes = await TaskModel.find({ parentTaskId: task._id, status: "pending" }).sort({ scheduledAt: 1 });
  const hijos = pendientes.length;
  if (!hijos) return;

  if (task.status === "success" && task.resultUrl) {
    // Se reprograman desde ahora conservando la separación original entre
    // ramas. Sus horarios se fijaron al crear la campaña, contando que el
    // padre tardaría poco; si tardó más que eso —y publicar un comentario
    // puede llevar minutos— ya habrían vencido todos y las ramas saldrían una
    // atrás de otra, que es justo lo que el escalonado viene a evitar.
    const base = pendientes[0].scheduledAt?.getTime() ?? Date.now();
    const ahora = Date.now();
    for (const hijo of pendientes) {
      hijo.status = "queued";
      hijo.scheduledAt = new Date(ahora + ((hijo.scheduledAt?.getTime() ?? base) - base));
      await hijo.save();
    }
    await log(String(task._id), "info", `Comentario padre listo: ${hijos} rama(s) hija(s) pasan a la cola.`);
    return;
  }

  const motivo =
    task.status === "success"
      ? "El comentario padre se publicó pero sin enlace propio, así que no se le pueden colgar ramas."
      : `El comentario padre terminó en "${task.status}".`;

  await TaskModel.updateMany(
    { parentTaskId: task._id, status: "pending" },
    { $set: { status: "cancelled", error: motivo, finishedAt: new Date() } },
  );
  await log(String(task._id), "warn", `${hijos} rama(s) hija(s) cancelada(s): ${motivo}`);
}

/**
 * El perfil a seguir no admite seguidores: se cancelan las tareas de la
 * campaña que todavía no corrieron contra ese mismo perfil —todas fallarían
 * igual, y cada una gasta un navegador y una visita— y se deja el motivo en la
 * campaña para que el operador lo vea en /campanas.
 */
async function detenerSeguimientoImposible(task: InstanceType<typeof TaskModel>, profileName: string) {
  const url = (task.steps as Step[]).find((s) => s.action === "goto" && s.url)?.url;
  if (!task.campaignId || !url) return;

  const motivo = `Campaña detenida: ${url} no permite que lo sigan (solo acepta solicitudes de amistad). Lo detectó la tarea de ${profileName}.`;
  const result = await TaskModel.updateMany(
    {
      campaignId: task.campaignId,
      _id: { $ne: task._id },
      type: "follow",
      "steps.url": url,
      status: { $in: ["pending", "queued", "paused"] },
    },
    { $set: { status: "cancelled", error: motivo, finishedAt: new Date() }, $unset: { resumeStatus: "" } },
  );
  await CampaignModel.updateOne({ _id: task.campaignId }, { $set: { stopReason: motivo } });
  await log(String(task._id), "warn", `${motivo} Se cancelaron ${result.modifiedCount} tarea(s) que faltaban.`);
}

export async function runTask(taskId: string) {
  await dbConnect();
  const task = await TaskModel.findById(taskId);
  if (!task) throw new Error(`Task ${taskId} no encontrada`);

  const profile = await ProfileModel.findById(task.profileId);
  if (!profile) throw new Error(`Profile ${task.profileId} no encontrado`);

  // Ramificaciones: los steps de un hijo apuntan al comentario que publicó su
  // padre, que al crear la campaña todavía no existía. Se resuelve acá, contra
  // el permalink que el padre guardó al verificarse.
  if (task.parentTaskId) {
    const motivo = await resolverPasosDelHijo(task);
    if (motivo) {
      task.status = "cancelled";
      task.error = motivo;
      task.finishedAt = new Date();
      await task.save();
      await log(taskId, "error", motivo);
      return task;
    }
  }

  task.status = "running";
  task.startedAt = new Date();
  await task.save();
  await log(taskId, "info", `Iniciando tarea "${task.name}" en perfil ${profile.name}`);

  // La publicación de la tarea: a dónde volver si el navegador se va a otra
  // mientras la tarea trabaja. Arranca siendo la que pidió la campaña y se
  // reemplaza por la que quedó de verdad apenas se navega — ver el bucle de
  // steps.
  let targetUrl = (task.steps as Step[]).find((s) => s.action === "goto" && s.url)?.url;

  let browser;
  let page: Page | undefined;
  try {
    const connection = await connectToProfile(profile.adsPowerProfileId);
    browser = connection.browser;
    page = connection.page;

    // El contexto se arma de nuevo en cada paso (targetUrl puede cambiar tras
    // navegar), pero la escucha del envío nace en "type" y se lee en
    // "captureComment": tiene que pasar de un paso al otro.
    let envioComentario: EnvioComentario | undefined;

    for (const [i, step] of task.steps.entries()) {
      const s = step as Step;
      await log(taskId, "info", `Step ${i + 1}/${task.steps.length}: ${s.action}${s.optional ? " (opcional)" : ""}`);
      const ctx: StepContext = {
        envioComentario,
        taskId,
        profileName: profile.name,
        taskType: task.type,
        targetUrl,
        persona: { name: profile.name, age: profile.age, gender: profile.gender },
        onResult: ({ url, perfilUrl }) => {
          if (url) task.resultUrl = url;
          if (perfilUrl) task.resultProfileUrl = perfilUrl;
        },
        onJoinState: (state) => {
          task.joinState = state;
        },
        onGroupName: (name) => {
          task.groupName = name;
        },
      };
      try {
        try {
          await runStep(page, s, ctx);
        } finally {
          envioComentario = ctx.envioComentario;
        }

        // Después de navegar manda la URL que quedó, no la que se pidió.
        // Facebook reescribe los enlaces —los de "compartir" a la forma
        // canónica del post, y le agrega un `?rdid=` al redirigir—, y comparar
        // contra la pedida daba por deriva lo que era la misma publicación de
        // siempre: la tarea se abortaba con el comentario ya escrito.
        if (s.action === "goto") targetUrl = page.url();
      } catch (err) {
        if (!s.optional || err instanceof SesionCaidaError) throw err;
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
    if (err instanceof FollowNotAllowedError) {
      await detenerSeguimientoImposible(task, profile.name).catch((stopErr) =>
        log(
          taskId,
          "warn",
          `No se pudo detener la campaña: ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`,
        ),
      );
    }
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
    // El navegador se cierra ANTES de escribir el estado final, y el orden
    // importa desde que hay más de un motor: mientras la tarea siga en
    // "running", ningún otro puede tomar este perfil (ver worker/index.ts). Al
    // marcarla terminada primero quedaba una ventana de un par de segundos en
    // la que otro motor arrancaba el navegador del mismo perfil mientras este
    // todavía lo estaba cerrando y borrando su caché.
    if (browser) await disconnectProfile(browser, profile.adsPowerProfileId);

    task.finishedAt = new Date();
    await task.save();
    // Después de guardar el estado definitivo: las ramas se abren o se cierran
    // según cómo haya terminado el padre.
    await resolverRamasDe(task).catch((err) =>
      log(taskId, "warn", `No se pudieron resolver las ramas hijas: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  return task;
}
