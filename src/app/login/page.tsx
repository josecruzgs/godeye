"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Lock } from "lucide-react";
import Image from "next/image";

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-page" />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";

  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "Contraseña incorrecta");
      }
      // Recarga completa (no router.push) para que el middleware vuelva a
      // evaluar la request con la cookie recién seteada.
      window.location.href = next;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-6">
      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-hairline bg-surface/70 p-6 shadow-sm backdrop-blur-xl"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <Image src="/media/logoblack.png" alt="Ojo de Dios" width={40} height={40} className="object-contain dark:hidden" />
          <Image src="/media/logo.png" alt="Ojo de Dios" width={40} height={40} className="hidden object-contain dark:block" />
          <h1 className="text-lg font-semibold text-ink">Ojo de Dios</h1>
          <p className="flex items-center gap-1.5 text-sm text-ink-secondary">
            <Lock className="h-3.5 w-3.5" /> Ingresa la contraseña para continuar
          </p>
        </div>

        {error && <p className="rounded-lg bg-critical/10 p-2 text-center text-sm text-critical">{error}</p>}

        <input
          autoFocus
          type="password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Contraseña"
          className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
        />

        <button
          disabled={loading || !password}
          className="glow-btn rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
        >
          {loading ? "Entrando..." : "Entrar"}
        </button>
      </form>
    </div>
  );
}
