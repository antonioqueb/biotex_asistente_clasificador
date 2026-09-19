"""Contenido informativo de una unidad base; nunca es un factor de conversión."""
import math

from odoo import api, fields, models
from odoo.exceptions import ValidationError


def validate_quantity(value):
    try:
        quantity = float(value) if not isinstance(value, bool) else 0
    except (TypeError, ValueError, OverflowError):
        quantity = 0
    if not math.isfinite(quantity) or quantity <= 0:
        raise ValidationError('La cantidad de elementos de la unidad base debe ser un número mayor que cero.')
    return quantity


def unit_description(unit, quantity):
    return '%s CON %s' % (unit.upper(), format(quantity, '.15g')) if unit else False


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    biotex_base_unit_quantity = fields.Float(
        string='Elementos por unidad base', default=1.0, required=True,
        help='Contenido de una unidad de compra, venta e inventario. No modifica equivalencias de unidades ni empaques.')
    biotex_base_unit_description = fields.Char(
        string='Descripción de la unidad', compute='_compute_biotex_base_unit_description')

    @api.depends('uom_id.name', 'biotex_base_unit_quantity')
    def _compute_biotex_base_unit_description(self):
        for product in self:
            product.biotex_base_unit_description = unit_description(product.uom_id.name, product.biotex_base_unit_quantity)

    @api.constrains('biotex_base_unit_quantity')
    def _check_biotex_base_unit_quantity(self):
        for product in self:
            validate_quantity(product.biotex_base_unit_quantity)


class ClassificationSessionLine(models.Model):
    _inherit = 'biotex.classification.session.line'

    base_unit_quantity = fields.Float(string='Elementos por unidad base', default=1.0, required=True)
    base_unit_description = fields.Char(string='Descripción de la unidad', compute='_compute_base_unit_description')

    @api.depends('uom_id.name', 'base_unit_quantity')
    def _compute_base_unit_description(self):
        for line in self:
            line.base_unit_description = unit_description(line.uom_id.name, line.base_unit_quantity)

    @api.constrains('base_unit_quantity')
    def _check_base_unit_quantity(self):
        for line in self:
            validate_quantity(line.base_unit_quantity)

    @api.model_create_multi
    def create(self, vals_list):
        values = []
        for vals in vals_list:
            vals = dict(vals)
            if 'base_unit_quantity' not in vals and vals.get('product_id'):
                vals['base_unit_quantity'] = self.env['product.template'].browse(vals['product_id']).biotex_base_unit_quantity
            values.append(vals)
        return super().create(values)

    def _workspace_detail(self):
        data = super()._workspace_detail()
        if self.session_id.brand_per_line:
            data.update(base_unit_quantity=self.base_unit_quantity,
                        base_unit_description=self.base_unit_description or '')
        return data

    def _apply(self):
        result = super()._apply()
        if self.session_id.brand_per_line:
            self.product_id.write({'biotex_base_unit_quantity': self.base_unit_quantity})
        return result


class ClassificationSession(models.Model):
    _inherit = 'biotex.classification.session'

    def workspace_update_line(self, line_id, vals):
        self.ensure_one()
        if not self.brand_per_line or 'base_unit_quantity' not in vals:
            return super().workspace_update_line(line_id, vals)
        self._lock_workspace()
        self._check_editable()
        values = dict(vals)
        quantity = validate_quantity(values.pop('base_unit_quantity'))
        # The normal save validates ownership, unit locks, the name and all other details.
        super().workspace_update_line(line_id, values)
        line = self.line_ids.filtered(lambda row: row.id == line_id)
        line.write({'base_unit_quantity': quantity})
        return self._workspace_session()
