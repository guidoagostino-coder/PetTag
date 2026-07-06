require('dotenv').config()
const express  = require('express')
const cors     = require('cors')
const path     = require('path')
const supabase = require('./supabase')
const whatsappBot = require('./whatsapp')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

// ============================================================
//  HEALTH CHECK
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'))
})

app.get('/health', (req, res) => {
  res.json({ ok: true, mensaje: 'PetTag API corriendo 🐾' })
})

// ============================================================
//  SERVIR HTML cuando accede un navegador
// ============================================================
app.get('/mascota/:codigo', (req, res, next) => {
  const accept = req.headers['accept'] || ''
  if (accept.includes('text/html')) {
    return res.sendFile(path.join(__dirname, 'ficha.html'))
  }
  next()
})

// ============================================================
//  QR — Escaneo principal (API JSON)
//  GET /mascota/:codigo
// ============================================================
app.get('/mascota/:codigo', async (req, res) => {
  const { codigo } = req.params

  const { data: qr, error: qrError } = await supabase
    .from('qr_codes')
    .select('*')
    .eq('codigo', codigo.toUpperCase())
    .single()

  if (qrError || !qr) {
    return res.status(404).json({ error: 'QR no encontrado', codigo })
  }

  if (qr.estado === 'sin_activar') {
    return res.json({
      estado: 'sin_activar',
      codigo: qr.codigo,
      mensaje: 'Este tag todavía no tiene mascota. Registrate para activarlo.'
    })
  }

  // Traer mascota
  const { data: mascota } = await supabase
    .from('mascotas')
    .select('*')
    .eq('id', qr.mascota_id)
    .single()

  if (!mascota) {
    return res.status(500).json({ error: 'QR activo pero sin mascota asociada' })
  }

  // Traer perfil médico
  const { data: medico } = await supabase
    .from('perfiles_medicos')
    .select('*')
    .eq('mascota_id', mascota.id)
    .single()

  // Traer contactos extra
  const { data: contactos } = await supabase
    .from('contactos_extra')
    .select('*')
    .eq('mascota_id', mascota.id)
    .order('creado_en', { ascending: true })

  // Si está perdida, traer avistamientos
  let avistamientos = []
  if (mascota.estado_actual === 'perdido') {
    const { data: av } = await supabase
      .from('avistamientos')
      .select('*')
      .eq('mascota_id', mascota.id)
      .order('creado_en', { ascending: false })
      .limit(10)
    avistamientos = av || []
  }

  return res.json({
    estado: mascota.estado_actual,
    mascota,
    medico:        medico    || null,
    contactos:     contactos || [],
    avistamientos
  })
})

// ============================================================
//  DUEÑOS — Registro
//  POST /duenos/registro
// ============================================================
app.post('/duenos/registro', async (req, res) => {
  const { nombre_completo, email, telefono, whatsapp } = req.body

  if (!nombre_completo || !email) {
    return res.status(400).json({ error: 'Nombre y email son obligatorios' })
  }

  const { data, error } = await supabase
    .from('duenos')
    .insert({ nombre_completo, email, telefono, whatsapp })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese email' })
    }
    return res.status(500).json({ error: error.message })
  }

  res.status(201).json({ ok: true, dueno: data })
})

