require('dotenv').config()
const twilio  = require('twilio')
const supabase = require('./supabase')

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const FROM = process.env.TWILIO_WHATSAPP_FROM

// ============================================================
//  ESTADO DE CONVERSACIONES
//  Guardamos en memoria el estado de cada usuario
//  (en producción esto va en Redis o Supabase)
// ============================================================
const sesiones = {}

function getSesion(numero) {
  if (!sesiones[numero]) {
    sesiones[numero] = { paso: 'inicio', datos: {} }
  }
  return sesiones[numero]
}

function resetSesion(numero) {
  sesiones[numero] = { paso: 'inicio', datos: {} }
}

// ============================================================
//  ENVIAR MENSAJE
// ============================================================
async function enviar(para, mensaje) {
  await client.messages.create({
    from: FROM,
    to:   `whatsapp:${para}`,
    body: mensaje
  })
}

// ============================================================
//  PROCESAR MENSAJE ENTRANTE
//  Esta función la llama el webhook de Twilio
// ============================================================
async function procesarMensaje(numero, texto, mediaUrl) {
  const msg     = texto.trim().toLowerCase()
  const sesion  = getSesion(numero)

  // ── MENÚ PRINCIPAL ──────────────────────────────────────
  if (sesion.paso === 'inicio' || msg === 'menu' || msg === 'hola') {
    resetSesion(numero)
    await enviar(numero,
      `🐾 *Bienvenido a PetTag*\n\n` +
      `¿Qué querés hacer?\n\n` +
      `1️⃣ Registrar una mascota\n` +
      `2️⃣ Reportar mascota encontrada\n` +
      `3️⃣ Ver mis mascotas\n\n` +
      `Respondé con el número de la opción.`
    )
    sesiones[numero].paso = 'menu'
    return
  }

  // ── SELECCIÓN DEL MENÚ ──────────────────────────────────
  if (sesion.paso === 'menu') {
    if (msg === '1') {
      sesiones[numero].paso    = 'reg_nombre'
      sesiones[numero].flujo   = 'registro'
      await enviar(numero, `📝 *Registrar mascota*\n\nPrimero necesito tus datos.\n\n¿Cuál es tu *nombre completo*?`)
      return
    }
    if (msg === '2') {
      sesiones[numero].paso  = 'avist_codigo'
      sesiones[numero].flujo = 'avistamiento'
      await enviar(numero, `📍 *Reportar mascota encontrada*\n\n¿Cuál es el *código del tag*? (Ej: PET-001)\n\nLo encontrás en el collar de la mascota.`)
      return
    }
    if (msg === '3') {
      await verMascotas(numero)
      return
    }
    await enviar(numero, `No entendí. Respondé *1*, *2* o *3*.`)
    return
  }

  // ════════════════════════════════════════════════════════
  //  FLUJO 1: REGISTRO DE MASCOTA
  // ════════════════════════════════════════════════════════

  if (sesion.flujo === 'registro') {

    // Paso 1: Nombre del dueño
    if (sesion.paso === 'reg_nombre') {
      sesiones[numero].datos.nombre = texto.trim()
      sesiones[numero].paso = 'reg_email'
      await enviar(numero, `Perfecto, *${texto.trim()}* 👋\n\n¿Cuál es tu *email*?`)
      return
    }

    // Paso 2: Email
    if (sesion.paso === 'reg_email') {
      if (!texto.includes('@')) {
        await enviar(numero, `Ese email no parece válido. Intentá de nuevo.\n\nEjemplo: juan@gmail.com`)
        return
      }
      sesiones[numero].datos.email = texto.trim()
      sesiones[numero].paso = 'reg_mascota_nombre'
      await enviar(numero, `✅ Email guardado.\n\nAhora los datos de tu mascota.\n\n¿Cómo se llama tu mascota?`)
      return
    }

    // Paso 3: Nombre de la mascota
    if (sesion.paso === 'reg_mascota_nombre') {
      sesiones[numero].datos.mascota_nombre = texto.trim()
      sesiones[numero].paso = 'reg_especie'
      await enviar(numero,
        `¿Qué tipo de animal es *${texto.trim()}*?\n\n` +
        `1️⃣ Perro\n` +
        `2️⃣ Gato\n` +
        `3️⃣ Otro`
      )
      return
    }

    // Paso 4: Especie
    if (sesion.paso === 'reg_especie') {
      const especies = { '1': 'perro', '2': 'gato', '3': 'otro' }
      const especie  = especies[msg]
      if (!especie) {
        await enviar(numero, `Respondé *1*, *2* o *3*.`)
        return
      }
      sesiones[numero].datos.especie = especie
      sesiones[numero].paso = 'reg_raza'
      await enviar(numero, `¿Cuál es la raza? (Si no sabés o es mestizo, escribí *mestizo*)`)
      return
    }

    // Paso 5: Raza
    if (sesion.paso === 'reg_raza') {
      sesiones[numero].datos.raza = texto.trim()
      sesiones[numero].paso = 'reg_sexo'
      await enviar(numero,
        `¿Cuál es el sexo?\n\n` +
        `1️⃣ Macho\n` +
        `2️⃣ Hembra`
      )
      return
    }

    // Paso 6: Sexo
    if (sesion.paso === 'reg_sexo') {
      const sexos = { '1': 'macho', '2': 'hembra' }
      const sexo  = sexos[msg]
      if (!sexo) {
        await enviar(numero, `Respondé *1* o *2*.`)
        return
      }
      sesiones[numero].datos.sexo = sexo
      sesiones[numero].paso = 'reg_codigo_qr'
      await enviar(numero, `¿Cuál es el *código del tag*? (Ej: PET-001)\n\nLo encontrás impreso en el collar.`)
      return
    }

    // Paso 7: Código QR
    if (sesion.paso === 'reg_codigo_qr') {
      const codigo = texto.trim().toUpperCase()

      // Verificar que el QR existe y está sin activar
      const { data: qr } = await supabase
        .from('qr_codes')
        .select('*')
        .eq('codigo', codigo)
        .single()

      if (!qr) {
        await enviar(numero, `❌ No encontré el código *${codigo}*. Verificá que esté bien escrito.\n\nEjemplo: PET-001`)
        return
      }

      if (qr.estado !== 'sin_activar') {
        await enviar(numero, `⚠️ Este tag ya fue activado previamente.\n\nSi sos el dueño escribí *menu* para ver tus mascotas.`)
        return
      }

      sesiones[numero].datos.codigo_qr = codigo
      sesiones[numero].datos.qr_id     = qr.id
      sesiones[numero].paso = 'reg_foto'
      await enviar(numero,
        `✅ Tag *${codigo}* encontrado.\n\n` +
        `Opcional: enviá una *foto* de tu mascota para que aparezca en la ficha.\n\n` +
        `O escribí *saltar* para continuar sin foto.`
      )
      return
    }

    // Paso 8: Foto (opcional)
    if (sesion.paso === 'reg_foto') {
      if (mediaUrl) {
        sesiones[numero].datos.foto_url = mediaUrl
      }
      sesiones[numero].paso = 'reg_confirmar'

      const d = sesiones[numero].datos
      const emojis = { perro: '🐕', gato: '🐈', otro: '🐾' }
      await enviar(numero,
        `📋 *Confirmá los datos:*\n\n` +
        `👤 Dueño: ${d.nombre}\n` +
        `📧 Email: ${d.email}\n` +
        `${emojis[d.especie]} Mascota: ${d.mascota_nombre}\n` +
        `🐾 Especie: ${d.especie}\n` +
        `🔍 Raza: ${d.raza}\n` +
        `⚥ Sexo: ${d.sexo}\n` +
        `🏷️ Tag: ${d.codigo_qr}\n\n` +
        `¿Todo correcto?\n\n` +
        `✅ Escribí *confirmar*\n` +
        `❌ Escribí *cancelar* para empezar de nuevo`
      )
      return
    }

    // Paso 9: Confirmar
    if (sesion.paso === 'reg_confirmar') {
      if (msg === 'cancelar') {
        resetSesion(numero)
        await enviar(numero, `❌ Registro cancelado. Escribí *menu* para empezar de nuevo.`)
        return
      }

      if (msg !== 'confirmar') {
        await enviar(numero, `Escribí *confirmar* para guardar o *cancelar* para empezar de nuevo.`)
        return
      }

      await enviar(numero, `⏳ Guardando datos...`)

      const d = sesiones[numero].datos

      // 1. Crear dueño
      const { data: dueno, error: duenError } = await supabase
        .from('duenos')
        .insert({
          nombre_completo: d.nombre,
          email:           d.email,
          whatsapp:        numero
        })
        .select()
        .single()

      if (duenError && duenError.code !== '23505') {
        await enviar(numero, `❌ Error al guardar: ${duenError.message}`)
        return
      }

      // Si ya existía el dueño, buscarlo
      let duenId = dueno?.id
      if (!duenId) {
        const { data: duenExiste } = await supabase
          .from('duenos')
          .select('id')
          .eq('email', d.email)
          .single()
        duenId = duenExiste?.id
      }

      // 2. Crear mascota
      const { data: mascota, error: mascError } = await supabase
        .from('mascotas')
        .insert({
          dueno_id:          duenId,
          qr_id:             d.qr_id,
          nombre:            d.mascota_nombre,
          especie:           d.especie,
          raza:              d.raza,
          sexo:              d.sexo,
          foto_principal_url: d.foto_url || null
        })
        .select()
        .single()

      if (mascError) {
        await enviar(numero, `❌ Error al guardar la mascota: ${mascError.message}`)
        return
      }

      // 3. Activar QR
      await supabase
        .from('qr_codes')
        .update({ estado: 'activo', mascota_id: mascota.id, activado_en: new Date() })
        .eq('id', d.qr_id)

      // 4. Crear perfil médico vacío
      await supabase
        .from('perfiles_medicos')
        .insert({ mascota_id: mascota.id })

      resetSesion(numero)
      await enviar(numero,
        `🎉 *¡${d.mascota_nombre} está registrado/a!*\n\n` +
        `El tag *${d.codigo_qr}* ya está activo. Cuando alguien lo escanee, verá la ficha de ${d.mascota_nombre}.\n\n` +
        `Podés ver la ficha en:\n` +
        `https://flatware-smoked-vertigo.ngrok-free.dev/mascota/${d.codigo_qr}\n\n` +
        `Escribí *menu* para hacer más cosas.`
      )
      return
    }
  }

  // ════════════════════════════════════════════════════════
  //  FLUJO 2: AVISTAMIENTO
  // ════════════════════════════════════════════════════════

  if (sesion.flujo === 'avistamiento') {

    // Paso 1: Código del tag
    if (sesion.paso === 'avist_codigo') {
      const codigo = texto.trim().toUpperCase()

      const { data: qr } = await supabase
        .from('qr_codes')
        .select('*, mascotas(*)')
        .eq('codigo', codigo)
        .single()

      if (!qr || qr.estado !== 'activo') {
        await enviar(numero, `❌ No encontré el tag *${codigo}*. Verificá que esté bien escrito.`)
        return
      }

      sesiones[numero].datos.mascota_id    = qr.mascota_id
      sesiones[numero].datos.mascota_nombre = qr.mascotas?.nombre || 'la mascota'
      sesiones[numero].paso = 'avist_tipo'

      await enviar(numero,
        `✅ Encontré a *${qr.mascotas?.nombre}* (${qr.mascotas?.raza || qr.mascotas?.especie})\n\n` +
        `¿Cuál es tu situación?\n\n` +
        `1️⃣ La encontré — la tengo conmigo\n` +
        `2️⃣ La estoy viendo ahora\n` +
        `3️⃣ La tengo resguardada en un lugar seguro`
      )
      return
    }

    // Paso 2: Tipo de reporte
    if (sesion.paso === 'avist_tipo') {
      const tipos = {
        '1': 'la_encontre',
        '2': 'la_estoy_viendo',
        '3': 'la_tengo_segura'
      }
      const tipo = tipos[msg]
      if (!tipo) {
        await enviar(numero, `Respondé *1*, *2* o *3*.`)
        return
      }
      sesiones[numero].datos.tipo_reporte = tipo
      sesiones[numero].paso = 'avist_ubicacion'
      await enviar(numero,
        `📍 ¿En qué dirección o zona la encontraste?\n\n` +
        `Ejemplo: "Gurruchaga y Honduras, Palermo" o mandá tu *ubicación* por WhatsApp.`
      )
      return
    }

    // Paso 3: Ubicación
    if (sesion.paso === 'avist_ubicacion') {
      sesiones[numero].datos.direccion = texto.trim()
      sesiones[numero].paso = 'avist_foto'
      await enviar(numero,
        `📸 Opcional: enviá una *foto* de la mascota.\n\n` +
        `O escribí *saltar* para continuar sin foto.`
      )
      return
    }

    // Paso 4: Foto
    if (sesion.paso === 'avist_foto') {
      if (mediaUrl) sesiones[numero].datos.foto_url = mediaUrl
      sesiones[numero].paso = 'avist_mensaje'
      await enviar(numero,
        `💬 ¿Querés dejar un *mensaje* para el dueño?\n\n` +
        `O escribí *saltar* para omitir.`
      )
      return
    }

    // Paso 5: Mensaje
    if (sesion.paso === 'avist_mensaje') {
      if (msg !== 'saltar') sesiones[numero].datos.mensaje = texto.trim()
      sesiones[numero].paso = 'avist_telefono'
      await enviar(numero, `📞 ¿Cuál es tu número de teléfono para que el dueño te contacte? (O escribí *saltar*)`)
      return
    }

    // Paso 6: Teléfono y guardar
    if (sesion.paso === 'avist_telefono') {
      if (msg !== 'saltar') sesiones[numero].datos.telefono = texto.trim()

      const d = sesiones[numero].datos

      const { error } = await supabase
        .from('avistamientos')
        .insert({
          mascota_id:          d.mascota_id,
          tipo_reporte:        d.tipo_reporte,
          latitud:             -34.6037,   // Por ahora fijo — en producción parsear ubicación de WA
          longitud:            -58.3816,
          direccion_aproximada: d.direccion,
          nombre_rescatista:   `WhatsApp ${numero}`,
          telefono_rescatista: d.telefono || numero,
          mensaje:             d.mensaje || null,
          foto_url:            d.foto_url || null
        })

      if (error) {
        await enviar(numero, `❌ Error al guardar: ${error.message}`)
        return
      }

      // Notificar al dueño (próxima versión con email/push)

      resetSesion(numero)
      await enviar(numero,
        `🎉 *¡Reporte enviado!*\n\n` +
        `El dueño de *${d.mascota_nombre}* fue notificado con tu reporte.\n\n` +
        `¡Gracias por ayudar a que vuelva a casa! 🏠\n\n` +
        `Escribí *menu* para hacer más cosas.`
      )
      return
    }
  }

  // ── VER MIS MASCOTAS ────────────────────────────────────
  if (msg === 'menu') {
    resetSesion(numero)
    sesiones[numero].paso = 'menu'
    await enviar(numero,
      `🐾 *Menú PetTag*\n\n` +
      `1️⃣ Registrar una mascota\n` +
      `2️⃣ Reportar mascota encontrada\n` +
      `3️⃣ Ver mis mascotas\n\n` +
      `Respondé con el número.`
    )
    return
  }

  // Mensaje no reconocido
  await enviar(numero, `No entendí ese mensaje. Escribí *menu* para ver las opciones.`)
}

