/* ============================================================================
 * ENTIMOTORS OS · build-target.js — QUÉ PRODUCTO ES ESTA COPIA
 * ----------------------------------------------------------------------------
 * ENTIMOTORS se publica como DOS aplicaciones en DOS ORIGINS distintos:
 *
 *   "admin"     el taller de siempre. Conserva entimotors_os_demo, el login
 *               local de la lista TEAM y la operación completa.
 *   "mecanico"  «Mi Trabajo». Solo cuentas de Supabase con rol mecánico y
 *               perfil activo. Sin login local, sin base del taller.
 *
 * Este archivo lo decide el BUILD, no el usuario: la variante de mecánicos se
 * genera con hacer-build-mecanicos.sh, que superpone su propia copia. No se
 * mira la URL, ni localStorage, ni sessionStorage — un valor que el visitante
 * pueda cambiar no sirve para decidir qué producto es.
 *
 * OJO CON LO QUE ESTE ARCHIVO **NO** ES
 *   No es una frontera de seguridad. Quien abra la consola puede reescribir
 *   window.ENTIMOTORS_BUILD y saltárselo. Las fronteras de verdad son dos, y
 *   ninguna vive en el navegador: el ORIGIN (que el navegador sí impone, y por
 *   eso las dos apps van en hostnames distintos) y las políticas RLS de la
 *   base. Esto solo decide qué producto se arma.
 *
 * Sin este archivo se asume "admin", que es la operación histórica: un
 * despliegue incompleto deja el taller como estaba, no abre nada nuevo.
 * ==========================================================================*/
window.ENTIMOTORS_BUILD = { producto: "admin" };
