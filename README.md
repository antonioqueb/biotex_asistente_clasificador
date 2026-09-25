# Clasificador Global (`biotex_asistente_clasificador`)

Variante del **Clasificador por Grupos** (antes "Asistente de clasificación") de `biotex_catalog` para Odoo 19. Misma sesión persistente, mismo
modal de edición, misma galería de imágenes y mismo contador de folios; cambia el punto en que se genera el folio.

| | Clasificador por Grupos (`biotex_catalog`) | Clasificador Global (este módulo) |
|---|---|---|
| Paso 1 | Grupo + Familia + Clasificador + Marca | Grupo + Familia + Clasificador (llave base `GG-FFF-CCC`) |
| Folio | Se reserva al agregar el producto | Se reserva al **confirmar la marca** de cada producto (llave exacta `GG-FFF-CCC-MMMM`) |
| Paso 2 | Producto / Referencia / Marca / +Agregar | Badges de catálogo y sesión, código pendiente `GG-FFF-CCC-????-??`; **Agregar** por fila (sin abrir el modal) y **Nuevo** en el encabezado. Enter y lector agregan igual |
| Marca | En la sesión | En el modal de edición, con alta rápida y catálogo releído en cada apertura; al guardar, si la raíz (grupo, familia, clasificador) del folio ya no es la de la sesión, exige reservar folio nuevo |
| Paso 3 | Tabla editable con arrastre | Todos los productos de la sesión: pendientes de marca primero, clasificados por marca y folio, refrescado en vivo; **Editar** abre el modal (marca, folio, fotos, datos) y **Quitar** libera un pendiente |
| Cierre | Guardar y salir conserva todo el borrador | **Guardar y salir** y **Generar claves** liberan de la sesión los productos sin marca ni folio (previa confirmación); conservan los datos que tienen en el catálogo |
| Modal: unidades | Unidad indivisible y empacados en dos secciones | Una tabla «Unidades y empaques»: contenido de la unidad base editable, descripción calculada «BOLSA CON 3» y empacados como multiplicadores de la unidad base |

Ambos asistentes conviven: una sesión con `brand_per_line` pertenece a este; el resto sigue igual. Menú:
**Catálogo → Clasificador Global** (también en Inventario → Control de inventario).

Detalle funcional, decisiones tomadas sobre los puntos abiertos y casos de prueba: [`docs/asistente-clasificador.md`](docs/asistente-clasificador.md).

## Agregar en el paso 2, editar en el paso 3 — 19.0.1.6.0

Cambio pedido por el cliente el 25/09/2026. El paso 2 ya no edita: cada resultado tiene **Agregar**, que
incorpora el producto a la sesión con la marca pendiente (`workspace_add_products`, el mismo alta que el
Clasificador por Grupos) sin abrir el modal; Enter y el lector agregan igual y un producto ya agregado se
muestra como **Agregado**. El paso 3 lista **todos** los productos de la sesión, pendientes de marca primero y
después por marca y folio; **Editar** abre el modal donde se confirma la marca (reserva el folio), se suben
fotos y se completan los datos, y **Quitar** saca de la sesión un pendiente. Al abrir una sesión con productos
se entra directo al paso 3.

Validación nueva: si un producto se agregó pero no se le confirmó la marca (sin folio), **Guardar y salir** y
**Generar claves** lo **liberan** de la sesión (`clasificador_release_pending`) después de un diálogo que lista
los productos afectados. Como nada se escribe en la ficha hasta confirmar, el producto queda en el catálogo
exactamente como está hoy (misma clave, nombre y datos) y deja de aparecer «En clasificación». Las líneas con
marca y folio no se tocan; el servidor sigue rechazando generar claves con pendientes si se fuerza por RPC.
`clasificador_edit_product` se conserva (agrega y devuelve la línea) por compatibilidad.

Validación local: `tests/workspace_templates.cjs` en verde (node 24, jsdom 24, OWL de Odoo 19); Python
compilado y XML analizado. Se agregó `test_release_pending_frees_products_and_keeps_classified_lines` a
`tests/test_clasificador.py` para ejecutarse en Odoo. Solo cambia código y plantillas: `-u` sin migración de datos.

## Revisión manual — 19.0.1.5.0

