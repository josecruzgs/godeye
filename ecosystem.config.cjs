/**
 * Procesos de producción para PM2.
 *
 * Son dos y no uno porque el worker no puede vivir dentro de Next: es un
 * proceso de larga duración que hace polling a Mongo, y el servidor web solo
 * existe mientras atiende peticiones.
 *
 * En el VPS se levantan `godeye-web` y `godeye-listening`. La automatización
 * (`godeye-tasks`) NO se levanta ahí: necesita AdsPower de escritorio corriendo
 * en la misma máquina, así que va en la Windows, con este mismo archivo:
 *
 *   VPS      → pm2 start ecosystem.config.cjs --only godeye-web,godeye-listening
 *   Windows  → pm2 start ecosystem.config.cjs --only godeye-tasks
 */
module.exports = {
  apps: [
    {
      name: "godeye-web",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      // 3001 y no 3000: el 3000 es el default de todo proyecto de Node y en un
      // servidor compartido con otras apps ya suele estar tomado. Nginx es
      // quien atiende el 443, así que el puerto interno da igual mientras no
      // choque.
      env: { NODE_ENV: "production", PORT: 3001 },
      // Un solo proceso: la caché de Next vive en disco local y el heartbeat
      // del worker no está pensado para varias instancias.
      instances: 1,
      max_memory_restart: "700M",
      autorestart: true,
    },
    {
      // Solo ingesta y análisis. Sin AdsPower a la vista, tomar tareas de
      // automatización las haría fallar una por una.
      name: "godeye-listening",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/worker/index.ts",
      env: { NODE_ENV: "production", WORKER_TASKS: "0", WORKER_LISTENING: "1" },
      instances: 1,
      max_memory_restart: "700M",
      autorestart: true,
      // Un scrape de Bright Data puede tardar minutos; matarlo a la mitad
      // deja el snapshot pago sin recoger.
      kill_timeout: 30_000,
    },
    {
      name: "godeye-tasks",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/worker/index.ts",
      env: { NODE_ENV: "production", WORKER_TASKS: "1", WORKER_LISTENING: "0" },
      instances: 1,
      autorestart: true,
      kill_timeout: 30_000,
    },
  ],
};
