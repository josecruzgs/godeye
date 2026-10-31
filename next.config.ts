import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lee su base de IPs del disco con rutas relativas a su propia carpeta, que
  // dejan de existir si Next lo empaqueta.
  serverExternalPackages: ["fast-geoip"],
  experimental: {
    serverActions: {
      // Encuestas sube la base de teléfonos (Excel o CSV de hasta 8 MB) por una
      // server action, y el tope por omisión de Next es 1 MB.
      bodySizeLimit: "9mb",
      // Next rechaza una server action si el `origin` no coincide con el host
      // que le llega. Detrás del nginx del VPS le llega 127.0.0.1:3001: el
      // `location /` define sus propios proxy_set_header (los del websocket) y
      // con eso nginx deja de heredar el `Host $host` del server. Sin esta
      // lista, todos los botones de Encuestas fallaban con "Invalid Server
      // Actions request".
      allowedOrigins: ["ojodedios.net", "www.ojodedios.net"],
    },
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
