# Despliegue en un VPS

Guía para dejar Ojo de Dios corriendo 24/7 sin depender de tu máquina.

## Cómo está montado hoy

Todo corre en un único VPS y ninguna PC forma parte del sistema:

| Proceso | Qué hace |
|---|---|
| `godeye-web` | Next en el puerto interno 3001, detrás de Nginx con HTTPS |
| `godeye-listening` | Ingesta de menciones y análisis con Claude, sola, según el intervalo de cada proyecto |
| `godeye-tasks` | Ejecuta las tareas de automatización contra AdsPower |
| `xvfb` + `adspower` | Servicios de systemd: AdsPower de escritorio contra una pantalla virtual |

La pieza que obliga a instalar AdsPower en el servidor es que su API solo
escucha en el localhost de la máquina donde está, y el navegador se ejecuta ahí
mismo. Mientras viviera en una PC, la automatización dependía de esa PC.

Los workers no hablan con la web: toman su trabajo de Mongo. Por eso pueden
correr donde convenga, y de hecho `godeye-tasks` puede quedarse en una PC con
AdsPower si preferís no mover los perfiles de máquina — ver el final de la
sección 6.

--- 

## 1. El VPS

Cualquier proveedor con KVM sirve. Lo que importa:

- **Ubuntu 24.04 LTS**
- **4 GB de RAM** — `next build` es lo más pesado que corre ahí; con 2 GB el
  build muere por falta de memoria
- 2 vCPU y 40 GB de disco sobran
- Región cercana a la de tu cluster de Atlas: cada consulta paga ese viaje

Mongo sigue en Atlas, no se instala nada de base de datos en el VPS.

> **Antes de seguir:** en Atlas → Network Access, agregá la IP del VPS a la lista
> de acceso. Sin eso la app levanta pero no conecta, y el error no dice que sea
> por la IP.

### Si el VPS ya tiene otras cosas corriendo

Es lo normal y no hace falta un servidor dedicado: la app son dos procesos de
Node que en reposo no llegan a 1 GB. Antes de empezar, verificá en el candidato:

```bash
lsb_release -ds; nproc; free -h; df -h /
sudo ss -tlnp | grep -E ':(80|443|3000|3001)\s'
node -v; nginx -v; pm2 list; docker ps --format '{{.Names}}'
ls -d /usr/local/cpanel /usr/local/CyberCP /opt/plesk /home/cloudpanel 2>/dev/null
```

- **~2 GB de RAM disponibles** para el `npm run build`. Si no hay, agregá swap
  (abajo) o compilá en tu máquina y subí el resultado.
- **Puerto 3001 libre** (o cualquier otro): Nginx atiende el 443, el puerto
  interno solo tiene que no chocar. Se cambia en `ecosystem.config.cjs`.
- **Nginx sin panel de control.** Si aparece CyberPanel, Plesk, cPanel o
  CloudPanel, no edites los archivos a mano: esos paneles los reescriben solos.
  El bloque hay que darlo de alta desde el panel.
- **Node 22 y PM2 ya instalados** → saltate el paso 2 entero.

Con otras apps en la misma máquina, saltear el paso de crear el usuario
`godeye` y correr todo con el mismo usuario que ya usa PM2 ahí es lo más
práctico: dos demonios de PM2 con usuarios distintos no se ven entre sí y
`pm2 list` deja de mostrar la mitad de los procesos, que es una fuente de
confusión mucho más cara que la separación que gana.

### Swap, si la RAM está justa

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Base del servidor

```bash
ssh root@177.7.53.246

# adduser es interactivo: pide contraseña y datos. Corrélo solo, o se comerá
# las líneas siguientes como respuestas a sus preguntas.
adduser godeye
usermod -aG sudo godeye

mkdir -p /home/godeye/.ssh
cp ~/.ssh/authorized_keys /home/godeye/.ssh/ 2>/dev/null || true
chown -R godeye:godeye /home/godeye/.ssh && chmod 700 /home/godeye/.ssh

# Por número de puerto y no por perfil: 'Nginx Full' lo crea Nginx al
# instalarse, y todavía no está instalado.
ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw --force enable

# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs nginx git
npm install -g pm2

su - godeye
```

