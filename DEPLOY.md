# Despliegue en un VPS

Guía para dejar Ojo de Dios corriendo 24/7 sin depender de tu máquina.

## Qué va dónde, y por qué

El sistema son dos mitades con requisitos de hardware distintos:

| | Dónde corre | Por qué |
|---|---|---|
| Web + escucha (Viento, Agua, dashboard, briefs) | **VPS Linux** | Solo necesita salida a internet |
| Automatización (Perfiles, Tareas, Warmup, Likes, Publicar) | **Tu Windows** | Habla por CDP con AdsPower de escritorio, que no corre en un VPS pelado |

No hace falta rediseñar nada para separarlos: el worker no habla con la web,
toma el trabajo directo de Mongo. Son dos procesos leyendo la misma base.

Resultado: **la escucha ingiere sola día y noche**, y AdsPower solo hace falta
encendido cuando quieras que se ejecuten publicaciones o warmups.

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

Y ahí cambiá estas tres:

```bash
SITE_PASSWORD=una-larga-y-nueva      # es la única puerta del panel en internet
NEXT_PUBLIC_SHARE_BASE_URL=https://godeye.iagent.mx
ADSPOWER_API_BASE_URL=               # vacío: AdsPower no vive acá
```

`NEXT_PUBLIC_SHARE_BASE_URL` se inyecta **en el build**, no en el arranque: si la
cambiás después, hay que volver a correr `npm run build` o los links de campañas
seguirán apuntando a donde apuntaban.

## 4. Los procesos

```bash
pm2 start ecosystem.config.cjs --only godeye-web,godeye-listening
pm2 save
pm2 startup          # imprime un comando con sudo — copialo y ejecutalo
```

Ese último paso es el que hace que todo vuelva solo después de un reinicio del
VPS. Sin él, un reboot deja el sistema caído sin avisar.

```bash
pm2 status
pm2 logs godeye-listening --lines 50
```

## 5. Dominio y HTTPS

Apuntá un registro **A** de tu dominio a la IP del VPS y esperá a que propague.

El archivo ya viene con `godeye.iagent.mx`; si usás otro dominio, cambialo ahí.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/godeye
sudo ln -s /etc/nginx/sites-available/godeye /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d godeye.iagent.mx
```

Certbot deja la renovación automática configurada.

## 6. El worker de automatización, en tu Windows

En la máquina donde está AdsPower, en el repo local:

```powershell
npm install -g pm2
pm2 start ecosystem.config.cjs --only godeye-tasks
pm2 save
```

Para que arranque con Windows: `npm install -g pm2-windows-startup` y luego
`pm2-startup install`.

Ese proceso usa el mismo `.env.local` de siempre (con `ADSPOWER_API_BASE_URL`
apuntando a AdsPower) y toma solo tareas de automatización. La escucha la
ignora, porque de eso ya se encarga el VPS.

### Cómo saber cuál está vivo

El chip de la barra superior tiene tres estados:

| Chip | Significa |
|---|---|
| `EN VIVO` | Los dos workers latiendo |
| `SOLO ESCUCHA` | El VPS ingiere, pero AdsPower/Windows está apagado: las tareas en cola no avanzan |
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
| `SSL alert number 80` / "Could not connect to any servers" | Lo mismo, visto desde el otro lado: Atlas corta el TLS a las IPs que no están en la lista. Le pasa seguido al worker de tu Windows, porque la IP doméstica rota cada tanto — hay que actualizarla en Atlas cuando cambia. El VPS no sufre esto: su IP es fija |
| `next build` muere sin mensaje | El VPS se quedó sin RAM. Agregá swap: `fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile` |
| Links de compartir apuntan a localhost | `NEXT_PUBLIC_SHARE_BASE_URL` se cambió sin rebuild |
| El chip dice `SIN WORKER` con PM2 arriba | El worker no conecta a Mongo — `pm2 logs godeye-listening` |
| Todo cae tras reiniciar el VPS | Faltó ejecutar el comando que imprimió `pm2 startup` |
| `nginx -t` dice que el puerto ya está en uso | Otra app tomó el 3001. Cambiá `PORT` en `ecosystem.config.cjs` y el `proxy_pass` del bloque de nginx |
