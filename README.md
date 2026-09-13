# Clasificador Global (`biotex_asistente_clasificador`)

Variante del **Clasificador por Grupos** (antes "Asistente de clasificación") de `biotex_catalog` para Odoo 19. Misma sesión persistente, mismo
modal de edición, misma galería de imágenes y mismo contador de folios; cambia el punto en que se genera el folio.

| | Clasificador por Grupos (`biotex_catalog`) | Clasificador Global (este módulo) |
|---|---|---|
| Paso 1 | Grupo + Familia + Clasificador + Marca | Grupo + Familia + Clasificador (llave base `GG-FFF-CCC`) |
| Folio | Se reserva al agregar el producto | Se reserva al **confirmar la marca** de cada producto (llave exacta `GG-FFF-CCC-MMMM`) |
| Paso 2 | Producto / Referencia / Marca / +Agregar | Badges de catálogo (`biotex_class_state`) y de sesión, código pendiente `GG-FFF-CCC-????-??`, acciones **Ver imágenes**, **Editar** y +Agregar; sin eliminar |
| Marca | En la sesión | En el modal de edición, con alta rápida y catálogo releído en cada apertura |
| Paso 3 | Tabla editable con arrastre | Solo lectura, ordenado por marca y folio, refrescado en vivo tras cada edición |

Ambos asistentes conviven: una sesión con `brand_per_line` pertenece a este; el resto sigue igual. Menú:
**Catálogo → Clasificador Global** (también en Inventario → Control de inventario).

Detalle funcional, decisiones tomadas sobre los puntos abiertos y casos de prueba: [`docs/asistente-clasificador.md`](docs/asistente-clasificador.md).

## Verificación

- Odoo: `tests/test_clasificador.py` (`@tagged('post_install')`, usuario clasificador sin superusuario).
- Sin Odoo: `NODE_PATH=<jsdom> OWL_PATH=<owl.js> node tests/workspace_templates.cjs` compila las plantillas OWL
  (incluida la herencia del modal) y ejercita pasos 1–3 y el modal de marca con servicios simulados.
- Concurrencia real: `tools/check_folio_concurrency.py` desde un shell de Odoo en QA.

Requiere `biotex_catalog` ≥ 19.0.3.5.3 (ganchos `_target_brand` y `_workspace_draft_domain`).