## 3. La app

`su -` abre una shell nueva: lo que venga pegado detrás se pierde en la shell
vieja. Esperá al prompt de `godeye@` antes de seguir.

```bash
git clone https://github.com/josecruzgs/godeye.git godeye && cd godeye
npm ci
npm run build
```

`npm ci` avisa de vulnerabilidades en `postcss` y `sharp`, dependencias internas
de Next. **No corras `npm audit fix --force`**: el arreglo es subir Next a una
versión fuera del rango declarado, y no es algo para hacer a ciegas en un
despliegue. `postcss` solo actúa en el build y `sharp` procesa imágenes propias.

### `.env.local` del VPS

Copialo desde tu máquina en vez de pegarlo en un editor — una línea cortada al
pegar deja el arranque fallando por una razón difícil de ver:

```powershell
scp .env.local godeye@177.7.53.246:~/godeye/.env.local
```

Y ahí cambiá estas cuatro:

```bash
SESSION_SECRET=                      # firma las sesiones — generarla, ver abajo
NEXT_PUBLIC_SHARE_BASE_URL=https://yoconjulieta.iagent.mx
ADSPOWER_API_BASE_URL=http://127.0.0.1:50325   # AdsPower corre acá — sección 6
ADSPOWER_API_KEY=                    # vacío si dejás la verificación apagada
```

`SESSION_SECRET` se genera con
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. No
tiene que ser memorable ni la escribe nadie: firma la cookie de sesión. Cambiarla
cierra todas las sesiones abiertas.

`NEXT_PUBLIC_SHARE_BASE_URL` se inyecta **en el build**, no en el arranque: si la
cambiás después, hay que volver a correr `npm run build` o los links de campañas
seguirán apuntando a donde apuntaban.

### El primer usuario

El panel no tiene contraseña compartida: cada persona entra con su usuario, y los
usuarios viven en Mongo. El primero se crea por línea de comandos, en el VPS,
**una sola vez**:

```bash
npm run users:admin -- --username jose --password "una-larga-y-nueva"
```

Ese comando también adopta todo lo que existía antes de que hubiera usuarios
—campañas, tareas, dashboards, bancos de textos y proyectos de escucha— y lo pone
a nombre de ese admin. Sin correrlo, lo viejo queda sin dueño y no lo ve nadie.
Correrlo dos veces no hace daño: no toca lo que ya tiene dueño ni pisa la
contraseña salvo que agregues `--reset-password`.

De ahí en adelante los usuarios se administran desde **/usuarios**, dentro del
panel: alta, baja, rol y a qué grupos de AdsPower accede cada uno.

## 4. Los procesos

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup          # imprime un comando con sudo — copialo y ejecutalo
```

Los tres procesos van acá, `godeye-tasks` incluido: AdsPower corre en el propio
VPS (sección 6). Sin `--only`, el archivo levanta los tres.

`pm2 startup` **no engancha nada por sí solo**: imprime una línea que empieza con
`sudo env PATH=...` y hay que copiarla y ejecutarla aparte. Ese es el paso que
hace que todo vuelva solo después de un reinicio del VPS. Sin él, un reboot deja
el sistema caído sin avisar, y el síntoma es un **502 Bad Gateway** de nginx con
`pm2 status` mostrando la tabla vacía —no un proceso `errored`, sino ninguno—
porque el daemon de PM2 tampoco sobrevivió. AdsPower sí vuelve solo: son
servicios de systemd. Se recupera con `pm2 resurrect`, o repitiendo el bloque de
arriba si no quedó dump.

```bash
pm2 status
pm2 logs godeye-listening --lines 50
```

## 5. Dominio y HTTPS

Apuntá un registro **A** de tu dominio a la IP del VPS y esperá a que propague.

El archivo ya viene con `yoconjulieta.iagent.mx`; si usás otro dominio, cambialo ahí.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/godeye
sudo ln -s /etc/nginx/sites-available/godeye /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yoconjulieta.iagent.mx
```

