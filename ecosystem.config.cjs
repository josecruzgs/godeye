/**
 * Procesos de producción para PM2.
 *
 * Son dos y no uno porque el worker no puede vivir dentro de Next: es un
 * proceso de larga duración que hace polling a Mongo, y el servidor web solo
 * existe mientras atiende peticiones.
 *
 * Los tres corren en el VPS: `pm2 start ecosystem.config.cjs`, sin `--only`.
 *
 * `godeye-tasks` vivía aparte en la Windows mientras AdsPower era una app de
 * escritorio que solo escuchaba en el localhost de esa máquina. Desde que
 * AdsPower está instalado en el propio VPS contra una pantalla virtual (sección
 * 6 de DEPLOY.md), la PC dejó de formar parte del sistema. Levantarlo en los dos
 * lados a la vez sí sería un problema: dos workers tomando las mismas tareas.
 *
 * Los tres van en `exec_mode: "fork"` y sin `instances`. Declarar `instances`
 * —aunque sea 1— hace que PM2 pase a modo cluster, que arranca el script con el
 * módulo `cluster` de Node y no sabe ejecutar el CLI de tsx: el worker moría al
 * instante, sin alcanzar a escribir una línea en su log, y PM2 lo reintentaba
 * en bucle. Acá no hay nada que clusterizar: la caché de Next vive en disco
 * local y el latido del worker asume un proceso por rol.
 */
const forkOnce = { exec_mode: "fork", autorestart: true };

module.exports = {
  apps: [
    {
      ...forkOnce,
      name: "godeye-web",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      // 3001 y no 3000: el 3000 es el default de todo proyecto de Node y en un
      // servidor compartido con otras apps ya suele estar tomado. Nginx es
      // quien atiende el 443, así que el puerto interno da igual mientras no
      // choque.
      env: { NODE_ENV: "production", PORT: 3001 },
      max_memory_restart: "700M",
    },
    {
      ...forkOnce,
      // Solo ingesta y análisis. Sin AdsPower a la vista, tomar tareas de
      // automatización las haría fallar una por una.
      name: "godeye-listening",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/worker/index.ts",
      env: { NODE_ENV: "production", WORKER_TASKS: "0", WORKER_LISTENING: "1" },
      max_memory_restart: "700M",
      // Un scrape de Bright Data puede tardar minutos; matarlo a la mitad
      // deja el snapshot pago sin recoger.
      kill_timeout: 30_000,
    },
    {
      ...forkOnce,
      name: "godeye-tasks",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/worker/index.ts",
      // `WORKER_ENGINES` es cuántas tareas corre a la vez (los "motores" que
      // dibuja /campanas). Dos para empezar: cada motor abre su propio
      // navegador en AdsPower sobre la pantalla virtual, y eso es RAM y disco.
      // Se sube acá y en el próximo `pm2 restart godeye-tasks`; el tope que la
      // sala sabe dibujar son 5 (src/lib/motores.ts).
      env: { NODE_ENV: "production", WORKER_TASKS: "1", WORKER_LISTENING: "0", WORKER_ENGINES: "2" },
      kill_timeout: 30_000,
    },
  ],
};
