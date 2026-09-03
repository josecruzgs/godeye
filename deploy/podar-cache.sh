#!/usr/bin/env bash
#
# Poda la caché de AdsPower antes de que llene el disco.
#
# El directorio crece ~4 GB por día y ya tiró producción dos veces (28/8 y 3/9
# de 2026): al quedarse sin espacio, el `npm ci` del deploy borra node_modules y
# no lo puede reinstalar, así que el servidor queda sin dependencias y el
# síntoma —"mi cambio no aparece"— no se parece en nada a la causa.
#
# AdsPower recibe `clear_cache_after_closing: 1` desde el 28/8 y lo ignora: el
# 3/9 la caché había vuelto a 73 GB. De ahí este cron.
#
# Se instala en el crontab del usuario `godeye`:
#
#   crontab -e
#   0 */6 * * * /home/godeye/godeye/deploy/podar-cache.sh >> /home/godeye/podar-cache.log 2>&1
#
set -uo pipefail

# Solo `Default/Cache` y `Default/Code Cache` por perfil: es descartable. Las
# sesiones de Facebook viven en ~/.config/adspower_global, que NO se toca.
CACHE="${GODEYE_CACHE_DIR:-/home/godeye/.cache/adspower_global/cwd_global/source/cache}"

# A partir de qué uso de disco vale la pena podar. No es cada seis horas porque
# sí: recorrer un árbol de millones de archivos diminutos cuesta I/O, y mientras
# haya lugar de sobra ese costo no compra nada.
UMBRAL="${GODEYE_CACHE_UMBRAL:-50}"

# Minutos de gracia. Este es el número que hace seguro correr esto a ciegas: una
# tarea dura minutos y el tope duro del worker son 20, así que un archivo sin
# tocar en seis horas es de una sesión cerrada hace rato. Los que el navegador
# abierto está usando son recientes y quedan afuera de la poda.
EDAD="${GODEYE_CACHE_EDAD_MIN:-360}"

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