Certbot deja la renovación automática configurada.

### Cambiar el dominio más adelante

El dominio vive en tres lugares, ninguno en la máquina de quien despliega: el
`server_name` de Nginx, el certificado de certbot y `NEXT_PUBLIC_SHARE_BASE_URL`
del `.env.local` **del VPS**.

Una vez que certbot pasó por el archivo, **no edites el `server_name` a mano**:
reescribí `/etc/nginx/sites-available/godeye` entero, cambiando también las rutas
de `ssl_certificate`. Si el `server_name` del bloque de 443 no coincide con el
dominio que le pasás a certbot, este no lo encuentra y agrega un `server` propio
en 443 con `return 301 https://$host$request_uri`: el sitio queda redirigiendo a
sí mismo y el navegador muestra `ERR_TOO_MANY_REDIRECTS`.

```bash
nginx -t && systemctl reload nginx
certbot --nginx -d NUEVO.dominio.mx
curl -I https://NUEVO.dominio.mx     # 200 o 307, nunca 301 al mismo host
```

Después, como `godeye`, actualizá `NEXT_PUBLIC_SHARE_BASE_URL` y **rebuildeá** —
se inyecta en el build, no al arrancar. Y borrá el certificado viejo o su
renovación empieza a fallar en silencio: `certbot delete --cert-name VIEJO.dominio.mx`.

## 6. AdsPower en el VPS

AdsPower es una aplicación de escritorio: su API solo escucha en el localhost de
la máquina donde está instalada, y el navegador se ejecuta ahí. Mientras viva en
una PC, la automatización depende de que esa PC esté encendida.

La salida es instalarla en el VPS. No hay pantalla, así que corre contra una
pantalla virtual — configuración que AdsPower no documenta (piden Ubuntu
*Desktop*) pero que funciona.

```bash
# El .deb; la URL sale del botón de descarga de adspower.com/download,
# que arma el enlace por JavaScript — se copia desde el gestor de descargas.
wget https://version.adspower.net/software/linux-x64-global/8.7.23/AdsPower-Global-8.7.23-x64.deb
sudo apt install -y ./AdsPower-Global-8.7.23-x64.deb

# Ubuntu Server no trae las librerías gráficas que toda app de escritorio
# necesita. En 24.04 varias cambiaron de nombre (sufijo t64), así que se
# prueban ambos y se sigue de largo con el que no exista.
for p in libasound2t64 libasound2 libgtk-3-0t64 libgtk-3-0 libnss3 libgbm1 \
         libxss1 libxtst6 libsecret-1-0 libatk-bridge2.0-0t64 libatk-bridge2.0-0 \
         libcups2t64 libcups2 fonts-liberation xdg-utils xvfb x11vnc dbus-x11 \
         novnc websockify; do
  sudo apt-get install -y "$p" >/dev/null 2>&1 && echo "ok  $p" || echo "--  $p"
done

ldd "/opt/AdsPower Global/adspower_global" | grep -i "not found"   # debe salir vacío
```

Los dos servicios. `Requires`/`After` importan: sin la pantalla ya levantada,
AdsPower muere con "Missing X server or $DISPLAY".

```bash
sudo tee /etc/systemd/system/xvfb.service >/dev/null <<'EOF'
[Unit]
Description=Pantalla virtual para AdsPower
After=network.target

[Service]
User=godeye
ExecStart=/usr/bin/Xvfb :99 -screen 0 1440x900x24
Restart=always

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/adspower.service >/dev/null <<'EOF'
[Unit]
Description=AdsPower - API local
Requires=xvfb.service
After=xvfb.service

[Service]
User=godeye
Environment=HOME=/home/godeye
Environment=DISPLAY=:99
ExecStart="/opt/AdsPower Global/adspower_global" --no-sandbox
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now xvfb adspower
```