// ============================================================
//  MASCOTAS — Crear y vincular al QR
//  POST /mascotas
// ============================================================
app.post('/mascotas', async (req, res) => {
  const {
    dueno_id, codigo_qr,
    nombre, especie, raza, sexo,
    fecha_nacimiento, color, peso_kg, estado_reproductivo
  } = req.body

  if (!dueno_id || !nombre || !especie) {
    return res.status(400).json({ error: 'dueno_id, nombre y especie son obligatorios' })
  }

  const { data: qr, error: qrError } = await supabase
    .from('qr_codes')
    .select('*')
    .eq('codigo', codigo_qr.toUpperCase())
    .single()

  if (qrError || !qr) return res.status(404).json({ error: 'QR no encontrado' })
  if (qr.estado !== 'sin_activar') return res.status(409).json({ error: 'Este QR ya está activado' })

  const { data: mascota, error: mascotaError } = await supabase
    .from('mascotas')
    .insert({
      dueno_id, qr_id: qr.id,
      nombre, especie, raza, sexo,
      fecha_nacimiento, color, peso_kg, estado_reproductivo
    })
    .select()
    .single()

  if (mascotaError) return res.status(500).json({ error: mascotaError.message })

  await supabase
    .from('qr_codes')
    .update({ estado: 'activo', mascota_id: mascota.id, activado_en: new Date() })
    .eq('id', qr.id)

  await supabase
    .from('perfiles_medicos')
    .insert({ mascota_id: mascota.id })

  res.status(201).json({ ok: true, mascota })
})

// ============================================================
//  MASCOTAS — Obtener todas las del dueño
//  GET /duenos/:dueno_id/mascotas
// ============================================================
app.get('/duenos/:dueno_id/mascotas', async (req, res) => {
  const { dueno_id } = req.params

  const { data, error } = await supabase
    .from('mascotas')
    .select('*, qr_codes(codigo)')
    .eq('dueno_id', dueno_id)
    .order('creado_en', { ascending: true })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ============================================================
//  MASCOTAS — Actualizar datos
//  PATCH /mascotas/:id
// ============================================================
app.patch('/mascotas/:id', async (req, res) => {
  const { id } = req.params

  const { data, error } = await supabase
    .from('mascotas')
    .update(req.body)
    .eq('id', id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true, mascota: data })
})

// ============================================================
//  MASCOTAS — Reportar perdida
//  POST /mascotas/:id/perdida
// ============================================================
app.post('/mascotas/:id/perdida', async (req, res) => {
  const { id } = req.params
  const { ultima_ubicacion_conocida, recompensa, instrucciones_especiales } = req.body

  const { data, error } = await supabase
    .from('mascotas')
    .update({
      estado_actual: 'perdido',
      perdido_desde: new Date(),
      ultima_ubicacion_conocida,
      recompensa,
      instrucciones_especiales
    })
    .eq('id', id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true, mascota: data })
})

// ============================================================
//  MASCOTAS — Marcar como encontrada
//  POST /mascotas/:id/encontrada
// ============================================================
app.post('/mascotas/:id/encontrada', async (req, res) => {
  const { id } = req.params

  const { data, error } = await supabase
    .from('mascotas')
    .update({
      estado_actual: 'en_casa',
      perdido_desde: null,
      recompensa:    null
    })
    .eq('id', id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true, mascota: data })
})

// ============================================================
//  AVISTAMIENTOS — Reportar ubicación
//  POST /avistamientos
// ============================================================
app.post('/avistamientos', async (req, res) => {
  const {
    mascota_id, tipo_reporte,
    latitud, longitud, direccion_aproximada,
    nombre_rescatista, telefono_rescatista,
    mensaje, foto_url
  } = req.body

  if (!mascota_id || !tipo_reporte || !latitud || !longitud) {
    return res.status(400).json({ error: 'mascota_id, tipo_reporte, latitud y longitud son obligatorios' })
  }

  const { data, error } = await supabase
    .from('avistamientos')
    .insert({
      mascota_id, tipo_reporte,
      latitud, longitud, direccion_aproximada,
      nombre_rescatista, telefono_rescatista,
      mensaje, foto_url
    })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })

  // Notificar al dueño por WhatsApp
  const { data: mascota } = await supabase
    .from('mascotas')
    .select('nombre, dueno_id')
    .eq('id', mascota_id)
    .single()

  if (mascota) {
    const { data: dueno } = await supabase
      .from('duenos')
      .select('whatsapp, nombre_completo')
      .eq('id', mascota.dueno_id)
      .single()

    if (dueno?.whatsapp) {
      const tipoLabel = {
        la_encontre:      '🐾 La encontró',
        la_estoy_viendo:  '👁️ La está viendo',
        la_tengo_segura:  '🔒 La tiene resguardada'
      }
      await whatsappBot.enviar(dueno.whatsapp,
        `🚨 *¡Encontraron a ${mascota.nombre}!*\n\n` +
        `*Tipo:* ${tipoLabel[tipo_reporte]}\n` +
        `*Dirección:* ${direccion_aproximada || 'No especificada'}\n` +
        `*Rescatista:* ${nombre_rescatista || 'Anónimo'}\n` +
        `*Teléfono:* ${telefono_rescatista || 'No dejó'}\n` +
        `*Mensaje:* ${mensaje || 'Sin mensaje'}\n\n` +
        `Entrá a tu panel para ver el mapa con la ubicación exacta.`
      )
    }
  }

  res.status(201).json({ ok: true, avistamiento: data })
})

