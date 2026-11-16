/**
 * Tests de integración de la Fase 1 (cimientos).  →  pnpm test:db
 *
 * Se ejecutan contra un PostgreSQL REAL, ya migrado, conectándose con el rol
 * de la aplicación (POSTGRES_URL). Así se prueba lo que de verdad importa:
 * que con los privilegios acotados los servicios funcionan y las guardas no
 * se pueden saltar.
 *
 * Usar SIEMPRE una base de datos desechable: las empresas no se pueden borrar
 * (es precisamente lo que se comprueba), así que cada ejecución deja datos.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { client, db } from '@/lib/db/drizzle';
import {
  cadenasFiscales,
  enviosAeat,
  facturas,
  facturasLineas,
  registrosVerifactu,
  seriesFacturacion,
  teamMembers,
  teams,
  users,
} from '@/lib/db/schema';
import { diagnosticarRol } from '@/lib/db/verificar-rol';
import type { ContextoUsuario } from '../contexto';
import { altaEmpresa, cargarEmpresa, listarEmpresas, obtenerEmpresa } from '../empresas/servicio';
import { comoErrorPostgres, ErrorDominio, traducirErrorBd, type CodigoError } from '../errores';
import { validarNif } from '../nif';
import { serieAdmiteTipoFactura, siguienteNumeroPrevisto, tipoSerieParaFactura } from '../series/reglas';
import {
  crearSerie,
  eliminarSerie,
  listarSeries,
  marcarSeriePorDefecto,
  modificarSerie,
} from '../series/servicio';

/* ------------------------------- utilidades -------------------------------- */

/** DNI aleatorio con su letra correcta (el NIF es único en todo el sistema). */
function dniAleatorio(): string {
  const numero = randomInt(10_000_000, 99_999_999);
  return `${numero}${'TRWAGMYFPDXBNJZSQVHLCKE'[numero % 23]}`;
}

async function crearCuenta(rol: 'owner' | 'member' = 'owner'): Promise<ContextoUsuario> {
  const marca = `${Date.now()}-${randomInt(1e9)}`;
  const [usuario] = await db
    .insert(users)
    .values({ email: `test-${marca}@example.com`, passwordHash: 'x', role: rol })
    .returning();
  const [cuenta] = await db.insert(teams).values({ name: `Cuenta ${marca}` }).returning();
  await db.insert(teamMembers).values({ userId: usuario.id, teamId: cuenta.id, role: rol });
  return { usuarioId: usuario.id, teamId: cuenta.id, rol, ip: '127.0.0.1' };
}

/** La promesa debe rechazarse con un ErrorDominio del código indicado. */
async function rechazaCon(codigo: CodigoError, promesa: Promise<unknown>, contiene?: RegExp) {
  await assert.rejects(promesa, (error: unknown) => {
    assert.ok(error instanceof ErrorDominio, `se esperaba ErrorDominio y llegó: ${error}`);
    assert.equal(error.codigo, codigo, error.message);
    if (contiene) assert.match(error.message, contiene);
    return true;
  });
}

/** La sentencia debe ser rechazada por PostgreSQL con ese SQLSTATE. */
async function sqlRechazado(sqlstate: string, promesa: Promise<unknown>) {
  await assert.rejects(promesa, (error: unknown) => {
    assert.equal(comoErrorPostgres(error)?.code, sqlstate, String(error));
    return true;
  });
}

const PERMISO_DENEGADO = '42501';

/* --------------------------------- tests ----------------------------------- */

let A: ContextoUsuario; // cuenta A (propietario)
let B: ContextoUsuario; // cuenta B (propietario): otro tenant

before(async () => {
  A = await crearCuenta();
  B = await crearCuenta();
});

after(async () => {
  await client.end();
});

describe('NIF', () => {
  it('acepta DNI, NIE y NIF de sociedad con control correcto y los normaliza', () => {
    assert.deepEqual(validarNif('12345678-z'), { valido: true, nif: '12345678Z', tipo: 'DNI' });
    assert.equal(validarNif('X1234567L').valido, true);
    assert.equal(validarNif('A58818501').valido, true); // sociedad anónima, control numérico
    assert.equal(validarNif('Q2826000H').valido, true); // organismo público, control letra
  });
  it('rechaza controles incorrectos y formatos inválidos', () => {
    assert.equal(validarNif('12345678A').valido, false);
    assert.equal(validarNif('X1234567A').valido, false);
    assert.equal(validarNif('A58818502').valido, false);
    assert.equal(validarNif('1234').valido, false);
  });
});

