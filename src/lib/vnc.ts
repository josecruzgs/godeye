/**
 * Pantalla remota de AdsPower (noVNC).
 *
 * AdsPower en el VPS corre contra una pantalla virtual (Xvfb) que nadie ve:
 * cuando una tarea se rompe por algo que solo se nota mirando —una sesión
 * caída, un captcha, un diálogo de la app tapando el navegador— hay que
 * asomarse a esa pantalla. x11vnc la publica y websockify la sirve por
 * navegador; nginx la acerca al mismo dominio del panel, con la sesión de
 * admin como llave (ver deploy/nginx.conf y la sección 6 de DEPLOY.md).
 */

/**
 * Lo que carga el iframe. Relativo por defecto: en producción nginx atiende
 * `/novnc/` y lo manda al websockify del loopback, así que no hace falta abrir
 * ningún puerto ni levantar un túnel.
 *
 * En una máquina de escritorio, con el túnel de DEPLOY.md abierto, se apunta
 * directo al puerto reenviado:
 *
 *     NEXT_PUBLIC_VNC_URL=http://127.0.0.1:6080
 */
export const VNC_BASE_URL = (process.env.NEXT_PUBLIC_VNC_URL || "/novnc").replace(/\/+$/, "");

/**
 * `resize=scale` y no `remote`: Xvfb arranca con una resolución fija y no
 * acepta que el cliente le pida otra, así que escalar del lado del navegador es
 * lo único que evita las barras de scroll.
 *
 * `reconnect`: la pestaña se deja abierta mientras corre una campaña larga y el
 * websocket se cae solo cada tanto; sin esto hay que recargar a mano.
 */
export const VNC_VIEWER_URL =
  `${VNC_BASE_URL}/vnc.html?autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000`;

/** A dónde le pega el servidor para saber si la pantalla está viva. */
export const VNC_PROBE_URL = (process.env.VNC_PROBE_URL || "http://127.0.0.1:6080").replace(/\/+$/, "");
