#!/usr/bin/env bash
#
# El "Actualizar" de DEPLOY.md, hecho script para que lo pueda disparar el
# webhook. Se puede correr a mano igual: `bash ~/godeye/deploy/update.sh`.
set -uo pipefail

REPO="${GODEYE_REPO_DIR:-$HOME/godeye}"
BRANCH="${GODEYE_DEPLOY_BRANCH:-main}"
# Margen de disco antes de tocar node_modules o .next. La caché de AdsPower
# llena el disco sola, y un `npm ci` a mitad de camino sin espacio deja el
# árbol de dependencias roto, que es mucho peor que no desplegar.
MIN_FREE_MB="${GODEYE_MIN_FREE_MB:-3000}"

cd "$REPO" || exit 1

# Un solo deploy a la vez, aunque el webhook y una mano lo lancen juntos.
exec 9>"$HOME/.godeye-deploy.lock"
if ! flock -n 9; then
  echo "== $(date -Is) ya hay un deploy corriendo; salgo"
  exit 0
fi

step() { echo "-- $(date -Is) $*"; }
fail() { echo "!! $(date -Is) $*"; exit 1; }

echo "== $(date -Is) deploy en $REPO ($BRANCH)"

before=$(git rev-parse HEAD) || fail "no pude leer HEAD"

step "git fetch"
git fetch --prune origin "$BRANCH" || fail "fetch falló"
target=$(git rev-parse "origin/$BRANCH") || fail "no existe origin/$BRANCH"

if [ "$before" = "$target" ]; then
  echo "== ya estaba en ${target:0:7}, nada que hacer"
  exit 0
fi

free_mb=$(df -Pm / | awk 'NR==2 {print $4}')
[ "$free_mb" -ge "$MIN_FREE_MB" ] || fail "solo quedan ${free_mb}MB libres en / (mínimo ${MIN_FREE_MB}). Limpiá antes de desplegar."

step "${before:0:7} -> ${target:0:7}"
git log --oneline "$before..$target" | sed 's/^/   /'

# reset --hard y no pull: el pull se atasca pidiendo resolver conflictos si
# alguien editó un archivo en el servidor, y acá no hay nadie para responder.
# No toca lo que no está versionado: .env.local, uploads/ y screenshots/ siguen
# donde estaban.
git reset --hard "$target" || fail "reset falló"

# npm ci borra node_modules entero y tarda minutos; solo tiene sentido si
# cambiaron las dependencias.
if git diff --name-only "$before" "$target" | grep -qE '^package(-lock)?\.json$'; then
  step "npm ci (cambiaron las dependencias)"
  npm ci || fail "npm ci falló"
else
  step "dependencias sin cambios, salteo npm ci"
fi

step "npm run build"
if ! npm run build; then
  echo "!! el build falló. Los procesos siguen corriendo con el build anterior en memoria,"
  echo "!! pero .next quedó a medias: NO reinicies PM2 hasta arreglarlo."
  echo "!! Para volver atrás:  cd $REPO && git reset --hard $before && npm run build && pm2 reload all"
  exit 1
fi

# reload y no restart: espera a que terminen las peticiones en vuelo. Ojo que
# para los workers (fork, no cluster) es un reinicio igual: una tarea de
# automatización en curso se corta.
step "pm2 reload"
pm2 reload all || fail "pm2 reload falló"

echo "== $(date -Is) listo en ${target:0:7}"