describe('Rol de base de datos de la aplicación', () => {
  it('pasa el diagnóstico de privilegios acotados', async () => {
    const { rol, problemas } = await diagnosticarRol(client);
    assert.deepEqual(problemas, [], `el rol "${rol}" tiene privilegios de más`);
  });

  it('no puede desactivar triggers ni tocar lo que solo tocan los triggers', async () => {
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`ALTER TABLE facturas DISABLE TRIGGER USER`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`SET session_replication_role = replica`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`TRUNCATE facturas CASCADE`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`DELETE FROM registros_verifactu`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`UPDATE registros_verifactu SET huella = repeat('0', 64)`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`DELETE FROM eventos_log`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`UPDATE cadenas_fiscales SET ultimo_num_secuencia = 0`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`UPDATE series_facturacion SET ultimo_numero = 99`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`DELETE FROM empresas`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`DELETE FROM envios_aeat`));
    await sqlRechazado(PERMISO_DENEGADO, db.execute(sql`CREATE TABLE intrusa (id int)`));
  });
});

describe('Alta de empresa', () => {
  it('crea la empresa con sus cadenas vacías y sus tres series a cero', async () => {
    const nif = dniAleatorio();
    const { empresa, cadenas, series } = await altaEmpresa(A, {
      nif: nif.toLowerCase(),
      nombreRazon: '  Peluquería Ejemplo  ',
      email: '',
    });

    assert.equal(empresa.nif, nif);
    assert.equal(empresa.nombreRazon, 'Peluquería Ejemplo');
    assert.equal(empresa.teamId, A.teamId);
    assert.equal(empresa.modoVerifactu, 'VERIFACTU');
    assert.equal(empresa.tipoImpositivoPorDefecto, '21.00');
    assert.equal(empresa.husoHorario, 'Europe/Madrid');
    assert.match(empresa.numeroInstalacion, /^VF-[0-9A-F-]{36}$/);

    assert.deepEqual(cadenas.map((c) => c.tipoCadena).sort(), ['EVENTOS', 'FACTURACION']);
    for (const cadena of cadenas) {
      assert.equal(cadena.ultimoNumSecuencia, 0);
      assert.equal(cadena.ultimoId, null);
      assert.equal(cadena.ultimaHuella, null);
    }

    const yy = String(new Date().getFullYear()).slice(-2);
    assert.deepEqual(
      series.map((s) => `${s.tipoSerie}:${s.codigo}:${s.ultimoNumero}:${s.porDefecto}`).sort(),
      [`ORDINARIA:F${yy}-:0:true`, `RECTIFICATIVA:R${yy}-:0:true`, `SIMPLIFICADA:T${yy}-:0:true`]
    );
  });

  it('aplica los valores propios de Canarias cuando el impuesto es IGIC', async () => {
    const { empresa } = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Fontanería Canaria', impuestoPorDefecto: '03' });
    assert.equal(empresa.tipoImpositivoPorDefecto, '7.00');
    assert.equal(empresa.husoHorario, 'Atlantic/Canary');
  });

  it('rechaza NIF inválido, modo aún no disponible e IPSI sin tipo', async () => {
    await rechazaCon('VALIDACION', altaEmpresa(A, { nif: '12345678A', nombreRazon: 'X' }), /DNI/);
    await rechazaCon('VALIDACION', altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: '' }));
    await rechazaCon('VALIDACION', altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'X', modoVerifactu: 'NO_VERIFACTU' }), /NO VERI\*FACTU/);
    await rechazaCon('VALIDACION', altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'X', impuestoPorDefecto: '02' }), /IPSI/);
  });

  it('no admite el mismo NIF dos veces, ni siquiera desde otra cuenta', async () => {
    const nif = dniAleatorio();
    await altaEmpresa(A, { nif, nombreRazon: 'Original' });
    await rechazaCon('CONFLICTO', altaEmpresa(B, { nif, nombreRazon: 'Duplicada' }), /Ya existe/);
    // ...y el intento fallido no deja nada a medias en la cuenta B.
    assert.equal((await listarEmpresas(B)).filter((e) => e.nif === nif).length, 0);
  });

  it('solo el propietario de la cuenta puede dar de alta empresas', async () => {
    const miembro = await crearCuenta('member');
    await rechazaCon('SIN_PERMISO', altaEmpresa(miembro, { nif: dniAleatorio(), nombreRazon: 'X' }));
  });
});

