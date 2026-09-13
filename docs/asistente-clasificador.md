# Clasificador por Grupos — especificación implementada

Módulo `biotex_asistente_clasificador` 19.0.1.1.0 · 12 de septiembre de 2026 · requiere `biotex_catalog` 19.0.3.5.3.

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
Solo lectura. Columnas: Marca, Folio, Nombre (nuevo, con el anterior debajo si cambió), Referencia completa, Unidad de medida,
Imagen (consulta). Orden: marca (nombre, luego código) y folio ascendente; lo calcula el cliente con los datos devueltos por
`_workspace_session`, así que cada `onSaved` / `onBrandChanged` inserta, reubica y refleja cambios sin recargar. Debajo, una
lista informativa de pendientes (sin marca ni folio). "Generar claves" queda deshabilitado con pendientes y el servidor lo
rechaza también (`action_confirm`).

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
  vía `clasificador_set_line_brand`), `line_class_code` (Char, almacenado, índice), `folio` (Char `NN`, almacenado) y
  `folio_number` (Integer, almacenado, para ordenar). `consecutive` sigue siendo el número reservado; `reference` se calcula con
  la llave de la línea y muestra `False` mientras falte marca.
- Vistas de sesión: columna "Marca por producto", filtros, y en la ficha marca y folio por línea.

## Decisiones sobre los puntos abiertos (a validar con negocio)
| Punto | Decisión implementada |
|---|---|
| 3.3.1 Pendientes en el paso 3 | Se listan aparte, informativos (código pendiente y nombre), sin acciones. |
| 3.3.2 Acción de consulta en el paso 3 | Solo "Ver imágenes"; ninguna edición. |
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
| K | Abrir "Clasificador Global" (base). | No lista ni abre las sesiones de marca por producto; su flujo no cambia. |

## Verificación automatizada
- `tests/test_clasificador.py`: 13 casos (llave base, folio por llave, contador compartido, caso A, caso B, otra clasificación,
  editar desde el paso 2, catálogo de marcas fresco y alta rápida, bloqueo con pendientes y aplicación por línea, orden del paso
  3, renumeración al cambiar la llave base, convivencia y comportamiento intacto del asistente base). Se ejecutan en el servidor.
- `tests/workspace_templates.cjs` (node + jsdom + OWL 2.8.4): comprobado el 12 de septiembre de 2026 en esta máquina.
- Pendiente en instancia: instalar el módulo en QA y correr los tests Odoo y `check_folio_concurrency`.