// ============================================================
//  SALUD — Registrar vacuna / desparasitación
//  POST /mascotas/:id/salud
// ============================================================
app.post('/mascotas/:id/salud', async (req, res) => {
  const { id } = req.params
  const { tipo, nombre, fecha_aplicacion, proxima_fecha, veterinario, notas } = req.body

  const { data, error } = await supabase
    .from('registros_salud')
    .insert({ mascota_id: id, tipo, nombre, fecha_aplicacion, proxima_fecha, veterinario, notas })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json({ ok: true, registro: data })
})

// ============================================================
//  SALUD — Obtener registros de una mascota
//  GET /mascotas/:id/salud
// ============================================================
app.get('/mascotas/:id/salud', async (req, res) => {
  const { id } = req.params

  const { data, error } = await supabase
    .from('registros_salud')
    .select('*')
    .eq('mascota_id', id)
    .order('fecha_aplicacion', { ascending: false })

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ============================================================
//  PESO — Registrar
//  POST /mascotas/:id/peso
// ============================================================
app.post('/mascotas/:id/peso', async (req, res) => {
  const { id } = req.params
  const { peso_kg, fecha, notas } = req.body

  const { data, error } = await supabase
    .from('historial_peso')
    .insert({ mascota_id: id, peso_kg, fecha, notas })
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.status(201).json({ ok: true, registro: data })
})

// ============================================================
//  PERFIL MÉDICO — Actualizar
//  PATCH /mascotas/:id/medico
// ============================================================
app.patch('/mascotas/:id/medico', async (req, res) => {
  const { id } = req.params

  const { data, error } = await supabase
    .from('perfiles_medicos')
    .update(req.body)
    .eq('mascota_id', id)
    .select()
    .single()

  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true, medico: data })
})

// ============================================================
//  RECORDATORIOS — Vacunas próximas
//  GET /recordatorios/proximos
// ============================================================
app.get('/recordatorios/proximos', async (req, res) => {
  const { data, error } = await supabase
    .from('vacunas_proximas')
    .select('*')

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ============================================================
//  COMUNIDAD — Mascotas perdidas
//  GET /comunidad/perdidas
// ============================================================
app.get('/comunidad/perdidas', async (req, res) => {
  const { data, error } = await supabase
    .from('mascotas_perdidas')
    .select('*')

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ============================================================
//  WEBHOOK WHATSAPP
//  POST /whatsapp
// ============================================================
app.post('/whatsapp', async (req, res) => {
  console.log('📱 WhatsApp recibido:', JSON.stringify(req.body))

  const numero   = req.body.From?.replace('whatsapp:', '')
  const texto    = req.body.Body || ''
  const mediaUrl = req.body.MediaUrl0 || null

  res.status(200).send('<Response></Response>')

  if (!numero) {
    console.log('⚠️ Número no encontrado en el body')
    return
  }

  await whatsappBot.procesarMensaje(numero, texto, mediaUrl)
})

// ============================================================
//  START
// ============================================================
const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`🐾 PetTag API corriendo en http://localhost:${PORT}`)
})
