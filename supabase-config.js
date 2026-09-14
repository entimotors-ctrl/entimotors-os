/* ============================================================================
 * ENTIMOTORS OS · Configuración de Supabase para el navegador
 * ----------------------------------------------------------------------------
 * Generado a partir de supabase-config.example.js.
 *
 * La clave de abajo es la ANON / PUBLISHABLE KEY: es pública por diseño y por
 * sí sola no da acceso a nada. Quien decide qué puede ver y hacer cada persona
 * son las políticas RLS de la base. Sin sesión iniciada no deja leer ni un
 * cliente — comprobado contra el proyecto real.
 *
 * ⛔ Aquí NUNCA va la service_role. supabase-client.js la detecta y se niega
 *    a arrancar. La de servidor vive solo en api-server/.env.
 * ==========================================================================*/

window.ENTIMOTORS_SUPABASE = {

  url: "https://pnpbtezzdomrthvqvsui.supabase.co",

  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBucGJ0ZXp6ZG9tcnRodnF2c3VpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzMjI0MzIsImV4cCI6MjA4OTg5ODQzMn0.a1rqyRaMt-XE-Ilve6kLo-HSjMPZPBfyXgsz3EHDy7c",

  habilitado: true,

  // Dirección del api-server (el backend que ya existe). Solo se usa para
  // la pantalla «Usuarios y equipo»: crear cuentas exige la clave de
  // servidor, y esa clave no puede pisar el navegador.
  // Sin este valor, esa pantalla avisa y el resto de la app va igual.
  apiUrl: ""   // ej. "https://<tu-servicio>.onrender.com"
};
