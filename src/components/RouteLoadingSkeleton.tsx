// Fallback de Suspense por ruta (ver src/app/*/loading.tsx). A propósito NO
// tiene un ícono girando: RouteTransitionOverlay ya cubre esa animación en
// cada cambio de página, y como ahora es semi-transparente (para dejar ver
// el contenido cargando detrás), un segundo ícono girando acá se veía
// duplicado. Este skeleton solo es visible si una carga real tarda más que
// la ventana del overlay.
export default function RouteLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="h-8 w-48 animate-pulse-soft rounded-lg bg-surface" />
      <div className="h-24 animate-pulse-soft rounded-2xl bg-surface" />
      <div className="h-64 animate-pulse-soft rounded-2xl bg-surface" />
    </div>
  );
}
