"""El contador por prefijo también observa las reservas hechas línea por línea (marca por producto)."""
from odoo import api, models


class ProductSequence(models.Model):
    _inherit = 'biotex.product.sequence'

    @api.model
    def _observed_max(self, prefix):
        """Marca de agua: además de lo que ya mira el catálogo, el mayor folio reservado por líneas con esa llave exacta.

        Las líneas con marca por producto no comparten el ``class_code`` de su sesión (que es la llave
        base sin marca), así que se consultan por ``line_class_code``.
        """
        observed = super()._observed_max(prefix)
        boundary = self._reset_boundary(prefix)
        self.env['biotex.classification.session.line'].flush_model(['line_class_code', 'consecutive'])
        self.env.cr.execute(
            '''SELECT coalesce(max(l.consecutive), 0)
                 FROM biotex_classification_session_line l
                 JOIN biotex_classification_session s ON s.id = l.session_id
                WHERE l.line_class_code = %s
                  AND (%s OR l.id > %s OR s.state = 'draft')''',
            (prefix, not boundary, boundary['line_id'] if boundary else 0))
        return max(observed, int(self.env.cr.fetchone()[0]))
