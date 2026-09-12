"""Carrera real de dos sesiones confirmando la misma marca (misma llave GG-FFF-CCC-MMMM) a la vez.

Se ejecuta desde un shell de Odoo en QA (nunca en producción), después de que ninguna TransactionCase
tenga el registro bloqueado::

    bioteczac-qa shell -d bioteczac
    >>> from odoo.addons.biotex_asistente_clasificador.tools.check_folio_concurrency import check_folio_concurrency
    >>> check_folio_concurrency(env)

Cada hilo abre su propio cursor, crea su sesión de marca por producto con un producto propio y confirma la
marca en el mismo instante (barrera). El contador `biotex_product_sequence` de esa llave se bloquea por fila
(`INSERT ... ON CONFLICT DO UPDATE`); la transacción que pierde la carrera recibe SerializationFailure y el
reintento nativo de Odoo (`retrying`) la repite completa. Resultado esperado: folios 1 y 2, ninguno repetido
ni saltado, y al menos un reintento registrado. Al final se borran los registros temporales.
"""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

from odoo import api, sql_db
from odoo.service.model import retrying


def check_folio_concurrency(env):
    assert env['ir.config_parameter'].sudo().get_param('bioteczac.environment') == 'qa', 'Solo en QA'
    connection = sql_db.db_connect(env.cr.dbname)
    uid = env.uid
    suffix = uuid4().hex[:4].upper()
    with connection.cursor() as cr:
        setup = api.Environment(cr, uid, {})
        source = setup['product.category'].search([('biotex_level', '=', 'family'), ('biotex_classifier_ids', '!=', False)], limit=1)
        classifier = source.biotex_classifier_ids[0]
        family = setup['product.category'].create({
            'name': 'Carrera de folios %s' % suffix, 'biotex_level': 'family', 'biotex_code': 'Z%s' % suffix[:2],
            'biotex_group_id': source.biotex_group_id.id, 'biotex_classifier_ids': [(6, 0, classifier.ids)]})
        brand = setup['biotex.brand'].create({'name': 'Carrera %s' % suffix, 'code': 'Z' + suffix[:3]})
        products = setup['product.template'].create([{'name': 'Carrera de folios %s #%d' % (suffix, n)} for n in range(2)])
        cr.commit()
        ids = {'family': family.id, 'group': source.biotex_group_id.id, 'classifier': classifier.id, 'brand': brand.id, 'products': products.ids}
    barrier = Barrier(2)
    sessions = []

    def classify(index):
        with connection.cursor() as cr:
            worker = api.Environment(cr, uid, {'clasificador': True})
            attempts = 0

            def operation():
                nonlocal attempts
                attempts += 1
                cr.execute("SET LOCAL lock_timeout = '5s'")
                cr.execute("SET LOCAL statement_timeout = '20s'")
                Session = worker['biotex.classification.session']
                data = Session.workspace_set_classification(False, {
                    'group_id': ids['group'], 'family_id': ids['family'], 'classifier_id': ids['classifier'], 'brand_per_line': True})
                session = Session.browse(data['id'])
                session.workspace_add_products([ids['products'][index]])
                if attempts == 1:
                    barrier.wait(timeout=15)
                session.clasificador_set_line_brand(session.line_ids.id, ids['brand'])
                sessions.append(session.id)
                return session.line_ids.reference

            return retrying(operation, worker), attempts

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = [future.result(timeout=60) for future in [executor.submit(classify, i) for i in range(2)]]
        references = sorted(reference for reference, _attempts in results)
        prefix = references[0].rsplit('-', 1)[0]
        assert references == ['%s-01' % prefix, '%s-02' % prefix], references
        assert max(attempts for _reference, attempts in results) > 1, 'La carrera no provocó ningún reintento'
        return {'references': references, 'attempts': [attempts for _reference, attempts in results]}
    finally:
        with connection.cursor() as cr:
            cleanup = api.Environment(cr, uid, {})
            cleanup['biotex.classification.session'].browse(sessions).exists().sudo().action_cancel()
            cleanup['biotex.classification.session'].browse(sessions).exists().sudo().unlink()
            cleanup['product.template'].browse(ids['products']).unlink()
            cleanup['biotex.brand'].browse(ids['brand']).unlink()
            cleanup['product.category'].browse(ids['family']).unlink()
            cr.execute("DELETE FROM biotex_product_sequence WHERE prefix LIKE %s", ('%%-Z%s-%%' % suffix[:2],))
            cr.commit()
