# Auditoría del proyecto

**Fecha:** 2026-10-14
**Alcance:** estado del repositorio frente al prompt maestro (`Prompt_Backend_Plataforma_Ambiental.md`).
**Método:** solo lectura. Se revisaron archivos, dependencias (`npm audit`, `npm outdated`), calidad (`typecheck`, `lint`, `test`) y cumplimiento de las secciones 2, 3, 7, 8 y 13 del prompt.

## Resultado general

| Área | Estado |
|---|---|
| Calidad (typecheck, lint, pruebas) | Verde: 6 pruebas pasan |
| Dependencias | 7 vulnerabilidades (3 críticas, 1 alta, 3 moderadas), todas en herramientas de prueba |
| Cumplimiento del alcance (sección 2) | Parcial: esqueleto y configuración listos; módulos, base de datos y seguridad pendientes |
| Documentación (sección 3 y 8) | Mínima: falta casi todo |

## Hallazgos

| ID | Severidad | Hallazgo | Evidencia | Fase que lo resuelve |
|---|---|---|---|---|
| A-01 | Crítica | `vitest` 2.1.9 y `@vitest/coverage-v8` tenían vulnerabilidades críticas (`tinypool`, `vitest`) y alta (`vite`). | `npm audit` | **Resuelto en F1**: Vitest 5.0.4, 0 vulnerabilidades |
| A-02 | Media | `eslint` 9.39.5 aparecía como sin soporte en las advertencias de `npm ci`. | Salida de `npm ci` | **Resuelto en F1**: ESLint 10.12 |
| A-03 | Alta | Migraciones SQL inexistentes: `migrations/` está vacía. Sin ellas no hay tablas, RLS ni funciones. | Árbol de archivos | F3 |
| A-04 | Alta | Autenticación y autorización no implementadas (`autenticar.ts`, `autorizar.ts`). | Árbol de archivos | F4 |
| A-05 | Alta | Ningún endpoint de la sección 7 existe salvo `GET /salud`. | `src/modulos/*` vacíos | F5 a F8 |
| A-06 | Media | `GET /salud` responde `base: "pendiente"`; la especificación pide `base: "ok"` cuando la base responde. | `src/app.ts` | F3 |
| A-07 | Media | Límite de solicitudes no implementado, aunque `express-rate-limit` está instalado y las variables `LIMITE_*` existen. | `package.json`, `env.ts` | F9 y F8 |
| A-08 | Media | No existe `.github/workflows/ci.yml`, `render.yaml` ni `README.md`. | Árbol de archivos | F10 |
| A-09 | Media | Faltan documentos obligatorios: `decisiones-pendientes.md`, `pruebas-manuales.md`, `incidencias.md`. | `docs/` | F2 |
| A-10 | Baja | Se eliminó el script `migrar` porque no existía su archivo. Debe volver con las migraciones. | `package.json` | F3 |
| A-11 | Baja | Carpetas `src/modulos/*` y `tests/ayudas/` vacías. Git no las guarda sin archivos. | Árbol de archivos | Se llenan en cada fase |
| A-12 | Baja | `src/tipos/express.d.ts` es un marcador sin contenido. | Archivo | F4 |
| A-13 | Info | Cobertura de pruebas: solo salud y variables de entorno. Matriz de permisos, aislamiento de datos y auditoría no existen. | `tests/` | F4 a F9 |
| A-14 | Info | El repositorio Git tiene archivos en el índice (`git add`) pero ningún commit. | `git status` | Se decide al primer commit (requiere permiso) |
| A-15 | Info | La carpeta de Windows contiene `node_modules` instalado en el equipo. Es esperado y está ignorado por Git. | Listado del equipo | Ninguna |

## Verificación de que no hay basura

- No hay archivos sobrantes ni duplicados fuera de `node_modules`.
- No hay `.env` en el proyecto: correcto.
- La copia de Windows y la copia de la nube coinciden archivo por archivo (17 archivos).

## Estado tras la fase 1

- A-01 y A-02 resueltos. `npm audit`: 0 vulnerabilidades.
- Se detectó un cambio de requisito: Vitest 5 exige Node 22.12 o superior (ver D-10).
- La cobertura actual es 52 %. La meta de 70 % queda para la fase 11 (ver D-11).
