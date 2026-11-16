/**
 * Gancho de arranque de Next.js: se ejecuta una vez al iniciar el servidor.
 *
 *   1. Verifica que la aplicación NO se ha conectado a PostgreSQL con un rol
 *      capaz de saltarse las guardas VERI*FACTU (ver lib/db/verificar-rol.ts).
 *   2. Opcionalmente arranca el worker de remisión a la AEAT dentro del propio
 *      proceso (ver lib/verifactu/aeat/planificador.ts).
 */
export async function register() {
  // Solo en el runtime de Node: el driver de PostgreSQL no existe en Edge.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { verificarRolBaseDatos } = await import('./lib/db/verificar-rol');
    await verificarRolBaseDatos();

    const { iniciarPlanificador } = await import('./lib/verifactu/aeat/planificador');
    iniciarPlanificador();
  }
}
