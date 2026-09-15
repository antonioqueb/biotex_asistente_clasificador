"""Raíz del folio (``folio_root``) para las líneas ya reservadas antes de este control.

Solo sesiones en borrador con marca por producto: al momento de migrar sus folios son consistentes con la
raíz vigente de la sesión (el ``write`` de la sesión renumera al cambiar grupo, familia o clasificador),
así que se registra esa raíz. Las líneas con clave conservada no la necesitan (usan la raíz del producto).
"""
import logging

from psycopg2.extras import Json

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)


def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})
    lines = env['biotex.classification.session.line'].search([
        ('session_id.brand_per_line', '=', True), ('session_id.state', '=', 'draft'),
        ('brand_id', '!=', False), ('consecutive', '>', 0), ('preserve_reference', '=', False),
    ]).filtered(lambda l: not l.folio_root)
    for line in lines:
        # escritura directa: el write público de la línea protege la identidad y bloquea la sesión
        cr.execute('UPDATE biotex_classification_session_line SET folio_root = %s WHERE id = %s',
                   (Json(line._clasificador_session_root()), line.id))
    if lines:
        _logger.info('Raíz del folio registrada en %d línea(s) del Clasificador Global.', len(lines))
