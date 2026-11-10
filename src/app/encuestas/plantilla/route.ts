import { NextResponse } from "next/server";

/**
 * LA PLANTILLA PARA SUBIR LA BASE. Solo encabezados, sin renglones de ejemplo: un ejemplo que se queda en el archivo
 * acaba en la base y la asistente le marca. Los nombres de columna son los que reconoce cargarFilas (lib/encuestas/base.ts).
 * Va con BOM y punto y coma para que Excel en español la abra en columnas y con acentos.
 */
export function GET() {
  const csv = "﻿" + ["Teléfono", "Nombre", "Apellido paterno", "Apellido materno", "Colonia"].join(";") + "\r\n";
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="plantilla-base-encuestas.csv"',
      "Cache-Control": "no-store",
    },
  });
}