### Ver la pantalla desde el panel

x11vnc publica la pantalla virtual y websockify la sirve por navegador. Como
servicios y no a mano con `nohup`: la pantalla hace falta justo cuando algo se
rompió, que es cuando nadie se acuerda de haberlos levantado.

Los dos quedan atados al loopback. El único que los alcanza es nginx, que exige
sesión de admin antes de dejar pasar (bloque `/novnc/` de `deploy/nginx.conf`).
Sin ese filtro esto sería un escritorio con todas las cuentas abiertas, servido
a internet.

```bash
sudo tee /etc/systemd/system/x11vnc.service >/dev/null <<'EOF'
[Unit]
Description=VNC de la pantalla virtual
Requires=xvfb.service
After=xvfb.service

[Service]
User=godeye
# -localhost es lo que hace aceptable el -nopw: nadie llega ahí sin pasar por
# nginx, y la llave es la sesión del panel. -forever y -shared: no se cae al
# cerrar el visor, y deja mirar desde dos lados a la vez.
ExecStart=/usr/bin/x11vnc -display :99 -localhost -nopw -forever -shared
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/novnc.service >/dev/null <<'EOF'
[Unit]
Description=noVNC (websockify) para la pantalla virtual
Requires=x11vnc.service
After=x11vnc.service

[Service]
User=godeye
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now x11vnc novnc
sudo systemctl status xvfb x11vnc novnc --no-pager
```

Falta que nginx la publique. **No copies `deploy/nginx.conf` encima del archivo
del sitio**: certbot lo reescribió con el bloque 443 y sobreescribirlo te tumba
el HTTPS. Por eso la pantalla va en dos piezas que se agregan al costado —
`deploy/novnc-map.conf` y `deploy/novnc-locations.conf`— y una sola línea dentro
del server block. No hay nada nuevo que abrir en el firewall: 6080 sigue en el
loopback.

Desde la máquina de escritorio, subir las dos piezas:

```powershell
scp deploy/novnc-map.conf       godeye@177.7.53.246:/tmp/
scp deploy/novnc-locations.conf godeye@177.7.53.246:/tmp/
```

Y en el VPS, ponerlas en su lugar y enchufarlas:

```bash
sudo mv /tmp/novnc-map.conf       /etc/nginx/conf.d/godeye-vnc-map.conf
sudo mv /tmp/novnc-locations.conf /etc/nginx/snippets/godeye-vnc.conf

# El include va en TODOS los server blocks del sitio: certbot dejó dos
# (el 80 que redirige y el 443 que sirve), y cada uno tiene su server_name.
sudo sed -i '/server_name .*iagent\.mx/a\    include snippets/godeye-vnc.conf;'   /etc/nginx/sites-available/godeye

grep -n "include snippets/godeye-vnc" /etc/nginx/sites-available/godeye   # debe salir 2 veces
sudo nginx -t && sudo systemctl reload nginx
```

Si `nginx -t` se queja de que `auth_request` es una directiva desconocida, falta
el módulo: `sudo apt install nginx-extras`.

Comprobación, desde cualquier lado:

```bash
curl -sI https://yoconjulieta.iagent.mx/novnc/vnc.html | head -1
```

`302` a `/login` es lo correcto sin sesión — significa que nginx ya lo está
atendiendo. Si contesta `307` a `/login?next=/novnc/vnc.html`, el include no
tomó: la petición sigue cayendo en Next, y el iframe va a mostrar un 404.

Desde ahí, la pantalla se abre con el botón de monitor de la barra superior del
panel — en otra pestaña, y solo para el rol admin.

### Iniciar sesión la primera vez

La API local viene apagada y la sesión hay que abrirla desde la ventana de la
aplicación. Con lo de arriba montado se entra por el panel. Antes de eso —o
desde una máquina sin sesión— queda el túnel, que acerca el 6080 del VPS al
localhost propio:

```powershell
ssh -N -L 6080:127.0.0.1:6080 godeye@177.7.53.246
```

