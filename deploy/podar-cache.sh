#!/usr/bin/env bash
#
# Poda la caché de AdsPower antes de que llene el disco.
#
# El directorio crece ~4 GB por día y ya tiró producción dos veces (28/8 y 3/9
# de 2026): al quedarse sin espacio, el `npm ci` del deploy borra node_modules y
# no lo puede reinstalar, así que el servidor queda sin dependencias y el
# síntoma —"mi cambio no aparece"— no se parece en nada a la causa.
#
# AdsPower recibe `clear_cache_after_closing: 1` desde el 28/8 y lo ignora. Está
# medido, no supuesto: el 3/9/2026, una hora después de vaciar el directorio a
# mano, había 133 carpetas de perfil y 5,4 GB, con nunca más de 3 navegadores
# abiertos a la vez. Cada tarea deja ~40 MB y nadie los borra.
#
# A ese ritmo el disco se llena en ~15 horas, así que esto NO es una red de
# seguridad: mientras el parámetro de AdsPower no funcione, es la única defensa.
#
# Se instala en el crontab del usuario `godeye`:
#
#   crontab -e
#   17 * * * * /home/godeye/godeye/deploy/podar-cache.sh >> /home/godeye/podar-cache.log 2>&1
#
# Cada hora y no cada seis: ver EDAD más abajo.
#
set -uo pipefail

# Solo `Default/Cache` y `Default/Code Cache` por perfil: es descartable. Las
# sesiones de Facebook viven en ~/.config/adspower_global, que NO se toca.
CACHE="${GODEYE_CACHE_DIR:-/home/godeye/.cache/adspower_global/cwd_global/source/cache}"

# A partir de qué uso de disco se poda. Bajo a propósito: el sistema sin caché
# ocupa ~14%, así que esto poda casi siempre, y ese es el punto. Con el árbol
# chico cada pasada es barata; el umbral existe solo para no recorrer nada
# cuando de verdad no hay nada que recorrer.
UMBRAL="${GODEYE_CACHE_UMBRAL:-25}"

# Minutos de gracia. Este es el número que hace seguro correr esto a ciegas: el
# tope duro de una tarea son 20 minutos, así que dos horas es seis veces el peor
# caso. Los archivos que un navegador abierto está usando son recientes y quedan
# afuera de la poda.
#
# También es lo que fija cuánta caché vive en el disco en régimen: la que se
# generó en las últimas dos horas. Medido el 3/9/2026 con 3 motores, eso son
# ~11 GB. Si algún día se suben los motores, este número baja, no el umbral.
EDAD="${GODEYE_CACHE_EDAD_MIN:-120}"

[ -d "$CACHE" ] || exit 0

libre_mb() { df -Pm / | awk 'NR==2 {print $4}'; }

uso=$(df -P / | awk 'NR==2 {print $5}' | tr -d '%')
if [ "$uso" -lt "$UMBRAL" ]; then
  exit 0
fi

antes=$(libre_mb)

# Los errores se tragan a propósito: en un árbol que un navegador está
# escribiendo, find se cruza con archivos que desaparecen solos entre el listado
# y el borrado, y eso no es una falla.
find "$CACHE" -type f -mmin +"$EDAD" -delete 2>/dev/null

# Los directorios que quedaron vacíos, con la misma gracia de tiempo: sin el
# -mmin podría borrar la carpeta de caché que un perfil recién abierto todavía
# no llenó.
find "$CACHE" -mindepth 1 -type d -empty -mmin +"$EDAD" -delete 2>/dev/null

despues=$(libre_mb)
echo "$(date -Is) poda: uso ${uso}% · liberados $((despues - antes)) MB · libres ${despues} MB"