El paso 2 muestra **Revisado / Pendiente de revisar**, con un selector para filtrar
ambos estados. Dirección o un **Revisor de catálogo** pueden marcar o desmarcar
directamente el producto con un clic. La revisión se guarda inmediatamente en
`product.template.biotex_reviewed`, independientemente del estado verde de clasificación;
no aplica los cambios pendientes de una sesión ni genera una bitácora adicional.

Requiere actualizar conjuntamente **biotex_catalog 19.0.3.8.0**. La casilla también se
encuentra en la ficha del producto, **Clasificación → Revisión manual**, y en los filtros
nativos del catálogo. Reglas, permisos y pruebas: `biotex_catalog/docs/revision-productos.md`.
La promoción de esta entrega a producción fue autorizada el 23/09/2026.
El estado se documenta en `evidence/production-all-20260923/README.md` del proyecto BIOTECH;
la validación local no acredita instalación remota.

## Alta de productos — 19.0.1.4.0

**Nuevo** se habilita con la misma llave base completa de la sección 1. Abre el editor compartido
con los datos vacíos, título verde «Nuevo producto», ícono de crear y badge «NUEVO». La referencia
pendiente conserva los colores de grupo, familia y clasificador; confirmar la marca reserva el folio.

**Guardar crea el producto inmediatamente** con todos los datos capturados y lo incorpora a la sección 3.
Se aplican automáticamente Bienes (`type=consu`), inventario activo (`is_storable=True`), lotes
(`tracking=lot`), facturación por cantidad ordenada (`invoice_policy=order`), compras y ventas activas.
El Chatter registra nombre, categoría (grupo/familia/clasificador), referencia, unidad, usuario y fecha UTC.
La creación usa los permisos del usuario y una transacción que revierte el alta si falla cualquier detalle.
Un reintento sobre el mismo borrador devuelve el producto creado sin duplicarlo ni repetir la nota de alta.

Cerrar sin guardar elimina únicamente el borrador de alta; las reservas consumidas no se reutilizan.
Si se cierra la pestaña del navegador, el borrador puede retomarse con **Continuar alta** en la sección 3.
Las altas guardadas permanecen en el catálogo aunque después se descarte la sesión. Sus detalles se pueden
seguir editando en la sección 3; las ediciones posteriores se aplican al generar claves, como en el flujo habitual.

Esta versión requiere actualizar el módulo: agrega `new_product` a las líneas y permite `product_id` vacío
únicamente para los borradores de alta. Se declara la dependencia **sale**, que proporciona `invoice_policy`
en Odoo 19 ([fuente oficial](https://github.com/odoo/odoo/blob/19.0/addons/sale/models/product_template.py)).
En una base de desarrollo, con los addons disponibles:

```sh
odoo-bin -d BASE_DEV -i sale -u biotex_asistente_clasificador --stop-after-init
odoo-bin -d BASE_DEV -u biotex_asistente_clasificador --test-enable --test-tags /biotex_asistente_clasificador --stop-after-init
```

## Verificación

- Odoo: `tests/test_clasificador.py` (`@tagged('post_install')`, usuario clasificador sin superusuario).
- Sin Odoo: `NODE_PATH=<jsdom> OWL_PATH=<owl.js> node tests/workspace_templates.cjs` compila las plantillas OWL
  (incluida la herencia del modal) y ejercita pasos 1–3, edición, alta vacía, colores por segmento,
  marca obligatoria, errores al guardar, incorporación del alta a la sección 3 y cancelación con servicios simulados.
- Concurrencia real: `tools/check_folio_concurrency.py` desde un shell de Odoo en QA.

Requiere `biotex_catalog` ≥ 19.0.3.5.3 (ganchos `_target_brand` y `_workspace_draft_domain`).

Validación local del cambio 19.0.1.4.0: pruebas OWL aprobadas; Python y XML analizados y SCSS compilado.
Se agregaron seis pruebas de integración del alta para ejecutar en Odoo. No se ejecutaron aquí por falta
de instancia Odoo; la revisión visual en navegador de escritorio/tablet también queda pendiente por restricciones del entorno.

La versión **19.0.1.3.0** requiere actualizar este módulo para crear los campos de contenido en productos y líneas.
Los registros existentes parten de 1. La cantidad admite números finitos mayores que cero, incluidos decimales;
no altera factores de conversión, existencias, códigos de barras, marcas, referencias ni reservas de folio.