// ── VER MASCOTAS ─────────────────────────────────────────────
async function verMascotas(numero) {
  const { data: dueno } = await supabase
    .from('duenos')
    .select('id, nombre_completo')
    .eq('whatsapp', numero)
    .single()

  if (!dueno) {
    await enviar(numero, `No encontré una cuenta asociada a este número.\n\nEscribí *1* para registrar tu primera mascota.`)
    return
  }

  const { data: mascotas } = await supabase
    .from('mascotas')
    .select('nombre, especie, estado_actual, qr_codes(codigo)')
    .eq('dueno_id', dueno.id)

  if (!mascotas || mascotas.length === 0) {
    await enviar(numero, `Todavía no tenés mascotas registradas. Escribí *1* para agregar una.`)
    return
  }

  const emojis = { perro: '🐕', gato: '🐈', otro: '🐾' }
  const estados = { en_casa: '✅ En casa', perdido: '🚨 Perdido', en_cuidado: '🏠 En cuidado', fallecido: '🕊️' }

  let msg = `🐾 *Tus mascotas, ${dueno.nombre_completo}:*\n\n`
  mascotas.forEach((m, i) => {
    msg += `${i + 1}. ${emojis[m.especie] || '🐾'} *${m.nombre}* — ${estados[m.estado_actual] || m.estado_actual}\n`
    if (m.qr_codes?.codigo) msg += `   Tag: ${m.qr_codes.codigo}\n`
  })
  msg += `\nEscribí *menu* para más opciones.`

  await enviar(numero, msg)
  resetSesion(numero)
}

module.exports = { procesarMensaje }
