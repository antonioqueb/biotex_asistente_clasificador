# Clasificador Global — especificación implementada

Módulo `biotex_asistente_clasificador` 19.0.1.2.0 · 12 de septiembre de 2026 (ampliado el 14 de septiembre de 2026) · requiere `biotex_catalog` 19.0.3.5.3.

## Arquitectura: extensión, no copia

Se implementó como **extensión** (`_inherit`) del modelo `biotex.classification.session` y de su línea, con el
indicador `brand_per_line` en la sesión. Los dos flujos coexisten en la misma tabla, el mismo historial y el mismo
contador de folios (`biotex.product.sequence`); cada asistente lista y retoma solo sus sesiones (`_workspace_draft_domain`)
y "Abrir asistente" / "Ver clasificación en curso" llevan al asistente correcto.

En `biotex_catalog` se añadieron dos ganchos sin cambio de comportamiento: `line._target_brand()` (marca con la que se
clasifica la línea; antes se leía `session.brand_id` en cinco sitios) y `session._workspace_draft_domain()`.

Reutilizado tal cual: el componente `BiotexClassificationWorkspace` (se hereda), `BiotexLineEditorDialog` (se hereda y su
plantilla se extiende por `t-inherit`), `BiotexImageGalleryDialog`, el widget `biotex_class_badge`, `workspace_add_products`,
`workspace_update_line`, `workspace_line_detail`, la revisión y confirmación, y toda la hoja de estilos `.o_bcw_*`.

## Comportamiento

### Paso 1
Grupo, familia y clasificador. El resumen muestra `GG-FFF-CCC-????-??`. Cada vez que se abre un selector se vuelve a leer
`product.category.biotex_get_tree()` (3.6): una familia o un clasificador dados de alta en otra pestaña aparecen sin recargar.
La sesión se crea al completar los tres niveles (`workspace_set_classification` con `brand_per_line`).

### Paso 2
El resultado de búsqueda **incluye los productos ya agregados a la sesión** (a diferencia del asistente base): como el paso 3
ya no edita, este es el único lugar donde se edita. Cada fila usa dos renglones: nombre y, debajo, los badges:

- `biotex_class_state` (widget `biotex_class_badge`, con los faltantes en el título).
- Estado de sesión: "En clasificación" (otra sesión en curso; solo Ver imágenes), "Otra clasificación" (clave completa con
  otra familia/clasificador, o con otra marca ya confirmada; rojo), "Ya en esta clasificación" (clave completa con la misma
  familia y clasificador; tercer estado sugerido en 3.4), y "Marca pendiente" / "Clasificado" para las líneas de la sesión.
- Columna Referencia: código final o pendiente `GG-FFF-CCC-????-??` (punteado, naranja).
- Acciones: **Ver imágenes** (galería existente, imágenes de la ficha o las pendientes de la línea), **Editar** y **+Agregar**
  (solo si aún no está en la sesión). No existe eliminar.

**Editar sin +Agregar**: `clasificador_edit_product` agrega la línea si no existe (marca pendiente) y abre el modal. Un producto
con clave de otra clasificación pide aceptar primero (mismo diálogo con ambas claves).

### Modal de edición
Campo **Marca** debajo del nombre. La lista se lee del servidor en cada apertura y en cada tecleo (`clasificador_brands`,
marcas ya usadas en la familia+clasificador primero); "Crear marca «X»" usa `biotex.brand.name_create` (reutiliza duplicados
normalizados; el código de 4 letras se sugiere). La marca actual de la ficha se **sugiere**, nunca se confirma sola.

**Confirmar marca y reservar folio** llama a `clasificador_set_line_brand`: resuelve la llave exacta, aplica caso A/B, reserva
el folio (`biotex.product.sequence._next(reserve=True)`), actualiza la referencia del encabezado y devuelve la sesión para que
el paso 3 se refresque al instante. El campo **nunca se bloquea**:

