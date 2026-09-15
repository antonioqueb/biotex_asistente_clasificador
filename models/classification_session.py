"""Clasificador Global (módulo biotex_asistente_clasificador): la misma sesión de clasificación masiva, con la marca y el folio por producto.

Convive con el asistente de clasificación original (`biotex_catalog`): una sesión con
``brand_per_line`` la abre y opera este asistente; las demás siguen el flujo anterior sin cambios.

Reglas de esta variante:

* La llave base de la sesión es Grupo-Familia-Clasificador (``class_code``, p. ej. ``CE-CBL-EKG``).
  Queda "completa" sin marca: la marca se resuelve producto por producto.
* Al agregar un producto no se reserva folio. El folio se reserva **al confirmar la marca de esa
  línea** (``clasificador_set_line_brand``), contra la llave exacta ``GG-FFF-CCC-MMMM`` y con el
  mismo contador transaccional que usa el resto del catálogo (``biotex.product.sequence``: fila
  bloqueada por ``INSERT ... ON CONFLICT DO UPDATE``; ver docs/asistente-clasificador.md).
* Un producto ya clasificado con la misma llave base y la misma marca conserva referencia y nombre
  (caso A: ``preserve_reference``). Si se le confirma otra marca (caso B) recibe folio nuevo y queda
  marcado como reclasificado; el asistente avisa antes con ambas claves.
* Un folio reservado no se devuelve al cambiar de marca ni al quitar la línea (misma política que el
  resto del catálogo: la numeración es identidad, puede haber saltos).
* No se confirma la sesión mientras exista una línea sin marca o sin folio.
* Cada folio recuerda la raíz (grupo, familia y clasificador) con la que se reservó (``folio_root``).
  Al guardar desde el modal, si la raíz de la sesión sigue siendo la misma se conservan marca y folio y
  solo se refresca la referencia (por si cambiaron las etiquetas); si la raíz cambió, el folio ya no
  corresponde y hay que reservar uno nuevo (``clasificador_reserve_folio``) antes de poder guardar.
"""
from odoo import api, fields, models
from odoo.exceptions import UserError
from odoo.fields import Domain

from odoo.addons.biotex_catalog.models.biotex_classification import (
    CONSECUTIVE_FORMAT, BiotexClassificationSessionLine as BaseLine)
from odoo.addons.biotex_catalog.models.classification_images import (
    GALLERY_LABELS, MAX_GALLERY_IMAGES, THUMB_SIZE, image_url)

PENDING_BRAND = '????'
PENDING_FOLIO = '??'
WORKSPACE_ACTION = 'biotex_asistente_clasificador.workspace'


