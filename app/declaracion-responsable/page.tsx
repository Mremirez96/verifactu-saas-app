import type { Metadata } from 'next';
import { declaracionResponsable } from '@/lib/verifactu/documentos/declaracion';

export const metadata: Metadata = {
  title: 'Declaración responsable del sistema informático de facturación',
};

// Los datos del productor se leen del entorno en cada petición.
export const dynamic = 'force-dynamic';

/**
 * Declaración responsable del SIF, visible dentro del propio sistema
 * (art. 13.2 del RD 1007/2023 y art. 15.3 de la Orden HAC/1177/2024).
 * Página pública: también deben poder consultarla clientes y comercializadores.
 */
export default function DeclaracionResponsablePage() {
  const declaracion = declaracionResponsable();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-gray-900">
      <h1 className="text-xl font-bold tracking-wide">{declaracion.titulo}</h1>

      {!declaracion.completa && (
        <p role="alert" className="mt-6 rounded border border-red-600 bg-red-50 p-4 text-sm text-red-800">
          <strong>Declaración incompleta: no es válida todavía.</strong> Faltan datos que solo puede aportar
          el productor del sistema (apartados {declaracion.pendientes.map((p) => p.slice(0, 2)).join(', ')}).
        </p>
      )}

      <ol className="mt-8 space-y-5">
        {declaracion.apartados.map((apartado) => (
          <li key={apartado.letra} className="text-sm leading-relaxed">
            <p className="font-semibold">
              {apartado.letra}) {apartado.descripcion}:
            </p>
            <p className={apartado.valor ? 'mt-1' : 'mt-1 italic text-red-700'}>
              {apartado.valor ?? 'Pendiente de aportar por el productor.'}
            </p>
          </li>
        ))}
      </ol>
    </main>
  );
}