- **Caso A** (misma familia, clasificador y marca que la clave actual): `preserve_reference`; sin folio nuevo; nombre y
  referencia se conservan; el resto se edita.
- **Caso B** (marca distinta): diálogo "Clasificación diferente" con clave actual y llave destino; al aceptar, folio nuevo en la
  secuencia de la llave resultante y línea en rojo (`reclassify_from`, `reclassified` al aplicar).
- Cambiar la marca de una línea que ya tenía folio (sin clave previa en catálogo) avisa que el folio anterior no se reutiliza.
- Volver a la marca de la clave actual recupera esa referencia (caso A de nuevo).

Al confirmar la marca se aplica la sugerencia de fabricante de la marca si el usuario no lo capturó (igual que la sesión clásica).

### Paso 3
Columnas: Marca, Folio, Nombre (nuevo, con el anterior debajo si cambió), Referencia completa, Unidad de medida,
Imagen (consulta) y **Acciones** (lápiz). Orden: marca (nombre, luego código) y folio ascendente; lo calcula el cliente con los datos devueltos por
`_workspace_session`, así que cada `onSaved` / `onBrandChanged` inserta, reubica y refleja cambios sin recargar. Debajo, una
lista informativa de pendientes (sin marca ni folio). "Generar claves" queda deshabilitado con pendientes y el servidor lo
rechaza también (`action_confirm`).

**Editar desde el paso 3 (cambio 1, 14 sep 2026).** El lápiz de cada fila llama a `editLine(line)`, el mismo método y el mismo
componente `BiotexClasificadorLineEditorDialog` que usa el paso 2 (no hay un segundo modal), precargado con esa línea. Así una
sesión retomada sin terminar, que abre directo en el paso 3 con todo clasificado, sigue siendo editable. Con la sesión aplicada el
lápiz queda deshabilitado.

### Regla de raíz al guardar (cambio 2, 14 sep 2026)
Cada reserva de folio registra en la línea la raíz con la que se hizo: `folio_root` = ids de grupo, familia y clasificador de la
sesión, su llave base (`code`, GG-FFF-CCC) y la llave exacta (`key`, GG-FFF-CCC-MMMM). Las líneas con clave conservada (caso A)
no la necesitan: su raíz es la del producto (`biotex_group_id`, `categ_id`, `biotex_classifier_id`).

Al guardar desde el modal (`workspace_update_line`) un producto con marca y folio:

| Comparación (por ids) | Comportamiento |
|---|---|
| raíz de la sesión == raíz del folio | Se conservan marca y folio (no se reserva nada). Tras guardar, `_clasificador_refresh_reference` recalcula llave, referencia y folio visibles (por si cambiaron las etiquetas de familia o clasificador) sin tocar el consecutivo, y actualiza el `code`/`key` guardados en `folio_root`. |
| raíz de la sesión != raíz del folio | El servidor rechaza el guardado («La raíz de clasificación cambió…»). El modal lo muestra desde que se abre (`root_mismatch`, `session_root`, `product_root` en los datos de la línea), habilita **Cambiar marca y reservar folio** aunque la marca no cambie y, si se pulsa Guardar, abre el aviso «La raíz de clasificación cambió; se debe reservar un folio nuevo» → `clasificador_reserve_folio` (misma marca, siguiente folio de la raíz vigente; el anterior no se reutiliza) y después guarda. |

`_ensure_reservations` (al preparar la confirmación) también trata la raíz distinta como colisión y reserva de nuevo, como red
de seguridad. La migración `19.0.1.2.0` registra `folio_root` en los borradores existentes con folio (consistentes con la raíz
vigente porque el `write` de la sesión renumera al cambiar grupo, familia o clasificador).

### Unidades y empaques en el modal (cambio 3, 14 sep 2026)
Las secciones «Unidad indivisible» y «Empacados de productos y códigos de barras» se fusionan en una tabla **Unidades y empaques**
(Tipo de empaque / Cantidad (en la unidad base) / Código de barras):

