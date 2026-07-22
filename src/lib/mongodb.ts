import dns from "dns";
import mongoose from "mongoose";

type MongooseCache = {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
};

declare global {
  var _mongooseCache: MongooseCache | undefined;
}

const cache: MongooseCache = global._mongooseCache ?? { conn: null, promise: null };
global._mongooseCache = cache;

export async function dbConnect() {
  if (cache.conn) return cache.conn;

  const MONGODB_URI = process.env.MONGODB_URI;
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI no está definido. Revisa tu .env.local");
  }

  if (!cache.promise) {
    cache.promise = mongoose
      .connect(MONGODB_URI, { bufferCommands: false })
      .catch(async (err) => {
        // En algunas redes (VPN corporativa, ciertos routers/DNS de Windows)
        // el resolutor DNS nativo de Node no puede resolver el registro SRV
        // de Atlas (mongodb+srv://) aunque el DNS del sistema sí puede.
        // Reintentamos una vez forzando resolutores públicos.
        const isDnsSrvError = err instanceof Error && /querySrv|ECONNREFUSED/i.test(err.message);
        if (!isDnsSrvError || !MONGODB_URI.startsWith("mongodb+srv://")) throw err;

        dns.setServers(["1.1.1.1", "8.8.8.8"]);
        return mongoose.connect(MONGODB_URI, { bufferCommands: false });
      });
  }

  cache.conn = await cache.promise;
  return cache.conn;
}