describe('Aislamiento entre cuentas', () => {
  it('una cuenta no ve ni modifica empresas ni series de otra', async () => {
    const { empresa, series } = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Solo de A' });

    assert.equal((await listarEmpresas(B)).some((e) => e.id === empresa.id), false);
    await rechazaCon('NO_ENCONTRADO', cargarEmpresa(B, empresa.id));
    await rechazaCon('NO_ENCONTRADO', obtenerEmpresa(B, empresa.id));
    await rechazaCon('NO_ENCONTRADO', listarSeries(B, empresa.id));
    await rechazaCon('NO_ENCONTRADO', crearSerie(B, empresa.id, { codigo: 'HACK-', tipoSerie: 'ORDINARIA' }));
    await rechazaCon('NO_ENCONTRADO', modificarSerie(B, empresa.id, series[0].id, { descripcion: 'hack' }));
    await rechazaCon('NO_ENCONTRADO', eliminarSerie(B, empresa.id, series[0].id));

    // Una serie de A tampoco es alcanzable "a través" de una empresa de B.
    const deB = await altaEmpresa(B, { nif: dniAleatorio(), nombreRazon: 'Solo de B' });
    await rechazaCon('NO_ENCONTRADO', modificarSerie(B, deB.empresa.id, series[0].id, { descripcion: 'hack' }));
  });
});

describe('Series de facturación', () => {
  it('distingue ordinarias, simplificadas y rectificativas', () => {
    assert.equal(serieAdmiteTipoFactura('ORDINARIA', 'F1'), true);
    assert.equal(serieAdmiteTipoFactura('ORDINARIA', 'R1'), false);
    assert.equal(serieAdmiteTipoFactura('RECTIFICATIVA', 'R5'), true);
    assert.equal(serieAdmiteTipoFactura('RECTIFICATIVA', 'F1'), false);
    assert.equal(serieAdmiteTipoFactura('SIMPLIFICADA', 'F1'), false);
    assert.equal(tipoSerieParaFactura('R4'), 'RECTIFICATIVA');
    assert.equal(tipoSerieParaFactura('F2'), 'SIMPLIFICADA');
    assert.equal(tipoSerieParaFactura('F3'), 'ORDINARIA');
    assert.equal(siguienteNumeroPrevisto({ codigo: 'F26-', digitosRelleno: 6, ultimoNumero: 41 }), 'F26-000042');
    assert.equal(siguienteNumeroPrevisto({ codigo: 'T-', digitosRelleno: 2, ultimoNumero: 999 }), 'T-1000');
  });

  it('crea, cambia la predeterminada, modifica y borra series sin usar', async () => {
    const { empresa, series } = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Clínica Series' });
    const rectInicial = series.find((s) => s.tipoSerie === 'RECTIFICATIVA')!;

    // Alta: código a mayúsculas, contador a cero aunque se intente otra cosa.
    const nueva = await crearSerie(A, empresa.id, {
      codigo: 'ra26-', tipoSerie: 'RECTIFICATIVA', descripcion: 'Abonos', porDefecto: 'on', ultimoNumero: 500,
    });
    assert.equal(nueva.codigo, 'RA26-');
    assert.equal(nueva.ultimoNumero, 0);
    assert.equal(nueva.porDefecto, true);

    // Solo queda UNA predeterminada por tipo, y las otras series no se tocan.
    const rectificativas = await listarSeries(A, empresa.id, { tipoSerie: 'RECTIFICATIVA' });
    assert.deepEqual(rectificativas.filter((s) => s.porDefecto).map((s) => s.codigo), ['RA26-']);
    assert.equal((await listarSeries(A, empresa.id)).filter((s) => s.porDefecto).length, 3);

    await rechazaCon('CONFLICTO', crearSerie(A, empresa.id, { codigo: 'RA26-', tipoSerie: 'ORDINARIA' }), /Ya existe una serie/);
    await rechazaCon('VALIDACION', crearSerie(A, empresa.id, { codigo: 'mal código', tipoSerie: 'ORDINARIA' }));
    await rechazaCon('VALIDACION', crearSerie(A, empresa.id, { codigo: 'X-', tipoSerie: 'ABONO' }));

    // Volver a la inicial como predeterminada.
    const restaurada = await marcarSeriePorDefecto(A, empresa.id, rectInicial.id);
    assert.equal(restaurada.porDefecto, true);

    // Una serie sin usar se puede renombrar y desactivar; la predeterminada no se desactiva.
    const renombrada = await modificarSerie(A, empresa.id, nueva.id, { codigo: 'ab26-', digitosRelleno: 4, activa: false });
    assert.equal(renombrada.codigo, 'AB26-');
    assert.equal(renombrada.digitosRelleno, 4);
    assert.equal(renombrada.activa, false);
    await rechazaCon('CONFLICTO', modificarSerie(A, empresa.id, rectInicial.id, { activa: false }), /por defecto/);
    await rechazaCon('CONFLICTO', marcarSeriePorDefecto(A, empresa.id, nueva.id), /inactiva/);
    assert.equal((await listarSeries(A, empresa.id)).some((s) => s.id === nueva.id), false); // inactiva: oculta
    assert.equal((await listarSeries(A, empresa.id, { incluirInactivas: true })).some((s) => s.id === nueva.id), true);

    // Borrado: la predeterminada no; una sin usar sí.
    await rechazaCon('CONFLICTO', eliminarSerie(A, empresa.id, rectInicial.id), /por defecto/);
    await eliminarSerie(A, empresa.id, nueva.id);
    await rechazaCon('NO_ENCONTRADO', modificarSerie(A, empresa.id, nueva.id, { descripcion: 'x' }));

    const miembro: ContextoUsuario = { ...A, rol: 'member' };
    await rechazaCon('SIN_PERMISO', crearSerie(miembro, empresa.id, { codigo: 'Z-', tipoSerie: 'ORDINARIA' }));
  });
});