- **Primera fila, fija: la unidad base.** Registro sintético derivado del `uom_id` de la línea (no es un `product.uom`), con ícono
  de llave, fondo de acento propio, texto «PIEZA · Unidad base» (el nombre de la unidad del catálogo), cantidad 1 deshabilitada,
  código de barras editable (`line.barcode`, que al confirmar se escribe en `product.barcode`) y candado en lugar de eliminar: no
  se elimina ni se reordena (regla resuelta en el widget OWL, no con reglas de acceso). Un enlace discreto «Cambiar unidad» muestra
  el selector de unidad (el mismo de antes) para no perder la captura de la unidad indivisible; con movimientos de inventario no
  aparece y se muestra el mensaje «esa unidad se conserva» (`uom_locked`, mismo bloqueo de siempre en cliente y servidor).
- **Debajo, los empacados** (`presentation_data`): tipo de empaque por combo, cantidad en unidades base, código de barras y su
  eliminar; **Agregar empacado** al pie de la misma tabla. Al confirmar la sesión se escriben como registros reales de
  `product.uom` con código de barras (`_biotex_set_presentations`; en Odoo 19 `product.uom` sustituye a `product.packaging`).

Íconos: el backend de Odoo 19 no carga Tabler Icons, así que `ti-edit`, `ti-key` y `ti-lock` se representan con Font Awesome
(`fa-pencil`, `fa-key`, `fa-lock`), la misma fuente que usa el resto del asistente.

### Folio y concurrencia (sección 5)
Contador por llave exacta `GG-FFF-CCC-MMMM` en `biotex_product_sequence`. La reserva es `INSERT ... ON CONFLICT (prefix) DO
UPDATE ... RETURNING`: PostgreSQL bloquea la fila del contador de esa llave; bajo *repeatable read* la transacción concurrente
recibe `SerializationFailure` y la capa RPC de Odoo la reintenta completa. La marca de agua (`_observed_max`) ahora también
mira `line_class_code` de las líneas con marca por producto, y la sesión se bloquea con `SELECT ... FOR UPDATE` antes de cada
reserva. La carrera real se ejecuta con `tools/check_folio_concurrency.py` en QA (dos sesiones, misma marca, mismo instante:
folios 1 y 2 y al menos un reintento).

## Modelo de datos
- `biotex.classification.session.brand_per_line` (Boolean, índice), `pending_count` (calculado).
- Línea: `brand_id` (ya existía como atributo; en sesiones de marca por producto es la marca de clasificación y solo se escribe
  vía `clasificador_set_line_brand`), `line_class_code` (Char, almacenado, índice), `folio` (Char `NN`, almacenado),
  `folio_number` (Integer, almacenado, para ordenar) y `folio_root` (Json: raíz con la que se reservó el folio). `consecutive`
  sigue siendo el número reservado; `reference` se calcula con la llave de la línea y muestra `False` mientras falte marca.
- Vistas de sesión: columna "Marca por producto", filtros, y en la ficha marca y folio por línea.

## Decisiones sobre los puntos abiertos (a validar con negocio)
| Punto | Decisión implementada |
|---|---|
| 3.3.1 Pendientes en el paso 3 | Se listan aparte, informativos (código pendiente y nombre), sin acciones. |
| 3.3.2 Acción de consulta en el paso 3 | "Ver imágenes" y, desde el 14 sep 2026, **Editar** (lápiz) con el mismo modal del paso 2. |
| 3.3.3 Arrastre para reordenar | Eliminado; el orden lo define marca + folio. |
| 3.2 Layout de la fila | Dos renglones por fila (nombre / badges); acciones en una sola línea. |
| 7.1 Quitar un producto con folio | No hay acción de eliminar en el asistente; desde la ficha de la sesión el folio se pierde (no se libera), igual que en el asistente base. |
| 7.2 Reclasificaciones | Sí: caso B genera folio nuevo; caso A conserva. |
| 7.3 Finalizar con pendientes | Bloqueado en cliente y servidor. |
| 7.4 Marca nueva | Disponible de inmediato, sin aprobación (misma regla que el catálogo de marcas). |
| 8 Extensión vs copia | Extensión con indicador; ambos flujos coexisten. |

