import mongoose, { models } from "mongoose";

/**
 * El dev server cachea el modelo ya compilado entre recargas, así que un schema
 * viejo sobrevive a los cambios del archivo que lo define. Con un campo nuevo
 * eso no da error: mongoose simplemente lo descarta al guardar, y el documento
 * queda sin él. Descartando el caché cuando falta alguno de `paths`, la próxima
 * recarga recompila el schema de cero.
 *
 * Con `enums` se cubre el otro caso: agregar un valor a un enum no agrega
 * ningún campo, así que el schema cacheado sigue siendo "válido" según `paths`
 * y rechaza el valor nuevo con un error de validación que no se entiende hasta
 * que uno reinicia el server a mano.
 *
 * Task y Campaign traen su propia versión de esto, escrita antes que esta.
 */
export function dropStaleModel(name: string, paths: string[], enums: Record<string, string[]> = {}) {
  const schema = models[name]?.schema;
  if (!schema) return;

  if (paths.some((path) => !schema.path(path))) {
    mongoose.deleteModel(name);
    return;
  }

  for (const [path, values] of Object.entries(enums)) {
    const current = (schema.path(path) as { enumValues?: string[] } | undefined)?.enumValues ?? [];
    if (values.some((value) => !current.includes(value))) {
      mongoose.deleteModel(name);
      return;
    }
  }
}
