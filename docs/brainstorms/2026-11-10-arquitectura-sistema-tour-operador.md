# Arquitectura: sistema para tour operador (origin document)

Source: `docs/brainstorms/2026-11-10-arquitectura-sistema-tour-operador.pdf` (Claude Docs export, 2026-11-10, author: Kevin).
This is the raw text extracted from the PDF with macOS PDFKit. Table layouts were flattened by the extraction; the PDF is authoritative.

```text
PAGES 9
===== PAGE 1 =====
Arquitectura: sistema para tour operador
Arquitectura: sistema para tour operador
Nov 10, 2026 ·
@Kevin
Este plan parte de los requerimientos funcionales y los implementa como un sistema
multi-operador desde la primera versión.
Contexto y principios
La arquitectura cubre los requerimientos RES, DIS, GUI, AGE, P AG, FIN, CLI y MUL del
documento de requerimientos. Se parte de cuatro principios:
1. Un solo sistema para todos los operadores. No hay una copia del software por cliente.
2. T odo dato tiene un operador dueño. Ninguna consulta se hace sin filtrar por operador .
3. La automatización propone, una persona aprueba. Aplica a reservas con datos
dudosos y a liquidaciones de pago.
4. Lo que no se puede deshacer se registra. Cambios de reserva, montos y accesos
quedan en un registro de auditoría.

===== PAGE 2 =====
Arquitectura: sistema para tour operador
Vista general
Componentes del sistema: operadores arriba, servicios externos abajo
Los operadores entran por la aplicación web, y cada petición pasa por la API, que valida
operador y rol. Los correos y avisos se procesan en segundo plano; solo los trabajadores
llaman a servicios externos.
Aislamiento por operador
Cada operador es un tenant. El aislamiento se aplica en tres capas, para que un error en
una no exponga datos de otro operador:
Base de datos: todas las tablas de negocio tienen operador
id. La base usa
_
seguridad a nivel de fila (Row-Level Security en PostgreSQL), de modo que cada
consulta solo ve filas de los operadores a los que pertenece el usuario, según una
tabla de pertenencias (usuario, operador y rol), aunque el código olvide el filtro.

===== PAGE 3 =====
Arquitectura: sistema para tour operador
Aplicación: el operador se toma de la sesión autenticada, nunca de un parámetro que
envíe el cliente.
Secretos: las credenciales de cada operador (cuentas de Gmail, tokens de
GetY ourGuide, API de WhatsApp) se guardan cifradas y por operador . Ningún
operador las puede leer .
Las pruebas deben incluir casos donde un usuario de un operador intenta leer datos de
otro, y deben f allar .
Modelo de datos
T odas las entidades llevan operador
id, creado
_
_
en y actualizado
_
con dinero o estado también llevan un registro de auditoría.
en. Las entidades
Entidad Campos clave Relaciona con
Operador nombre, zona horaria, moneda, idioma,
política de cancelación, estado de
suscripción
Usuario correo, rol (administrador , reservas,
guía, contabilidad), guía
_
id opcional
Canal tipo (GetY ourGuide, Viator , WhatsApp,
directo), cuenta, estado de conexión
Correo recibido remitente, asunto, cuerpo original,
fecha, estado de procesamiento
T our nombre, duración, horarios, capacidad
máxima, precio por canal
Guía nombre, idiomas, especialidades, horas
máximas diarias
Usuario, Canal, T our , Guía
Operador , Guía
Operador , Reserva
Canal, Reserva
Operador , Asignación, Cupo
Operador , Asignación, Regla
de pago
Cliente nombre, contacto, idioma preferido Reserva
Reserva código externo, canal, tour , fecha,
personas, estado, datos incompletos
Canal, T our , Cliente,
Asignación
Cupo o bloqueo tour , fecha, capacidad usada, motivo del
bloqueo
T our

===== PAGE 4 =====
Arquitectura: sistema para tour operador
Entidad Campos clave Relaciona con
Asignación Regla de pago Liquidación Línea de
liquidación
P ago Auditoría reserva o tour , guía, fecha, horas,
confirmación del guía
guía, tipo (por tour , por día, por persona,
fijo), tarif a, vigencia desde
guía, período, total, estado (borrador ,
aprobada, pagada), aprobado por
liquidación, asignación realizada, tarif a
aplicada, monto
liquidación, monto, fecha, medio,
comprobante
usuario, acción, entidad, valor anterior ,
valor nuevo, fecha
Reserva, Guía
Guía
Guía, Línea de liquidación
Liquidación, Asignación
Liquidación
Cualquier entidad
La tarif a se copia en cada línea de liquidación al momento de calcularla. Así, un cambio
posterior no altera liquidaciones cerradas, como pide la regla de negocio 6.
Ingesta de correos
1. Recepción: el operador conecta su cuenta de Gmail con permiso de lectura. El
sistema recibe aviso de correos nuevos mediante notificaciones de Gmail, o consulta
cada pocos minutos si las notificaciones no están disponibles.
2. Guardado crudo: el correo se guarda tal cual llegó, antes de cualquier procesamiento.
Así se puede reprocesar si cambia el formato.
3. Filtro: solo pasan los correos de los remitentes de cada canal conectado. El resto se
descarta sin procesar .
4. Extracción: un modelo de lenguaje convierte el correo en un esquema fijo: código de
reserva, tour , fecha, hora, personas, cliente y tipo de evento (nueva, modificada o
cancelada).
5. Validación: el resultado se valida contra el esquema y contra los tours del operador . Si
f alta un campo obligatorio o la fecha no coincide con un tour , la reserva queda en
revisión.
6. Idempotencia: el código externo de reserva más el canal son únicos. Un correo
repetido actualiza la reserva existente y no crea otra.

===== PAGE 5 =====
Arquitectura: sistema para tour operador
7. Cupo: crear , modificar o cancelar una reserva actualiza el cupo dentro de la misma
transacción. Dos reservas simultáneas no pueden vender el último lugar .
8. Aviso: las reservas nuevas disparan la confirmación al cliente y el resumen al equipo,
según las reglas del operador .
Los correos de GetY ourGuide deben revisarse contra sus términos para proveedores
antes de automatizar la lectura en producción.
Stack recomendado
La base viene de la plantilla de Go Pesca, extraída de la rama develop el 2026-11-10. Lo
reutilizado se toma como patrón: no se copian el código de dominio ni las variables de
entorno. Dos decisiones se tomaron por defecto y se pueden cambiar: una base de
Supabase separada de Go Pesca, y una web responsive instalable (PW A) en lugar de una
app móvil con Expo para los guías.
Componente T ecnología Origen Motivo
W eb y API Next.js 16 con App
Router , T urbopack y
T ypeScript estricto
Monorepo npm workspaces:
apps/web,
apps/worker y
packages/shared
Base de datos,
sesiones y
archivos
Supabase: PostgreSQL,
Auth y Storage con RLS
Sesiones web @supabase/ssr con
middleware de
renovación
Estilos T ailwind v4 con tokens
en CSS y guía de diseño
Reutilizada de Go
Pesca
Base probada; la API
vive en rutas del
servidor
Reutilizada;
apps/worker es
nuevo
El trabajo de correos
corre fuera de las
funciones de V ercel
Reutilizada, en
proyecto separado
Aislamiento por
operador dentro de la
base
Reutilizada Sesiones por cookie
sin trabajo extra
Reutilizada; tokens
nuevos
Identidad propia con
la misma estructura
Idiomas next-intl con es y en Reutilizada Cubre MUL -08
Mapas Leaflet con react-leaflet Reutilizada,
opcional
Punto de encuentro
de cada tour

===== PAGE 6 =====
Arquitectura: sistema para tour operador
Componente T ecnología Origen Motivo
Compresión de
imágenes
Canvas en el cliente Agenda de guías W eb responsive
instalable (PW A)
T rabajos en
segundo plano
apps/worker en Node
con cola en PostgreSQL
Ingesta de
correos
API de Gmail con OAuth
por operador
Extracción de
datos
API de Claude con salida
en esquema fijo
Secretos de
canales
Almacén cifrado en el
servidor , por operador
Mensajes y
calendario
WhatsApp Business API
mediante proveedor;
Google Calendar
Pruebas Vitest para lógica pura;
pruebas de aislamiento
contra la base
Calidad y
revisión
ESLint 9, GitHub Actions
y revisión de PR con
Claude
Despliegue V ercel para la web;
servicio separado para
el worker
Reutilizada, a
revisar
Comprobantes más
livianos
Decisión nueva Evita Expo en la
primera versión; se
revisa si hace f alta
push
Nuevo Ingesta y avisos sin
límites de tiempo de
las funciones
Nuevo Cada operador
conecta su cuenta
Nuevo Lee correos de
formato variable
Nuevo La plantilla solo cifra
en el teléfono
Nuevo Canales que usan
clientes y guías
Reutilizada;
pruebas nuevas
V erifica que un
operador no ve datos
de otro
Reutilizada Mismo flujo de
trabajo
Reutilizada para la
web; nuevo para el
worker
El worker no es una
función sin servidor
Antes de crear el repositorio, lee la documentación de Next 16 en
node
_
modules/next/dist/docs/, como indica la plantilla. Las versiones de la tabla vienen
de la plantilla, que tiene partes cortadas; confírmalas en el repositorio real. Los
proveedores concretos de WhatsApp y de extracción se eligen en la f ase 2, con sus
precios y límites vigentes.

===== PAGE 7 =====
Arquitectura: sistema para tour operador
Seguridad y acceso
Autenticación: correo y contraseña con verificación en dos pasos para
administradores y contabilidad. Los guías entran con enlace de acceso.
Roles: los permisos se definen en el servidor por rol (administrador , reservas, guía,
contabilidad). Ocultar un botón en pantalla no cuenta como control de acceso.
Montos: los pagos y tarif as solo se ven en las pantallas de contabilidad y
administración. El guía ve únicamente su propio total aprobado.
Datos de clientes: nombre, correo y teléfono se muestran completos solo a quien
tiene un rol de reservas o administración.
Credenciales de canales: tokens de Gmail, GetY ourGuide y WhatsApp cifrados en
reposo, con rotación y revocación desde la app.
Respaldos: copias diarias de la base por operador , con prueba de restauración antes
de vender .
Auditoría: cambios de reserva, asignación, tarif as, liquidaciones y accesos de soporte
del proveedor quedan registrados.
Datos personales: se pide solo lo necesario, y cada operador puede exportarlo o
borrarlo.
Decisiones clave y riesgos
Decisión Riesgo que cubre Cuándo se revisa
Un solo sistema multi-
operador desde el inicio
Aislamiento de datos en la
base de datos, no solo en la
aplicación
Correo crudo guardado antes
de procesar
Extracción con validación y
revisión humana
T arif a copiada en cada línea
de liquidación
Reescribir todo al vender al
segundo operador
Una consulta mal escrita
expone datos de otro
operador
Cambios de formato en los
correos que pierdan
reservas
Reservas o pagos erróneos
por lectura incorrecta
Cambios de tarif a que
alteren pagos cerrados
No cambia; es la base
Antes de la primera venta
Siempre activo
Al medir la tasa de
corrección manual
Al diseñar la liquidación

===== PAGE 8 =====
Arquitectura: sistema para tour operador
Decisión Riesgo que cubre Cuándo se revisa
Cola de trabajos en
PostgreSQL
Dependencia de los correos
de GetY ourGuide
Complejidad operativa
temprana
Cambios de formato o de
condiciones del canal
Si pasa de cientos de
trabajos por minuto
Cada trimestre, y ante
cualquier f allo de
extracción
Riesgo principal: que la lectura automática de correos viole los términos de un canal.
Conviene confirmarlo por escrito con cada proveedor antes de vender el sistema a otros
operadores.
Antes de empezar
Trámites externos
Estos trámites tardan más que el desarrollo. Conviene iniciarlos en paralelo, sin esperar al
primer commit.
T rámite Qué hace f alta Cuándo
V erificación de Google para
Gmail
V erificación de WhatsApp
Business
Acceso a la API de Claude en
producción
Revisar los requisitos de alcance
restringido y preparar la aplicación
OAuth
V erificar el negocio, elegir proveedor y
aprobar las plantillas de mensajes
Clave en el entorno del servidor y
revisión de límites de uso
empezar
Y a, es el más
lento
Y a, en paralelo
Antes de la
f ase 2
Decisiones de base antes del primer commit
1. Aislamiento: una función de pertenencia se usa en todas las políticas de RLS. Las
pruebas de lectura cruzada entre operadores deben f allar .
2. Cola en PostgreSQL: bloqueo de filas con FOR UPDATE SKIP LOCKED y una clave de
idempotencia por correo. Sin Redis.
3. Dinero: montos en la unidad mínima con código de moneda. Nunca punto flotante.

===== PAGE 9 =====
Arquitectura: sistema para tour operador
4. Fechas: se guardan en UT C y se muestran en la zona horaria del operador .
5. Esquema de extracción: vive en packages/shared y se valida en la web y en el
worker .
6. Observabilidad: registro estructurado y monitoreo de errores desde el inicio, con el
correo y la etapa que f alló.
7. Archivos: comprobantes en almacenamiento privado, con URLs firmadas que
caducan.
Fuera de alcance tecnológico
Redis, Kubernetes, microservicios, un ORM, Expo y GraphQL. La primera versión no los
necesita.
Fases de entrega
Cada f ase termina con una condición verificable. No se avanza hasta cumplirla.
1. Base multi-operador. Operadores, usuarios, roles, tours, guías y reservas manuales
(MUL -01, MUL -02, MUL -06, DIS-01, GUI-01). Condición: las pruebas de aislamiento
entre operadores pasan.
2. Reservas y cupos. Ingesta de GetY ourGuide con revisión manual, calendario de
cupos, asignación de guías y agenda básica (RES-01 a RES-05, DIS-02 a DIS-04, GUI-02,
GUI-03, AGE-01). Condición: el operador piloto usa el sistema una semana completa
sin volver a su hoja de cálculo.
3. Pagos a guías. Reglas de pago, liquidación con aprobación y auditoría (P AG-01 a P AG-
03, regla 5 a 9). Condición: una liquidación real cuadra con el registro de tours.
4. Comunicación y reportes. Confirmaciones a clientes, recordatorios, avisos por clima,
reportes y exportación (CLI-02 a CLI-04, FIN-01, FIN-02, P AG-04, P AG-05). Condición:
los avisos salen sin errores durante un mes.
5. Preparación para venta. Alta automática de operadores, sincronización de cupos,
suscripciones y segundo idioma (MUL -07 a MUL -09, RES-06, DIS-05). Condición: un
operador ajeno al proyecto da de alta su cuenta sin ayuda.
La f ase 2 no puede leer correos reales de clientes hasta que la revisión de términos de los
canales esté confirmada por escrito.

```
