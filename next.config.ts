import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lee su base de IPs del disco con rutas relativas a su propia carpeta, que
  // dejan de existir si Next lo empaqueta.
  serverExternalPackages: ["fast-geoip"],
  // Encuestas sube la base de teléfonos (Excel o CSV de hasta 8 MB) por una
  // server action, y el tope por omisión de Next es 1 MB.
  experimental: {
    serverActions: { bodySizeLimit: "9mb" },
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
};

export default nextConfig;
