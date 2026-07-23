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
    | "uploadFile";
  selector?: string;
  value?: string;
  url?: string;
  key?: string;
  ms?: number;
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

const FACEBOOK_COMMENT_OPEN_SELECTOR = [
  '[role="button"][aria-label="Comment"]',
  '[role="button"][aria-label="Comentar"]',
  '[aria-label="Comment"]',
  '[aria-label="Comentar"]',
  'div[role="button"]:has(svg[aria-label="Comment"])',
  'div[role="button"]:has(svg[aria-label="Comentar"])',
  'svg[aria-label="Comment"]',
  'svg[aria-label="Comentar"]',
].join(", ");

const FACEBOOK_LIKE_SELECTOR = [
  'div[role="dialog"] [aria-label="Like"]',
  '[role="button"][aria-label="Like"]',
  '[aria-label="Like"]',
  'div[role="dialog"] [aria-label="Me gusta"]',
  '[role="button"][aria-label="Me gusta"]',
  '[aria-label="Me gusta"]',
  'div[role="dialog"] [aria-label="React"]',
  '[role="button"][aria-label="React"]',
  '[aria-label="React"]',
  'div[role="dialog"] [aria-label="Reaccionar"]',
  '[role="button"][aria-label="Reaccionar"]',
  '[aria-label="Reaccionar"]',
  'div[role="dialog"] [aria-label="Reacciona"]',
  '[role="button"][aria-label="Reacciona"]',
  '[aria-label="Reacciona"]',
  'div[role="button"]:has(svg[aria-label="Like"])',
  'div[role="button"]:has(svg[aria-label="Me gusta"])',
  'div[role="button"]:has(svg[aria-label="React"])',
  'div[role="button"]:has(svg[aria-label="Reaccionar"])',
  'div[role="button"]:has(svg[aria-label="Reacciona"])',
  'svg[aria-label="Like"]',
  'svg[aria-label="Me gusta"]',
  'svg[aria-label="React"]',
  'svg[aria-label="Reaccionar"]',
  'svg[aria-label="Reacciona"]',
].join(", ");

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

type StepContext = { taskId: string; profileName: string; taskType: string };

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
  return /aria-label="(Like|Me gusta|React|Reaccionar|Reacciona)"/i.test(selector);
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

async function prepareSelectorTarget(page: Page, rawSelector: string, ctx: StepContext) {
  if (ctx.taskType !== "comment" || !isFacebookCommentBoxSelector(rawSelector)) return;
  if (await hasVisibleLocator(page, FACEBOOK_COMMENT_BOX_SELECTOR)) return;

  let target: ClickableTarget | null = null;
  try {
    target = await firstClickableLocator(page, FACEBOOK_COMMENT_OPEN_SELECTOR, 2500);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("Facebook detuvo este perfil")) throw err;
  }
  if (!target) return;

  await log(ctx.taskId, "info", "Abriendo panel/caja de comentarios de Facebook.");
  await target.locator.click({ position: target.position, timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(1000);
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
          const pointerBlocked = /ninguno recibe el puntero|intercepts pointer events/i.test(message);
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
    case "hover":
      // Dispara el picker de reacciones de Facebook (aparece al mantener el
      // cursor sobre el botón de "Me gusta" en vez de clickearlo directo).
      if (!step.selector) throw new Error("Step 'hover' requiere 'selector'");
      {
        const selector = selectorForStep(step.selector, ctx);
        await prepareSelectorTarget(page, step.selector, ctx);
        await (await firstVisibleLocator(page, selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS)).hover({
          timeout: step.ms ?? DEFAULT_ACTION_TIMEOUT_MS,
        });
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
        await runStep(page, s, { taskId, profileName: profile.name, taskType: task.type });
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