## Casos de aceptación manual
Con usuario **Clasificador de catálogo** en QA:

| ID | Procedimiento | Resultado esperado |
|---|---|---|
| A | Paso 1: elegir grupo, familia y clasificador. | Sin campo Marca; resumen `GG-FFF-CCC-????-??`; sesión creada. |
| B | Crear una familia y un clasificador en otra pestaña; abrir de nuevo el selector. | Aparecen sin recargar. |
| C | Buscar; revisar badges de una fila sin clave, una completa de esta familia/clasificador, una de otra y una en otra sesión. | "Sin clasificar" / "Ya en esta clasificación" / "Otra clasificación" (rojo) / "En clasificación"; acciones Ver imágenes, Editar, +Agregar; sin eliminar. |
| D | Editar un producto sin +Agregar; elegir marca; Confirmar. | La línea se crea; la referencia pasa de `????-??` al folio final; el paso 3 lo muestra sin recargar. |
| E | Dos productos con marcas distintas; un tercero con la primera. | Folios `MMMM1-01`, `MMMM2-01`, `MMMM1-02`; paso 3 ordenado por marca y folio. |
| F | Producto ya clasificado con esta familia/clasificador: confirmar su misma marca. | Referencia y nombre conservados; sin folio nuevo; nombre bloqueado. |
| G | Mismo producto: cambiar la marca. | Diálogo "Clasificación diferente"; al aceptar, folio nuevo, fila en rojo, reubicada en el paso 3. |
| H | Crear una marca nueva desde el modal y confirmarla. | Se crea con código sugerido y reserva folio de su propia llave. |
| I | Generar claves con un producto sin marca. | Botón deshabilitado; el servidor rechaza si se fuerza. |
| J | Dos usuarios confirman la misma marca a la vez (o `check_folio_concurrency` en QA). | Folios distintos y consecutivos. |
| K | Abrir "Clasificador por Grupos" (base). | No lista ni abre las sesiones de marca por producto; su flujo no cambia. |
| L | Retomar una sesión sin terminar con todo clasificado; pulsar el lápiz en el paso 3. | Se abre «Editando producto» con ese producto; al guardar, el paso 3 se refresca. |
| M | Producto con marca y folio; guardar sin cambiar la raíz. | Marca y folio iguales; referencia refrescada. |
| N | Producto con folio de otra raíz (`folio_root` distinto) al abrir el modal. | Aviso naranja; Guardar abre «La raíz de clasificación cambió»; al aceptar, folio nuevo de la misma marca y luego guarda. Sin aceptar, el servidor rechaza el guardado. |
| O | Modal: tabla «Unidades y empaques». | Primera fila fija (llave, «PIEZA · Unidad base», cantidad 1 deshabilitada, solo código de barras editable, candado); empacados debajo con eliminar; «Agregar empacado» añade filas debajo. Con movimientos de inventario no hay «Cambiar unidad» y se muestra «esa unidad se conserva». |

## Verificación automatizada
- `tests/test_clasificador.py`: 18 casos (llave base, folio por llave, contador compartido, caso A, caso B, otra clasificación,
  editar desde el paso 2, catálogo de marcas fresco y alta rápida, bloqueo con pendientes y aplicación por línea, orden del paso
  3, renumeración al cambiar la llave base y raíz registrada, regla de raíz al guardar ×4, convivencia y comportamiento intacto
  del asistente base). Se ejecutan en el servidor.
- `tests/workspace_templates.cjs` (node + jsdom + OWL 2.8.4): paso 3 editable, tabla de unidades y empaques (incluida la fila
  bloqueada por movimientos) y regla de raíz en el modal; comprobado el 14 de septiembre de 2026 en esta máquina.
- Pendiente en instancia: instalar el módulo en QA y correr los tests Odoo y `check_folio_concurrency`.
