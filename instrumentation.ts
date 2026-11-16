/**
 * Gancho de arranque de Next.js: se ejecuta una vez al iniciar el servidor.
 * Aquí se verifica que la aplicación NO se ha conectado a PostgreSQL con un
 * rol capaz de saltarse las guardas VERI*FACTU (ver lib/db/verificar-rol.ts).
 */
export async function register() {
  // Solo en el runtime de Node: el driver de PostgreSQL no existe en Edge.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { verificarRolBaseDatos } = await import('./lib/db/verificar-rol');
    await verificarRolBaseDatos();
  }
}