describe('Con el rol acotado, la emisión funciona y la serie usada queda blindada', () => {
  it('emite una factura de extremo a extremo y protege la serie', async () => {
    const { empresa, series } = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Bar Emisión' });
    const tickets = series.find((s) => s.tipoSerie === 'SIMPLIFICADA')!;

    // Simulación mínima de lo que hará el servicio de emisión (siguiente fase),
    // ejecutada con los permisos reales de la aplicación.
    const numSerie = await db.transaction(async (tx) => {
      // 1) Cerrojo de la cadena de ESTA empresa (función SECURITY DEFINER).
      const [cabecera] = await tx.execute<{ ultimo_id: string | null; ultima_huella: string | null }>(
        sql`SELECT ultimo_id, ultima_huella FROM vf_bloquear_cadena(${empresa.id}, 'FACTURACION')`
      );
      assert.equal(cabecera.ultimo_id, null);

      // 2) Borrador + línea, y emisión: el número lo pone la base de datos.
      const [borrador] = await tx
        .insert(facturas)
        .values({
          empresaId: empresa.id, serieId: tickets.id, tipoFactura: 'F2',
          fechaExpedicion: sql`CURRENT_DATE`, emisorNif: empresa.nif, emisorNombreRazon: empresa.nombreRazon,
          descripcionOperacion: 'Consumiciones', baseImponibleTotal: '10.00', cuotaTotal: '1.00',
          importeTotal: '11.00', totalAPagar: '11.00', creadaPor: A.usuarioId,
        })
        .returning();
      await tx.insert(facturasLineas).values({
        empresaId: empresa.id, facturaId: borrador.id, orden: 1, descripcion: 'Menú',
        precioUnitario: '10', baseLinea: '10.00', calificacionOperacion: 'S1', tipoImpositivo: '10.00', cuota: '1.00',
      });
      const [emitida] = await tx.update(facturas).set({ estado: 'EMITIDA' }).where(eq(facturas.id, borrador.id)).returning();
      assert.equal(emitida.numero, 1);

      // 3) Registro de alta encadenado (la huella real llegará con el motor criptográfico).
      const [{ fh }] = await tx.execute<{ fh: string }>(
        sql`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '+00:00' AS fh`
      );
      const huella = createHash('sha256').update(`${emitida.numSerieFactura}|${fh}`).digest('hex').toUpperCase();
      await tx.insert(registrosVerifactu).values({
        empresaId: empresa.id, facturaId: emitida.id, tipoRegistro: 'ALTA',
        idEmisorFactura: empresa.nif, nombreRazonEmisor: empresa.nombreRazon,
        numSerieFactura: emitida.numSerieFactura!, fechaExpedicion: emitida.fechaExpedicion!,
        tipoFactura: 'F2', cuotaTotal: '1.00', importeTotal: '11.00', fechaHoraHusoGen: fh,
        esPrimerRegistro: true, huella, modo: 'VERIFACTU', sifIdSistema: 'VF', sifVersion: '0.1.0',
        sifNumeroInstalacion: empresa.numeroInstalacion, xmlRegistro: '<pendiente/>', qrUrl: 'https://example.invalid/qr',
      });
      return emitida.numSerieFactura!;
    });

    assert.equal(numSerie, `${tickets.codigo}000001`);

    // Efectos que solo han podido producir los triggers (la app no tiene permiso):
    const [serie] = await db.select().from(seriesFacturacion).where(eq(seriesFacturacion.id, tickets.id));
    assert.equal(serie.ultimoNumero, 1);
    const [cadena] = await db.select().from(cadenasFiscales)
      .where(sql`${cadenasFiscales.empresaId} = ${empresa.id} AND ${cadenasFiscales.tipoCadena} = 'FACTURACION'`);
    assert.equal(cadena.ultimoNumSecuencia, 1);
    const cola = await db.select().from(enviosAeat).where(eq(enviosAeat.empresaId, empresa.id));
    assert.deepEqual(cola.map((e) => e.estado), ['PENDIENTE']);

    // La serie ya usada: ni cambia de código, ni se borra.
    await rechazaCon('CONFLICTO', modificarSerie(A, empresa.id, tickets.id, { codigo: 'TX-' }), /ya ha emitido/);
    await rechazaCon('CONFLICTO', modificarSerie(A, empresa.id, tickets.id, { digitosRelleno: 3 }));
    await eliminarSerie(A, empresa.id, tickets.id).then(
      () => assert.fail('no debería poder borrarse'),
      (e) => assert.ok(e instanceof ErrorDominio && e.codigo === 'CONFLICTO')
    );
    // Sí se puede seguir editando lo inocuo.
    assert.equal((await modificarSerie(A, empresa.id, tickets.id, { descripcion: 'Tickets de barra' })).descripcion, 'Tickets de barra');

    // Y si alguien se saltara el servicio, la base de datos lo para igualmente.
    await rechazaCon(
      'REGLA_FISCAL',
      db.update(seriesFacturacion).set({ codigo: 'TX-' }).where(eq(seriesFacturacion.id, tickets.id)).then(
        () => undefined,
        (e) => traducirErrorBd(e)
      ),
      /ya está en uso/
    );
    await rechazaCon(
      'REGLA_FISCAL',
      db.delete(facturas).where(eq(facturas.empresaId, empresa.id)).then(() => undefined, (e) => traducirErrorBd(e)),
      /no se puede borrar/
    );
  });

  it('vf_bloquear_cadena da la cadena en exclusiva hasta el fin de la transacción', async () => {
    const { empresa } = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Cerrojo' });

    await db.transaction(async (tx1) => {
      await tx1.execute(sql`SELECT 1 FROM vf_bloquear_cadena(${empresa.id}, 'FACTURACION')`);

      // Otra transacción que quiera la MISMA cadena tiene que esperar...
      await sqlRechazado('55P03' /* lock_not_available */, db.transaction(async (tx2) => {
        await tx2.execute(sql`SET LOCAL lock_timeout = '300ms'`);
        await tx2.execute(sql`SELECT 1 FROM vf_bloquear_cadena(${empresa.id}, 'FACTURACION')`);
      }));

      // ...pero la cadena de eventos de esa empresa, y las de otras, siguen libres.
      await db.transaction(async (tx3) => {
        await tx3.execute(sql`SET LOCAL lock_timeout = '300ms'`);
        await tx3.execute(sql`SELECT 1 FROM vf_bloquear_cadena(${empresa.id}, 'EVENTOS')`);
      });
    });
  });
});