Y en el navegador, `http://127.0.0.1:6080/vnc.html` → *Connect*. Ahí se inicia
sesión y se activa la API local en **API & MCP**, que debe quedar en
`http://127.0.0.1:50325` con *Connection: Success*. Si dejás *API verification*
apagada, `ADSPOWER_API_KEY` va vacía en el `.env.local`.

Comprobación:

```bash
curl -s http://127.0.0.1:50325/status
curl -s "http://127.0.0.1:50325/api/v1/user/list?page=1&page_size=5"
```

Si el puerto lo tiene `sshd` en vez de `adspower_global` (`sudo ss -tlnp | grep
50325`), es que quedó abierto un túnel inverso viejo desde la PC y le robó el
puerto: cerralo y reiniciá el servicio.

### El worker de automatización

Con AdsPower en el VPS, el worker de tareas también corre ahí y la PC deja de
formar parte del sistema:

```bash
pm2 start ecosystem.config.cjs --only godeye-tasks
pm2 save
```

**Antes de mover cuentas reales**, probá una tarea con un perfil de descarte:
los perfiles creados corriendo sobre Windows pasan a lanzarse desde Linux, y
aunque AdsPower falsea la huella, un desajuste en un perfil que la plataforma ya
conoce puede encender alarmas.

Si preferís dejar AdsPower en la PC, el worker va allá en vez de acá — mismo
comando, y para que arranque con Windows: `npm install -g pm2-windows-startup`
y `pm2-startup install`. En ese caso la sincronización de perfiles necesita un
túnel inverso, documentado en `.env.example`.

### Cómo saber cuál está vivo

El chip de la barra superior tiene tres estados:

| Chip | Significa |
|---|---|
| `EN VIVO` | Los dos workers latiendo |
| `SOLO ESCUCHA` | Se ingiere, pero `godeye-tasks` está caído: las tareas en cola no avanzan |
| `SOLO TAREAS` | La automatización corre, pero nadie ingiere: la escucha solo avanza con "Buscar ahora" |
| `SIN WORKER` | Ninguno |

---

## Actualizar

```bash
cd ~/godeye && git pull && npm ci && npm run build && pm2 reload all
```

`pm2 reload` en vez de `restart`: espera a que terminen las peticiones en vuelo
en vez de cortarlas.

## Mantenimiento

```bash
npm run listening:repair              # simula
npm run listening:repair -- --apply   # limpia duplicados de figuras renombradas
pm2 logs --lines 100
pm2 monit
```

## Si algo falla

| Síntoma | Causa habitual |
|---|---|
| La web carga pero todo sale vacío | La IP del VPS no está en Network Access de Atlas |
| `SSL alert number 80` / "Could not connect to any servers" | Lo mismo, visto desde el otro lado: Atlas corta el TLS a las IPs que no están en la lista. Verificá además que la lista que estás mirando sea la del proyecto de Atlas donde vive el cluster: es por proyecto, no por cuenta, y editar la del proyecto equivocado no cambia nada. Una IP doméstica rota cada tanto; la del VPS es fija |
| `next build` muere sin mensaje | El VPS se quedó sin RAM. Agregá swap: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` |
| Links de compartir apuntan a localhost | `NEXT_PUBLIC_SHARE_BASE_URL` se cambió sin rebuild |
| El chip dice `SIN WORKER` con PM2 arriba | El worker no conecta a Mongo — `pm2 logs godeye-listening` |
| Todo cae tras reiniciar el VPS | Faltó ejecutar el comando que imprimió `pm2 startup` |
| `nginx -t` dice que el puerto ya está en uso | Otra app tomó el 3001. Cambiá `PORT` en `ecosystem.config.cjs` y el `proxy_pass` del bloque de nginx |
| `ERR_TOO_MANY_REDIRECTS` después de cambiar el dominio | El `server_name` no coincidía con el dominio que se le pasó a certbot, así que certbot agregó un `server` propio en 443 que redirige HTTPS a HTTPS. Ver «Cambiar el dominio más adelante» |
