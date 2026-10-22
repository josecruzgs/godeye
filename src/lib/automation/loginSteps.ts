type Step = { action: string; selector?: string; value?: string; url?: string; key?: string; ms?: number; optional?: boolean };

// AdsPower autocompleta usuario/contraseña cuando detecta la barra de login
// de Facebook (el perfil ya la tiene guardada), pero NO manda el formulario
// solo — se queda ahí sentado con los campos llenos hasta que alguien le da
// clic a "Iniciar sesión". Si la sesión de la cuenta se invalidó (típico
// cuando el proxy cambia de IP entre aperturas), cualquier tarea que
// navegue se topa con esa barra ya rellenada y el selector que esté
// buscando (botón de like, caja de comentario, etc.) simplemente no existe
// todavía — de ahí muchos de los "success" falsos o fallos silenciosos.
// `button[name="login"]` es el botón real del formulario clásico de
// Facebook, estable desde hace años. Optional porque si ya hay sesión
// iniciada este paso no encuentra nada y no debe romper la tarea.
//
// En Facebook el runner no clickea este selector tal cual: lo toma como la
// señal para `ensureFacebookSession`, que mira la cookie de sesión, prueba
// también la pantalla de "cuenta guardada" y corta la tarea con un mensaje
// claro si no logra entrar. Así lo aprovechan también las tareas ya creadas.
export function loginIfNeededSteps(): Step[] {
  return [
    { action: "click", selector: 'button[name="login"]', optional: true, ms: 4000 },
    { action: "waitForTimeout", ms: 2000 },
  ];
}
