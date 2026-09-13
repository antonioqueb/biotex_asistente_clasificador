from odoo import models
from odoo.exceptions import UserError


class ProductTemplate(models.Model):
    _inherit = 'product.template'

    def action_open_classification_session(self):
        """"Ver clasificación en curso": una sesión con marca por producto se abre en el Clasificador por Grupos (antes Asistente Clasificador."""
        self.ensure_one()
        session = self.biotex_classification_session_id
        if session and session.brand_per_line:
            if not session.exists():
                raise UserError('"%s" no está en ninguna clasificación en curso.' % self.display_name)
            return session.action_open_workspace()
        return super().action_open_classification_session()