class ClassificationSession(models.Model):
    _inherit = 'biotex.classification.session'

    brand_per_line = fields.Boolean(
        string='Marca por producto', default=False, readonly=True, index=True,
        help='Sesión del Clasificador Global: la marca y el folio se asignan por producto al editarlo; '
             'la sesión solo fija grupo, familia y clasificador.')
    pending_count = fields.Integer(string='Sin marca o folio', compute='_compute_pending_count')

    # ------------------------------------------------------------------ computes
    @api.depends('brand_per_line')
    def _compute_class_code(self):
        per_line = self.filtered('brand_per_line')
        super(ClassificationSession, self - per_line)._compute_class_code()
        for session in per_line:
            parts = (session.group_id.code, session.family_id.biotex_code, session.classifier_id.code)
            session.complete = all(parts)
            session.class_code = '-'.join(parts) if session.complete else False

    @api.depends('line_ids.brand_id', 'line_ids.consecutive', 'line_ids.preserve_reference')
    def _compute_pending_count(self):
        for session in self:
            session.pending_count = len(session._pending_lines()) if session.brand_per_line else 0

    def _pending_lines(self):
        self.ensure_one()
        return self.line_ids.filtered(lambda l: not l._is_classified())

    def _same_base(self, product):
        """El producto tiene la familia y el clasificador de esta sesión (la llave base)."""
        self.ensure_one()
        return product.categ_id == self.family_id and product.biotex_classifier_id == self.classifier_id

    def _per_line_classified_elsewhere(self, product, brand):
        """Clave actual del producto si moverlo a esta sesión (con ``brand``) le cambia la referencia, o ''.

        * Llave base distinta: "Otra clasificación" (rojo) desde que se busca.
        * Misma llave base y marca confirmada distinta a la del producto: caso B, folio nuevo.
        * Misma llave base y marca igual (o aún sin marca): no altera su numeración.
        """
        self.ensure_one()
        if not self.complete or not self.env['biotex.product.sequence']._split_code(product.default_code):
            return ''
        complete = product.categ_id.biotex_level == 'family' and product.biotex_classifier_id and product.biotex_brand_id
        if not complete:
            return ''
        if not self._same_base(product):
            return product.default_code
        if brand and product.biotex_brand_id != brand:
            return product.default_code
        return ''

    def _classified_elsewhere(self, product):
        self.ensure_one()
        if not self.brand_per_line:
            return super()._classified_elsewhere(product)
        line = self.line_ids.filtered(lambda l: l.product_id == product)[:1]
        return self._per_line_classified_elsewhere(product, line.brand_id if line else None)

    def _same_classification(self, product):
        """Producto con clave completa cuya familia y clasificador ya son los de la sesión ("Ya en esta clasificación")."""
        self.ensure_one()
        return bool(self.complete and self.env['biotex.product.sequence']._split_code(product.default_code)
                    and product.biotex_brand_id and self._same_base(product))

    # ------------------------------------------------------------------ consecutivos
    def _ensure_reservations(self):
        """Colisiones de borradores anteriores, comparando por la llave exacta de cada línea."""
        self.ensure_one()
        if not self.brand_per_line:
            return super()._ensure_reservations()
        self._lock_workspace()
        self._check_editable()
        Line = self.env['biotex.classification.session.line'].sudo()
        Product = self.env['product.product'].sudo().with_context(active_test=False)
        for line in self.line_ids.sorted('id'):
            line._refresh_identity()
            if line.preserve_reference or not line.brand_id:
                continue
            collision = not line.consecutive or line._clasificador_root_state()['root_mismatch'] or Line.search_count([
                ('line_class_code', '=', line.line_class_code), ('consecutive', '=', line.consecutive), ('id', '!=', line.id),
            ], limit=1) or Product.search_count([
                ('default_code', '=', line.reference), ('product_tmpl_id', '!=', line.product_id.id),
            ], limit=1)
            if collision:
                line._reserve_consecutive()

    # ------------------------------------------------------------------ acciones
    def action_open_workspace(self):
        self.ensure_one()
        if not self.brand_per_line:
            return super().action_open_workspace()
        return {
            'type': 'ir.actions.client',
            'tag': WORKSPACE_ACTION,
            'name': 'Clasificador Global',
            'context': {'biotex_session_id': self.id},
        }

    def action_confirm(self, expected_revision=None):
        for session in self.filtered('brand_per_line'):
            session._lock_workspace()  # la comprobación se hace ya con la sesión bloqueada
            pending = session._pending_lines()
            if pending:
                raise UserError('No es posible generar las claves: %d producto(s) sin marca o folio asignado:\n- %s\n'
                                'Asigne la marca desde Editar en el paso 2.' % (
                                    len(pending), '\n- '.join(pending.mapped('display_name'))))
        return super().action_confirm(expected_revision=expected_revision)

    @api.model
    def _workspace_draft_domain(self):
        """Cada asistente lista y retoma solo sus sesiones: las de marca por producto son de este."""
        return super()._workspace_draft_domain() + [('brand_per_line', '=', bool(self.env.context.get('clasificador')))]

    # ================================================================== API del asistente OWL
    @api.model
    def workspace_bootstrap(self, session_id=None):
        data = super().workspace_bootstrap(session_id)
        per_line = bool(self.env.context.get('clasificador'))
        if data['session'] and bool(data['session'].get('brand_per_line')) != per_line:
            data['session'] = None  # una sesión del otro asistente no se abre aquí
        return data

    def _workspace_session(self):
        data = super()._workspace_session()
        data['brand_per_line'] = self.brand_per_line
        if self.brand_per_line:
            data['pending_count'] = len(self._pending_lines())
            data['pending_code'] = self._pending_code() if self.complete else ''
        return data

    def _pending_code(self):
        self.ensure_one()
        return '%s-%s-%s' % (self.class_code, PENDING_BRAND, PENDING_FOLIO) if self.class_code else ''

    @api.model
    def workspace_set_classification(self, session_id, vals):
        """Con marca por producto la sesión se crea en cuanto hay grupo, familia y clasificador."""
        session = self.browse(session_id).exists() if session_id else self.browse()
        per_line = session.brand_per_line if session else bool(vals.get('brand_per_line'))
        if not per_line:
            return super().workspace_set_classification(session_id, vals)
        clean = {k: vals.get(k) or False for k in ('group_id', 'family_id', 'classifier_id')}
        if not session:
            if not all(clean.values()):
                return None
            session = self.create({**clean, 'brand_per_line': True})
        else:
            session._lock_workspace()
            session._check_editable()
            session.write(clean)  # si cambia la llave base, las líneas con marca se renumeran (write de la sesión)
        return session._workspace_session()

    def workspace_search_products(self, query='', offset=0, limit=20):
        """Con marca por producto los productos ya agregados siguen en el resultado: el paso 2 es donde se editan."""
        self.ensure_one()
        if not self.brand_per_line:
            return super().workspace_search_products(query=query, offset=offset, limit=limit)
        self.check_access('read')
        limit = max(1, min(int(limit), 20))
        offset = max(0, int(offset))
        domain = Domain.TRUE
        query = (query or '').strip()
        if query:
            domain = (Domain('name', 'ilike', query) | Domain('default_code', 'ilike', query)
                      | Domain('biotex_reference', 'ilike', query) | Domain('barcode', 'ilike', query)
                      | Domain('biotex_alt_code', 'ilike', query) | Domain('biotex_legacy_code', 'ilike', query)
                      | Domain('biotex_synonym_ids.name', 'ilike', query))
        Product = self.env['product.template']
        total = Product.search_count(domain)
        offset = min(offset, ((total - 1) // limit) * limit) if total else 0
        products = Product.search(domain, offset=offset, limit=limit, order='name, id')
        lines = {line.product_id.id: line for line in self.line_ids}
        moved = self._moved_template_ids(self.line_ids.product_id & products)
        return {
            'total': total,
            'offset': offset,
            'limit': limit,
            'records': [self._clasificador_search_record(p, lines.get(p.id), moved) for p in products],
        }

    def _clasificador_search_record(self, product, line, moved):
        other = product.biotex_classification_session_id
        brand = line.brand_id if line else None
        return {
            'id': product.id,
            'name': product.name,
            'default_code': product.default_code or '',
            'reference': product.biotex_reference or product.barcode or '',
            'brand': product.biotex_brand_id.name or '',
            'brand_id': product.biotex_brand_id.id or False,
            # en otra sesión en borrador: solo se pueden ver sus imágenes
            'locked_by': other.name if other and other != self else '',
            # clave completa de otra clasificación (o de otra marca ya confirmada): pide aceptar antes de seguir
            'reclassify_from': self._per_line_classified_elsewhere(product, brand),
            # clave completa con esta misma familia y clasificador: tercer estado visual del paso 2
            'same_classification': self._same_classification(product),
            'class_state': product.biotex_class_state or 'unclassified',
            'missing': product.biotex_missing or '',
            'images': self._clasificador_product_images(product),
            'line': line._workspace_line(moved=moved) if line else None,
        }

    @api.model
    def _clasificador_product_images(self, product):
        """Imágenes (máximo 3) de la ficha, para "Ver imágenes" desde el resultado de búsqueda."""
        source = product.with_context(bin_size=True)
        images = []
        for name, label in GALLERY_LABELS.items():
            url = image_url(source, name, label)
            if url:
                images.append({'field': name, 'label': label, 'url': url,
                               'thumb_url': image_url(source, name, label, THUMB_SIZE), 'pending': False})
        if len(images) < MAX_GALLERY_IMAGES and 'product_template_image_ids' in product._fields:
            extra = product.product_template_image_ids.sorted(lambda i: (i.sequence, i.id)).with_context(bin_size=True)
            for image in extra[:MAX_GALLERY_IMAGES - len(images)]:
                label = list(GALLERY_LABELS.values())[len(images)]
                images.append({'field': 'product_image_%d' % image.id, 'label': label, 'url': image_url(image, 'image_1920', label),
                               'thumb_url': image_url(image, 'image_1920', label, THUMB_SIZE), 'pending': False})
        return images[:MAX_GALLERY_IMAGES]

    def clasificador_edit_product(self, product_id):
        """Editar desde el paso 2: si el producto aún no está en la sesión se agrega (marca pendiente).

        Así se puede clasificar sin pasar antes por "+Agregar". Un producto de otra sesión en curso no
        se toma; un producto con clave de otra clasificación llega aquí después de que el usuario acepta
        el aviso en pantalla.
        """
        self.ensure_one()
        self._lock_workspace()
        self._check_editable()
        if not self.brand_per_line:
            raise UserError('Esta sesión no asigna la marca por producto.')
        product_id = int(product_id)
        line = self.line_ids.filtered(lambda l: l.product_id.id == product_id)[:1]
        if not line:
            data = self.workspace_add_products([product_id])
            if data.get('skipped'):
                raise UserError('No se puede editar: %s ya está en otra clasificación en curso. Termínela o cancélela antes.' % '; '.join(data['skipped']))
            line = self.line_ids.filtered(lambda l: l.product_id.id == product_id)[:1]
        if not line:
            raise UserError('El producto ya no existe o no es visible para este usuario.')
        return {'line_id': line.id, 'session': self._workspace_session()}

    def clasificador_set_line_brand(self, line_id, brand_id):
        """Confirma la marca de una línea y reserva su folio contra la llave exacta GG-FFF-CCC-MMMM.

        * Misma marca que ya tenía la línea: no cambia nada (el folio se conserva).
        * Producto ya clasificado con esta llave base y esta marca (caso A): conserva referencia y nombre.
        * Cualquier otro caso: folio nuevo (el anterior de la línea, si lo había, no se reutiliza).
        """
        self.ensure_one()
        self._lock_workspace()
        self._check_editable()
        if not self.brand_per_line:
            raise UserError('Esta sesión no asigna la marca por producto.')
        if not self.complete:
            raise UserError('Complete grupo, familia y clasificador antes de asignar la marca.')
        line = self.line_ids.filtered(lambda l: l.id == line_id)
        if not line:
            raise UserError('La línea ya no pertenece a esta sesión.')
        brand = self.env['biotex.brand'].browse(int(brand_id)).exists() if brand_id else self.env['biotex.brand']
        if not brand:
            raise UserError('Seleccione una marca del catálogo.')
        if not brand.code:
            raise UserError('La marca %s no tiene código de 4 letras; corríjala en el catálogo de marcas.' % brand.name)
        if brand != line.brand_id:
            line._clasificador_assign_brand(brand)
        return {'session': self._workspace_session(), 'line': line._workspace_detail()}

    def clasificador_reserve_folio(self, line_id):
        """Reserva un folio nuevo para la marca ya confirmada de la línea, contra la raíz vigente de la sesión.

        Es el flujo "Cambiar marca y reservar folio" cuando la marca no cambia pero la raíz sí (grupo,
        familia o clasificador de la sesión distintos de los que respaldaban el folio). El folio anterior
        no se reutiliza (misma política que al cambiar de marca).
        """
        self.ensure_one()
        self._lock_workspace()
        self._check_editable()
        if not self.brand_per_line:
            raise UserError('Esta sesión no asigna la marca por producto.')
        if not self.complete:
            raise UserError('Complete grupo, familia y clasificador antes de reservar el folio.')
        line = self.line_ids.filtered(lambda l: l.id == line_id)
        if not line:
            raise UserError('La línea ya no pertenece a esta sesión.')
        if not line.brand_id:
            raise UserError('Confirme primero la marca del producto: es la que reserva el folio.')
        line._clasificador_assign_brand(line.brand_id)
        return {'session': self._workspace_session(), 'line': line._workspace_detail()}

    def workspace_update_line(self, line_id, vals):
        """Guardar desde el modal con la regla de raíz (marca y folio ya asignados):

        * misma raíz que la del folio: se conservan marca y folio y se refresca la referencia completa;
        * raíz distinta: no se guarda con una referencia inconsistente; primero se reserva folio nuevo.
        """
        if not self.brand_per_line:
            return super().workspace_update_line(line_id, vals)
        self.ensure_one()
        line = self.line_ids.filtered(lambda l: l.id == line_id)
        classified = bool(line) and line._is_classified()
        if classified:
            state = line._clasificador_root_state()
            if state['root_mismatch']:
                raise UserError('La raíz de clasificación cambió (%s → %s): el folio %s de "%s" ya no corresponde. '
                                'Use "Cambiar marca y reservar folio" para reservar un folio nuevo antes de guardar.'
                                % (state['product_root'], state['session_root'], line.folio, line.display_name))
        result = super().workspace_update_line(line_id, vals)
        if classified:
            line._clasificador_refresh_reference()
            result = self._workspace_session()
        return result

    @api.model
    def clasificador_brands(self, query='', session_id=None, limit=200):
        """Marcas leídas de nuevo en cada apertura del selector, con las ya usadas en la familia y clasificador primero."""
        query = (query or '').strip()
        domain = ['|', ('name', 'ilike', query), ('code', 'ilike', query)] if query else []
        brands = self.env['biotex.brand'].search(domain, order='name', limit=max(1, min(int(limit), 500)))
        session = self.browse(session_id).exists() if session_id else self.browse()
        hints = set(self.workspace_brand_hints(session.family_id.id, session.classifier_id.id)) if session else set()
        rows = [{'id': b.id, 'name': b.name, 'code': b.code or '', 'used': b.id in hints,
                 'manufacturer': b.manufacturer_id.display_name or ''} for b in brands]
        rows.sort(key=lambda r: (not r['used'], r['name'].lower()))
        return rows

    @api.model
    def clasificador_create_brand(self, name):
        """Alta rápida de marca desde el modal; devuelve la existente si el nombre normalizado ya está en el catálogo."""
        name = (name or '').strip()
        if not name:
            raise UserError('Indique el nombre de la marca.')
        Brand = self.env['biotex.brand']
        Brand.check_access('create')
        brand_id, _display = Brand.name_create(name)
        brand = Brand.browse(brand_id)
        return {'id': brand.id, 'name': brand.name, 'code': brand.code or '', 'manufacturer': brand.manufacturer_id.display_name or ''}

    def workspace_line_detail(self, line_id):
        data = super().workspace_line_detail(line_id)
        if self.brand_per_line:
            data['brand_hints'] = self.workspace_brand_hints(self.family_id.id, self.classifier_id.id)
            data['pending_code'] = self._pending_code()
            data['session_code'] = self.class_code or ''
        return data


class ClassificationSessionLine(models.Model):
    _inherit = 'biotex.classification.session.line'

    line_class_code = fields.Char(
        string='Llave de la línea', compute='_compute_line_class_code', store=True, index=True,
        help='GG-FFF-CCC-MMMM con la marca de la línea (marca por producto) o de la sesión.')
    folio = fields.Char(string='Folio', compute='_compute_folio', store=True)
    folio_number = fields.Integer(string='Folio (número)', compute='_compute_folio', store=True)
    folio_root = fields.Json(
        string='Raíz del folio', readonly=True, copy=False,
        help='Grupo, familia y clasificador (ids y llave) con los que se reservó el folio. Si la sesión cambia '
             'de raíz, el folio deja de corresponder y se reserva uno nuevo al editar.')

    @api.depends('session_id.class_code', 'session_id.brand_per_line', 'brand_id.code')
    def _compute_line_class_code(self):
        Sequence = self.env['biotex.product.sequence']
        for line in self:
            session = line.session_id
            if not session.brand_per_line:
                line.line_class_code = session.class_code or False
                continue
            parts = (session.group_id.code, session.family_id.biotex_code, session.classifier_id.code, line.brand_id.code)
            line.line_class_code = Sequence._prefix_for(*parts) if all(parts) else False

    @api.depends('consecutive', 'preserve_reference', 'brand_id', 'product_id.default_code', 'session_id.brand_per_line')
    def _compute_folio(self):
        """Folio visible: el consecutivo reservado o, si se conserva la clave, el sufijo de la referencia actual."""
        Sequence = self.env['biotex.product.sequence']
        for line in self:
            number = 0
            if line.preserve_reference:
                parts = Sequence._split_code(line.product_id.default_code)
                number = parts[1] if parts else 0
            elif line.consecutive and (line.brand_id or not line.session_id.brand_per_line):
                number = line.consecutive
            line.folio_number = number
            line.folio = CONSECUTIVE_FORMAT % number if number else False

    @api.depends('brand_id.code', 'line_class_code', 'session_id.brand_per_line')
    def _compute_reference(self):
        per_line = self.filtered('session_id.brand_per_line')
        super(ClassificationSessionLine, self - per_line)._compute_reference()
        for line in per_line:
            if line.preserve_reference:
                line.reference = line.product_id.default_code or False
                continue
            code = line.line_class_code
            line.reference = ('%s-' + CONSECUTIVE_FORMAT) % (code, line.consecutive) if code and line.consecutive else False

    # ------------------------------------------------------------------ identidad y folio
    def _target_brand(self):
        self.ensure_one()
        return self.brand_id if self.session_id.brand_per_line else super()._target_brand()

    def _is_classified(self):
        """Línea con marca y folio (o clave conservada): la que muestra el paso 3 y la que permite confirmar."""
        self.ensure_one()
        return bool(self.brand_id and (self.consecutive or self.preserve_reference))

    def _matches_session_identity(self):
        self.ensure_one()
        session = self.session_id
        if not session.brand_per_line:
            return super()._matches_session_identity()
        product = self.product_id
        if not self.brand_id or not session.complete or not self.env['biotex.product.sequence']._split_code(product.default_code):
            return False
        return session._same_base(product) and product.biotex_brand_id == self.brand_id

    def _reserve_consecutive(self):
        """Con marca por producto solo se reserva cuando la línea ya tiene marca, contra su llave exacta."""
        self.ensure_one()
        if not self.session_id.brand_per_line:
            return super()._reserve_consecutive()
        self.session_id._check_editable()
        if not self.brand_id or not self.line_class_code:
            return super(BaseLine, self).write({'consecutive': 0, 'folio_root': False})
        number = self.env['biotex.product.sequence']._next(self.line_class_code, reserve=True)
        return super(BaseLine, self).write({'consecutive': number, 'folio_root': self._clasificador_session_root()})

    # ------------------------------------------------------------------ raíz del folio (grupo + familia + clasificador)
    def _clasificador_session_root(self):
        """Raíz vigente de la sesión: ids de grupo, familia y clasificador, su llave base y la llave exacta de la línea."""
        self.ensure_one()
        session = self.session_id
        return {'group_id': session.group_id.id, 'family_id': session.family_id.id, 'classifier_id': session.classifier_id.id,
                'code': session.class_code or '', 'key': self.line_class_code or ''}

    def _clasificador_product_root(self):
        """Raíz que respalda el folio o la clave actual de la línea (``None`` si no hay folio o no se registró)."""
        self.ensure_one()
        if self.preserve_reference:
            product = self.product_id
            group, family, classifier = product.biotex_group_id, product.categ_id, product.biotex_classifier_id
            parts = self.env['biotex.product.sequence']._split_code(product.default_code)
            return {'group_id': group.id, 'family_id': family.id, 'classifier_id': classifier.id,
                    'code': '-'.join(part for part in (group.code, family.biotex_code, classifier.code) if part),
                    'key': parts[0] if parts else ''}
        return self.folio_root or None

    def _clasificador_root_state(self):
        """Compara la raíz de la sesión con la del folio de la línea (regla de actualización al editar)."""
        self.ensure_one()
        session_root = self._clasificador_session_root()
        state = {'session_root': session_root['code'], 'product_root': '', 'root_mismatch': False}
        if not self._is_classified():
            return state
        product_root = self._clasificador_product_root()
        if not product_root:
            return state  # folio reservado antes de registrar la raíz: se asume la vigente
        state['product_root'] = product_root.get('code') or ''
        keys = ('group_id', 'family_id', 'classifier_id')
        state['root_mismatch'] = any((product_root.get(k) or False) != (session_root[k] or False) for k in keys)
        return state

    def _clasificador_refresh_reference(self):
        """Misma raíz: recalcula llave, referencia y folio visibles sin tocar el consecutivo (etiquetas cambiadas)."""
        for name in ('line_class_code', 'reference', 'folio', 'folio_number'):
            self.env.add_to_compute(self._fields[name], self)
        self.mapped('reference')
        self.mapped('folio')
        for line in self:
            if line.consecutive and line.folio_root and not line.preserve_reference:
                root = line._clasificador_session_root()
                if root != line.folio_root:
                    super(BaseLine, line).write({'folio_root': root})

    def _clasificador_assign_brand(self, brand):
        self.ensure_one()
        # la marca se escribe por debajo del write público (que la protege) y el folio anterior se descarta
        super(BaseLine, self).write({'brand_id': brand.id, 'consecutive': 0, 'folio_root': False})
        self._refresh_identity()  # caso A: conserva clave y nombre, sin folio nuevo
        if not self.preserve_reference:
            self._reserve_consecutive()
        if brand.manufacturer_id and not self.manufacturer_id and not self.manufacturer_manual:
            # misma sugerencia que hace la sesión clásica al fijar su marca
            super(BaseLine, self).write({'manufacturer_id': brand.manufacturer_id.id})

    @api.model_create_multi
    def create(self, vals_list):
        sessions = self.env['biotex.classification.session'].browse(list({v['session_id'] for v in vals_list}))
        per_line = set(sessions.filtered('brand_per_line').ids)
        # La marca de la ficha no se copia a la línea: queda pendiente hasta que el usuario la confirme.
        return super().create([{**v, 'brand_id': False} if v['session_id'] in per_line else v for v in vals_list])

    def write(self, vals):
        if 'brand_id' in vals and any(line.session_id.brand_per_line for line in self):
            raise UserError('La marca se confirma desde Editar en el Clasificador Global: es la que reserva el folio.')
        return super().write(vals)

    # ------------------------------------------------------------------ datos para la pantalla
    def _clasificador_brand_data(self):
        self.ensure_one()
        session = self.session_id
        product = self.product_id
        classified = self._is_classified()
        return {
            'brand_id': self.brand_id.id or False,
            'brand_code': self.brand_id.code or '',
            'brand_name': self.brand_id.display_name or '',
            'brand_short': self.brand_id.name or '',
            'line_class_code': self.line_class_code or '',
            'pending_code': session._pending_code(),
            'display_code': self.reference or session._pending_code(),
            'folio': self.folio or '',
            'folio_number': self.folio_number,
            'classified': classified,
            'same_classification': session._same_classification(product),
            'class_state': product.biotex_class_state or 'unclassified',
            'missing': product.biotex_missing or '',
            # marca actual de la ficha: se ofrece como sugerencia en el modal, nunca se confirma sola
            'suggested_brand_id': product.biotex_brand_id.id or False,
            'suggested_brand_name': product.biotex_brand_id.display_name or '',
            'product_reference': product.default_code or '',
            # regla de raíz: el folio se reservó con esta raíz; si la sesión cambió, hay que reservar folio nuevo
            **self._clasificador_root_state(),
        }

    def _workspace_line(self, moved=None):
        data = super()._workspace_line(moved=moved)
        if self.session_id.brand_per_line:
            data.update(self._clasificador_brand_data())
        return data
