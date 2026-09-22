"""Alta desde el editor compartido: reserva en borrador, producto solo al guardar."""
from markupsafe import Markup

from odoo import api, fields, models
from odoo.exceptions import UserError, ValidationError

from odoo.addons.biotex_catalog.models.biotex_classification import (
    BiotexClassificationSessionLine as BaseLine,
)


class ClassificationSession(models.Model):
    _inherit = 'biotex.classification.session'

    def _check_new_product_session(self):
        self.ensure_one()
        self._lock_workspace()
        self._check_editable()
        if not self.brand_per_line or not self.complete:
            raise UserError('Complete la llave base (grupo, familia y clasificador) del Clasificador Global.')

    def clasificador_new_product(self):
        self._check_new_product_session()
        self.env['product.template'].check_access('create')
        line = self.env['biotex.classification.session.line'].create({
            'session_id': self.id, 'product_id': False, 'new_product': True,
            'sequence': max(self.line_ids.mapped('sequence') or [0]) + 10,
        })
        return {'line_id': line.id, 'session': self._workspace_session()}

    def clasificador_cancel_new_product(self, line_id):
        """Cerrar sin guardar quita únicamente el borrador; nunca elimina un producto."""
        self.ensure_one()
        self._lock_workspace()
        line = self.line_ids.filtered(lambda row: row.id == line_id)
        if line.new_product and not line.product_id:
            self._check_editable()
            line.unlink()  # El folio reservado no se devuelve al contador.
        return self._workspace_session()

    def clasificador_create_product(self, line_id, vals):
        self._check_new_product_session()
        line = self.line_ids.filtered(lambda row: row.id == line_id)
        if not line or not line.new_product:
            raise UserError('El borrador de alta ya no pertenece a esta sesión.')
        if line.product_id:
            # Doble clic o reintento de la misma petición: el alta y su bitácora son únicas.
            return self._workspace_session()
        if not line._is_classified():
            raise UserError('Confirme la marca y reserve el folio antes de crear el producto.')
        with self.env.cr.savepoint():
            # Reutiliza todas las validaciones del editor, incluidas fotos y unidades.
            self.workspace_update_line(line.id, vals)
            product = self.env['product.template'].create({
                'name': line.new_name, 'uom_id': line.uom_id.id,
                'categ_id': self.family_id.id,
                'biotex_classifier_id': self.classifier_id.id,
                'biotex_brand_id': line.brand_id.id,
                'default_code': line.reference, 'biotex_consecutive': line.consecutive,
                'type': 'consu', 'is_storable': True, 'tracking': 'lot',
                'invoice_policy': 'order', 'purchase_ok': True, 'sale_ok': True,
            })
            # La identidad está protegida contra write por RPC; solo se enlaza aquí,
            # después de comprobar permisos, pertenencia, marca y raíz del folio.
            super(BaseLine, line).write({'product_id': product.id})
            line._apply()  # Mismo traslado de medidas, empaques, fotos y detalles que la edición.
            product.message_post(body=Markup(
                '<p>Alta de producto desde el Clasificador Global.</p>'
                '<ul><li>Nombre: %s</li><li>Categoría: %s</li><li>Referencia: %s</li>'
                '<li>Unidad de Medida: %s</li><li>Usuario: %s</li><li>Fecha (UTC): %s</li></ul>'
            ) % (product.name, ' / '.join((self.group_id.display_name,
                    self.family_id.display_name, self.classifier_id.display_name)),
                 product.default_code, product.uom_id.display_name,
                 self.env.user.display_name, fields.Datetime.to_string(product.create_date)),
                subtype_xmlid='mail.mt_note')
            # Sigue editable en la sección 3 como los demás productos de la sesión.
            # Su clave ya existe: al confirmar la sesión se conserva sin reservar otra.
            super(BaseLine, line).write({
                'state': 'draft', 'old_name': product.name, 'old_reference': product.default_code,
                'photo_baselines': False,
            })
            line._refresh_identity()
        return self._workspace_session()

    def _pending_lines(self):
        pending = super()._pending_lines()
        return pending | self.line_ids.filtered(lambda line: not line.product_id)

    def action_confirm(self, expected_revision=None):
        for session in self.filtered('brand_per_line'):
            session._lock_workspace()
            if session.line_ids.filtered(lambda line: not line.product_id):
                raise UserError('Hay un alta sin guardar. Continúe el alta o cierre su editor sin guardar antes de generar claves.')
        return super().action_confirm(expected_revision=expected_revision)


class ClassificationSessionLine(models.Model):
    _inherit = 'biotex.classification.session.line'

    product_id = fields.Many2one(required=False)
    new_product = fields.Boolean(string='Alta desde el clasificador', readonly=True, copy=False)

    _product_or_new = models.Constraint(
        'CHECK(product_id IS NOT NULL OR new_product IS TRUE)',
        'Seleccione un producto o abra un alta desde el Clasificador Global.',
    )

    @api.model_create_multi
    def create(self, vals_list):
        values = []
        for vals in vals_list:
            vals = dict(vals)
            if vals.get('new_product'):
                if vals.get('product_id'):
                    raise ValidationError('Un alta comienza sin producto de catálogo.')
                vals['product_id'] = False
                self.env['product.template'].check_access('create')
                self.env['biotex.classification.session'].browse(vals['session_id'])._check_new_product_session()
            elif not vals.get('product_id'):
                raise ValidationError('Seleccione un producto de catálogo.')
            values.append(vals)
        return super().create(values)

    def write(self, vals):
        if 'new_product' in vals:
            raise UserError('El origen del alta no se modifica manualmente.')
        return super().write(vals)

    @api.depends('product_id.name', 'new_name', 'new_product')
    def _compute_display_name(self):
        super()._compute_display_name()
        for line in self.filtered(lambda row: row.new_product and not row.product_id):
            line.display_name = line.new_name or 'Nuevo producto'

    def _workspace_line(self, moved=None):
        data = super()._workspace_line(moved=moved)
        data['is_new_product'] = bool(self.new_product and not self.product_id)
        return data
