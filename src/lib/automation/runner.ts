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
const VISIBLE_POLL_MS = 250;

type ClickableTarget = {
  locator: Locator;
  position: { x: number; y: number };
};

type StepContext = { taskId: string; profileName: string; taskType: string };

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

  while (Date.now() <= deadline) {
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

  throw new Error(
    `Timeout ${timeoutMs}ms esperando elemento visible para selector "${selector}" (${lastCount} match(es), ninguno visible)`,
  );
}

async function firstClickableLocator(page: Page, selector: string, timeoutMs: number): Promise<ClickableTarget> {
  const locator = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;
  let visibleCount = 0;

  while (Date.now() <= deadline) {
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

  throw new Error(
    `Timeout ${timeoutMs}ms esperando elemento clickeable para selector "${selector}" (${lastCount} match(es), ${visibleCount} visible(s), ninguno recibe el puntero)`,
  );
}

async function runStep(page: Page, step: Step, ctx: StepContext) {
  switch (step.action) {
    case "goto":
      if (!step.url) throw new Error("Step 'goto' requiere 'url'");
      await page.goto(step.url, { waitUntil: "domcontentloaded", timeout: step.ms ?? DEFAULT_GOTO_TIMEOUT_MS });
      return;
    case "click":
      if (!step.selector) throw new Error("Step 'click' requiere 'selector'");
      {
        const timeoutMs = step.ms ?? DEFAULT_CLICK_TIMEOUT_MS;
        try {
          const target = await firstClickableLocator(page, step.selector, timeoutMs);
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
          const fallback = await firstVisibleLocator(page, step.selector, Math.min(3000, timeoutMs));
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
      await (await firstVisibleLocator(page, step.selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS)).hover({
        timeout: step.ms ?? DEFAULT_ACTION_TIMEOUT_MS,
      });
      return;
    case "fill":
      if (!step.selector) throw new Error("Step 'fill' requiere 'selector'");
      await page.fill(step.selector, step.value ?? "");
      return;
    case "type":
      if (!step.selector) throw new Error("Step 'type' requiere 'selector'");
      await page.type(step.selector, step.value ?? "", { delay: 60 });
      return;
    case "press":
      if (!step.key) throw new Error("Step 'press' requiere 'key'");
      if (step.selector) await page.press(step.selector, step.key);
      else await page.keyboard.press(step.key);
      return;
    case "waitForSelector":
      if (!step.selector) throw new Error("Step 'waitForSelector' requiere 'selector'");
      await firstVisibleLocator(page, step.selector, step.ms ?? DEFAULT_ACTION_TIMEOUT_MS);
      return;
    case "waitForTimeout":
      await page.waitForTimeout(step.ms ?? 1000);
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
