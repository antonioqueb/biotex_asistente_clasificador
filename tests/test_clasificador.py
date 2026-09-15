"""Clasificador Global: marca y folio por producto, casos A/B, paso 3 y convivencia con el asistente base."""
from odoo.exceptions import UserError
from odoo.tests import TransactionCase, tagged
from odoo.tests.common import new_test_user


@tagged('post_install', '-at_install')
class TestClasificador(TransactionCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        source = cls.env['product.category'].search([('biotex_level', '=', 'family'), ('biotex_classifier_ids', '!=', False)], limit=1)
        cls.classifier = source.biotex_classifier_ids[0]
        cls.group = source.biotex_group_id
        cls.family = cls.env['product.category'].create({
            'name': 'Clasificador test family', 'biotex_level': 'family', 'biotex_code': 'TCL',
            'biotex_group_id': cls.group.id, 'biotex_classifier_ids': [(6, 0, cls.classifier.ids)]})
        cls.other_family = cls.env['product.category'].create({
            'name': 'Clasificador other family', 'biotex_level': 'family', 'biotex_code': 'TCO',
            'biotex_group_id': cls.group.id, 'biotex_classifier_ids': [(6, 0, cls.classifier.ids)]})
        cls.brand_a = cls.env['biotex.brand'].create({'name': 'Clasificador brand A', 'code': 'CLBA'})
        cls.brand_b = cls.env['biotex.brand'].create({'name': 'Clasificador brand B', 'code': 'CLBB'})
        cls.base = '%s-TCL-%s' % (cls.group.code, cls.classifier.code)
        cls.prefix_a = cls.base + '-CLBA'
        cls.prefix_b = cls.base + '-CLBB'
        ctx = cls.env(context={**cls.env.context, 'no_reset_password': True})
        cls.operator = new_test_user(ctx, login='clasificador_operator', groups='biotex_catalog.group_catalog_classifier')
        cls.colleague = new_test_user(ctx, login='clasificador_colleague', groups='biotex_catalog.group_catalog_classifier')

    # ------------------------------------------------------------ helpers
    def product(self, **extra):
        return self.env['product.template'].create(dict({'name': 'Clasificador fixture'}, **extra))

    def classified_product(self, code, brand=None, family=None, **extra):
        return self.product(categ_id=(family or self.family).id, biotex_classifier_id=self.classifier.id,
                            biotex_brand_id=(brand or self.brand_a).id, default_code=code, **extra)

    def Session(self, user=None):
        return self.env['biotex.classification.session'].with_user(user or self.operator).with_context(clasificador=True)

    def session(self, user=None):
        data = self.Session(user).workspace_set_classification(False, {
            'group_id': self.group.id, 'family_id': self.family.id, 'classifier_id': self.classifier.id, 'brand_per_line': True})
        return self.Session(user).browse(data['id'])

    def line(self, session, product):
        return session.line_ids.filtered(lambda l: l.product_id == product)

    def confirm(self, session):
        preview = session.workspace_confirmation_preview()
        session.workspace_confirm(expected_revision=preview['revision'])

    # ------------------------------------------------------------ paso 1: llave base sin marca
    def test_session_is_complete_with_three_levels_and_adds_products_without_folio(self):
        self.assertIsNone(self.Session().workspace_set_classification(False, {'group_id': self.group.id, 'family_id': self.family.id, 'brand_per_line': True}))
        session = self.session()
        self.assertTrue(session.brand_per_line)
        self.assertTrue(session.complete)
        self.assertFalse(session.brand_id)
        self.assertEqual(session.class_code, self.base)
        data = session._workspace_session()
        self.assertEqual(data['pending_code'], self.base + '-????-??')
        product = self.product(biotex_brand_id=self.brand_a.id)
        session.workspace_add_products(product.ids)
        line = self.line(session, product)
        self.assertFalse(line.brand_id, 'la marca de la ficha no se copia: queda pendiente')
        self.assertEqual(line.consecutive, 0, 'agregar no reserva folio')
        self.assertFalse(line.reference)
        self.assertFalse(line.folio)
        row = line._workspace_line()
        self.assertFalse(row['classified'])
        self.assertEqual(row['display_code'], self.base + '-????-??')
        self.assertEqual(row['suggested_brand_id'], self.brand_a.id)
        self.assertEqual(session.pending_count, 1)

    # ------------------------------------------------------------ folio al confirmar la marca
    def test_confirming_brand_reserves_folio_per_exact_key(self):
        session = self.session()
        p1, p2, p3 = self.product(), self.product(), self.product()
        session.workspace_add_products((p1 | p2 | p3).ids)
        session.clasificador_set_line_brand(self.line(session, p1).id, self.brand_a.id)
        session.clasificador_set_line_brand(self.line(session, p2).id, self.brand_b.id)
        session.clasificador_set_line_brand(self.line(session, p3).id, self.brand_a.id)
        l1, l2, l3 = (self.line(session, p) for p in (p1, p2, p3))
        self.assertEqual((l1.reference, l2.reference, l3.reference), (self.prefix_a + '-01', self.prefix_b + '-01', self.prefix_a + '-02'))
        self.assertEqual((l1.folio, l1.folio_number, l1.line_class_code), ('01', 1, self.prefix_a))
        self.assertEqual(self.env['biotex.product.sequence']._next(self.prefix_a), 3)
        self.assertEqual(self.env['biotex.product.sequence']._next(self.prefix_b), 2)
        self.assertTrue(all(l._is_classified() for l in (l1, l2, l3)))
        self.assertEqual(session.pending_count, 0)
        # misma marca otra vez: no cambia nada
        session.clasificador_set_line_brand(l1.id, self.brand_a.id)
        self.assertEqual(l1.reference, self.prefix_a + '-01')
        # otra marca: folio nuevo en su propia secuencia; el anterior no se reutiliza
        session.clasificador_set_line_brand(l1.id, self.brand_b.id)
        self.assertEqual(l1.reference, self.prefix_b + '-02')
        self.assertEqual(self.env['biotex.product.sequence']._next(self.prefix_a), 3, 'el 01 de la marca A no se libera')
        # la marca no se escribe por fuera del flujo
        with self.assertRaises(UserError):
            l1.write({'brand_id': self.brand_a.id})
        with self.assertRaises(UserError):
            session.clasificador_set_line_brand(l1.id, False)

    def test_folio_sequence_is_shared_with_classic_sessions_and_products(self):
        session = self.session()
        product = self.product()
        session.workspace_add_products(product.ids)
        session.clasificador_set_line_brand(self.line(session, product).id, self.brand_a.id)
        self.assertEqual(self.line(session, product).reference, self.prefix_a + '-01')
        classic = self.env['biotex.classification.session'].with_user(self.operator).create({
            'group_id': self.group.id, 'family_id': self.family.id, 'classifier_id': self.classifier.id, 'brand_id': self.brand_a.id})
        self.assertFalse(classic.brand_per_line)
        classic.workspace_add_products(self.product().ids)
        self.assertEqual(classic.line_ids.reference, self.prefix_a + '-02', 'el contador se comparte con el asistente base')
        other = self.product()
        session.workspace_add_products(other.ids)
        session.clasificador_set_line_brand(self.line(session, other).id, self.brand_a.id)
        self.assertEqual(self.line(session, other).reference, self.prefix_a + '-03')
        self.assertEqual(self.env['biotex.product.sequence']._observed_max(self.prefix_a), 3)

    # ------------------------------------------------------------ caso A y caso B
    def test_case_a_same_brand_keeps_reference_and_name(self):
        product = self.classified_product(self.prefix_a + '-05', name='PRODUCTO YA CLASIFICADO')
        session = self.session()
        records = {r['id']: r for r in session.workspace_search_products('PRODUCTO YA CLASIFICADO')['records']}
        self.assertTrue(records[product.id]['same_classification'])
        self.assertEqual(records[product.id]['reclassify_from'], '', 'misma familia y clasificador: no es otra clasificación')
        self.assertEqual(records[product.id]['class_state'], product.biotex_class_state)
        session.workspace_add_products(product.ids)
        line = self.line(session, product)
        self.assertFalse(line.preserve_reference, 'sin marca confirmada aún no se decide')
        session.clasificador_set_line_brand(line.id, self.brand_a.id)
        self.assertTrue(line.preserve_reference)
        self.assertEqual(line.reference, self.prefix_a + '-05')
        self.assertEqual((line.consecutive, line.folio, line.folio_number), (0, '05', 5))
        self.assertEqual(self.env['biotex.product.sequence']._next(self.prefix_a), 6, 'no consume folio')
        with self.assertRaisesRegex(UserError, 'se conservan'):
            session.workspace_update_line(line.id, {'new_name': 'OTRO NOMBRE', 'uom_id': line.uom_id.id})
        session.workspace_update_line(line.id, {'new_name': line.new_name, 'uom_id': line.uom_id.id, 'model': 'M-77'})
        preview = session.workspace_confirmation_preview()
        self.assertEqual(preview['changes'], [], 'ninguna referencia cambia')
        session.workspace_confirm(expected_revision=preview['revision'])
        self.assertEqual(product.default_code, self.prefix_a + '-05')
        self.assertEqual(product.name, 'PRODUCTO YA CLASIFICADO')
        self.assertEqual(product.biotex_model, 'M-77')
        self.assertEqual(product.biotex_brand_id, self.brand_a)

    def test_case_b_changed_brand_gets_new_folio_and_is_flagged(self):
        product = self.classified_product(self.prefix_a + '-05', name='PRODUCTO CAMBIA DE MARCA')
        session = self.session()
        session.workspace_add_products(product.ids)
        line = self.line(session, product)
        session.clasificador_set_line_brand(line.id, self.brand_b.id)
        self.assertFalse(line.preserve_reference)
        self.assertEqual(line.reference, self.prefix_b + '-01')
        self.assertEqual(line._workspace_line()['reclassify_from'], self.prefix_a + '-05', 'la marca distinta dispara el aviso')
        self.assertEqual(session._classified_elsewhere(product), self.prefix_a + '-05')
        record = next(r for r in session.workspace_search_products('PRODUCTO CAMBIA DE MARCA')['records'] if r['id'] == product.id)
        self.assertEqual(record['reclassify_from'], self.prefix_a + '-05')
        preview = session.workspace_confirmation_preview()
        change = next(c for c in preview['changes'] if c['id'] == product.id)
        self.assertTrue(change['reclassified'])
        self.assertEqual((change['before'], change['after']), (self.prefix_a + '-05', self.prefix_b + '-01'))
        session.workspace_confirm(expected_revision=preview['revision'])
        self.assertTrue(line.reclassified)
        self.assertEqual(product.default_code, self.prefix_b + '-01')
        self.assertEqual(product.biotex_brand_id, self.brand_b)
        self.assertEqual(line.applied_reference_before, self.prefix_a + '-05')
        self.assertIn('CLBB', line.applied_classification_after)
        # volver a la marca original antes de confirmar recupera la identidad (caso A de nuevo)
        second = self.classified_product(self.prefix_a + '-07')
        other = self.session()
        other.workspace_add_products(second.ids)
        other_line = self.line(other, second)
        other.clasificador_set_line_brand(other_line.id, self.brand_b.id)
        other.clasificador_set_line_brand(other_line.id, self.brand_a.id)
        self.assertTrue(other_line.preserve_reference)
        self.assertEqual(other_line.reference, self.prefix_a + '-07')

    def test_product_of_another_classification_is_flagged_and_renumbered(self):
        product = self.classified_product('%s-TCO-%s-CLBA-03' % (self.group.code, self.classifier.code), family=self.other_family)
        session = self.session()
        record = next(r for r in session.workspace_search_products('Clasificador fixture')['records'] if r['id'] == product.id)
        self.assertEqual(record['reclassify_from'], product.default_code)
        self.assertFalse(record['same_classification'])
        data = session.clasificador_edit_product(product.id)
        line = session.line_ids.browse(data['line_id'])
        self.assertEqual(line.product_id, product)
        self.assertEqual(line._workspace_line()['reclassify_from'], product.default_code)
        session.clasificador_set_line_brand(line.id, self.brand_a.id)
        self.assertEqual(line.reference, self.prefix_a + '-01')
        self.assertFalse(line.preserve_reference)

    # ------------------------------------------------------------ paso 2: editar sin agregar, sin eliminar
    def test_edit_from_search_adds_the_line_once_and_keeps_it_in_results(self):
        session = self.session()
        product = self.product(name='EDITAR DESDE PASO 2')
        first = session.clasificador_edit_product(product.id)
        second = session.clasificador_edit_product(product.id)
        self.assertEqual(first['line_id'], second['line_id'])
        self.assertEqual(len(session.line_ids), 1)
        records = session.workspace_search_products('EDITAR DESDE PASO 2')['records']
        self.assertEqual([r['id'] for r in records], [product.id], 'el producto agregado sigue en el resultado para editarlo')
        self.assertEqual(records[0]['line']['id'], first['line_id'])
        self.assertFalse(records[0]['line']['classified'])
        self.assertIn('images', records[0])
        # un producto tomado por otra sesión no se puede editar aquí
        blocked = self.product()
        colleague = self.session(self.colleague)
        colleague.workspace_add_products(blocked.ids)
        with self.assertRaisesRegex(UserError, 'otra clasificación en curso'):
            session.clasificador_edit_product(blocked.id)
        self.assertEqual(next(r for r in session.workspace_search_products('Clasificador fixture', limit=20)['records'] if r['id'] == blocked.id)['locked_by'], colleague.name)

    def test_line_detail_and_brand_catalog_are_fresh_and_quick_create_reuses_duplicates(self):
        session = self.session()
        product = self.product(biotex_brand_id=self.brand_b.id)
        session.workspace_add_products(product.ids)
        line = self.line(session, product)
        detail = session.workspace_line_detail(line.id)
        self.assertEqual(detail['pending_code'], self.base + '-????-??')
        self.assertEqual(detail['line']['suggested_brand_id'], self.brand_b.id)
        self.assertFalse(detail['line']['brand_id'])
        self.classified_product(self.prefix_a + '-01')  # marca A ya usada en esta familia y clasificador
        rows = self.Session().clasificador_brands('Clasificador brand', session_id=session.id)
        self.assertEqual([r['id'] for r in rows][:1], [self.brand_a.id], 'las marcas ya usadas van primero')
        self.assertTrue(rows[0]['used'] and not rows[1]['used'])
        fresh = self.env['biotex.brand'].create({'name': 'Marca recién creada', 'code': 'MRCC'})
        self.assertIn(fresh.id, [r['id'] for r in self.Session().clasificador_brands('recién', session_id=session.id)])
        created = self.Session().clasificador_create_brand('Marca nueva desde modal')
        self.assertEqual(created['code'], self.env['biotex.brand'].browse(created['id']).code)
        self.assertEqual(self.Session().clasificador_create_brand('marca nueva desde modal')['id'], created['id'], 'duplicado normalizado: se reutiliza')
        with self.assertRaises(UserError):
            self.Session().clasificador_create_brand('  ')
        session.clasificador_set_line_brand(line.id, created['id'])
        self.assertEqual(line.line_class_code, '%s-%s' % (self.base, created['code']))
        self.assertEqual(line.reference, line.line_class_code + '-01')

    # ------------------------------------------------------------ paso 3 y cierre
    def test_cannot_confirm_with_pending_lines_and_confirm_applies_brand_per_line(self):
        session = self.session()
        p1, p2 = self.product(name='CON MARCA'), self.product(name='SIN MARCA')
        session.workspace_add_products((p1 | p2).ids)
        session.clasificador_set_line_brand(self.line(session, p1).id, self.brand_a.id)
        with self.assertRaisesRegex(UserError, 'sin marca o folio'):
            self.confirm(session)
        self.assertEqual(session.state, 'draft')
        self.assertFalse(p1.default_code)
        session.clasificador_set_line_brand(self.line(session, p2).id, self.brand_b.id)
        self.confirm(session)
        self.assertEqual(session.state, 'confirmed')
        self.assertEqual((p1.default_code, p1.biotex_brand_id), (self.prefix_a + '-01', self.brand_a))
        self.assertEqual((p2.default_code, p2.biotex_brand_id), (self.prefix_b + '-01', self.brand_b))
        self.assertEqual(p1.categ_id, self.family)
        self.assertEqual(p1.biotex_classifier_id, self.classifier)
        self.assertEqual(p1.biotex_class_state, 'complete' if not self.family.biotex_photo_required else 'no_photo')
        self.assertFalse(p1.biotex_classification_status, 'confirmar libera la marca de sesión')
        note = p1.message_ids.filtered(lambda m: self.prefix_a + '-01' in str(m.body))
        self.assertEqual(len(note), 1)
        self.assertIn('CLBA', self.line(session, p1).applied_classification_after)

    def test_step3_lists_only_classified_lines_ordered_by_brand_then_folio(self):
        session = self.session()
        pa1, pb1, pa2, pending = (self.product(name='A UNO'), self.product(name='B UNO'), self.product(name='A DOS'), self.product(name='PENDIENTE'))
        session.workspace_add_products((pending | pb1 | pa1 | pa2).ids)
        for product, brand in ((pb1, self.brand_b), (pa1, self.brand_a), (pa2, self.brand_a)):
            session.clasificador_set_line_brand(self.line(session, product).id, brand.id)
        rows = [r for r in session._workspace_session()['lines'] if r['classified']]
        rows.sort(key=lambda r: (r['brand_short'].lower(), r['folio_number']))
        self.assertEqual([(r['brand_code'], r['folio'], r['new_name']) for r in rows],
                         [('CLBA', '01', 'A UNO'), ('CLBA', '02', 'A DOS'), ('CLBB', '01', 'B UNO')])
        self.assertEqual(session._workspace_session()['pending_count'], 1)
        self.assertNotIn(pending.id, [r['product_id'] for r in rows])

    def test_changing_base_key_renumbers_only_lines_with_brand(self):
        session = self.session()
        with_brand, without = self.product(), self.product()
        session.workspace_add_products((with_brand | without).ids)
        session.clasificador_set_line_brand(self.line(session, with_brand).id, self.brand_a.id)
        self.Session().workspace_set_classification(session.id, {'group_id': self.group.id, 'family_id': self.other_family.id, 'classifier_id': self.classifier.id})
        self.assertEqual(session.class_code, '%s-TCO-%s' % (self.group.code, self.classifier.code))
        self.assertEqual(self.line(session, with_brand).reference, session.class_code + '-CLBA-01')
        self.assertEqual(self.line(session, without).consecutive, 0)
        self.assertFalse(self.line(session, without).reference)

    def test_renumbering_after_base_key_change_records_the_new_root(self):
        session = self.session()
        product = self.product()
        session.workspace_add_products(product.ids)
        session.clasificador_set_line_brand(self.line(session, product).id, self.brand_a.id)
        self.Session().workspace_set_classification(session.id, {'group_id': self.group.id, 'family_id': self.other_family.id, 'classifier_id': self.classifier.id})
        line = self.line(session, product)
        self.assertEqual(line.folio_root['family_id'], self.other_family.id, 'el folio renumerado recuerda la raíz nueva')
        self.assertFalse(line._clasificador_root_state()['root_mismatch'])

    # ------------------------------------------------------------ regla de raíz al guardar desde el modal (cambio 2)
    def test_folio_remembers_its_root_and_saving_with_same_root_keeps_it(self):
        session = self.session()
        product = self.product()
        session.workspace_add_products(product.ids)
        line = self.line(session, product)
        self.assertFalse(line.folio_root, 'sin folio no hay raíz')
        session.clasificador_set_line_brand(line.id, self.brand_a.id)
        root = line.folio_root
        self.assertEqual((root['group_id'], root['family_id'], root['classifier_id']), (self.group.id, self.family.id, self.classifier.id))
        self.assertEqual((root['code'], root['key']), (self.base, self.prefix_a))
        state = line._clasificador_root_state()
        self.assertEqual(state, {'session_root': self.base, 'product_root': self.base, 'root_mismatch': False})
        row = line._workspace_line()
        self.assertFalse(row['root_mismatch'])
        self.assertEqual(row['session_root'], self.base)
        data = session.workspace_update_line(line.id, {'new_name': 'NOMBRE EDITADO', 'uom_id': line.uom_id.id, 'barcode': '7501001'})
        self.assertEqual(data['id'], session.id, 'guardar devuelve la sesión (paso 3 al día)')
        self.assertEqual((line.consecutive, line.reference, line.brand_id), (1, self.prefix_a + '-01', self.brand_a), 'misma raíz: marca y folio se conservan')
        self.assertEqual(self.env['biotex.product.sequence']._next(self.prefix_a), 2, 'no consume folio nuevo')
        self.assertEqual((line.new_name, line.barcode), ('NOMBRE EDITADO', '7501001'))

    def test_saving_with_same_root_refreshes_reference_when_labels_change(self):
        session = self.session()
        product = self.product()
        session.workspace_add_products(product.ids)
        line = self.line(session, product)
        session.clasificador_set_line_brand(line.id, self.brand_a.id)
        self.family.write({'biotex_code': 'TCX'})
        session.workspace_update_line(line.id, {'new_name': line.new_name, 'uom_id': line.uom_id.id})
        new_base = '%s-TCX-%s' % (self.group.code, self.classifier.code)
        self.assertEqual(line.reference, new_base + '-CLBA-01', 'referencia refrescada con la etiqueta nueva, mismo consecutivo')
        self.assertEqual(line.consecutive, 1)
        self.assertEqual(line.folio_root['code'], new_base)
        self.assertFalse(line._clasificador_root_state()['root_mismatch'], 'mismos ids de raíz: no es un cambio de raíz')

    def test_root_change_blocks_saving_until_a_new_folio_is_reserved(self):
        session = self.session()
        product = self.product()
        session.workspace_add_products(product.ids)
        line = self.line(session, product)
        session.clasificador_set_line_brand(line.id, self.brand_a.id)
        # el folio quedó respaldado por otra raíz (p. ej. la sesión cambió de familia en otra pestaña)
        other_root = dict(line.folio_root, family_id=self.other_family.id, code='%s-TCO-%s' % (self.group.code, self.classifier.code))
        line.write({'folio_root': other_root})
        state = line._clasificador_root_state()
        self.assertTrue(state['root_mismatch'])
        self.assertEqual((state['session_root'], state['product_root']), (self.base, other_root['code']))
        self.assertTrue(line._workspace_detail()['root_mismatch'], 'el modal recibe el aviso')
        with self.assertRaisesRegex(UserError, 'raíz de clasificación cambió'):
            session.workspace_update_line(line.id, {'new_name': 'OTRO', 'uom_id': line.uom_id.id})
        self.assertEqual(line.new_name, product.name.upper(), 'nada se guardó')
        data = session.clasificador_reserve_folio(line.id)
        self.assertEqual(data['line']['id'], line.id)
        self.assertFalse(data['line']['root_mismatch'])
        self.assertEqual((line.brand_id, line.consecutive, line.reference), (self.brand_a, 2, self.prefix_a + '-02'), 'misma marca, folio nuevo; el anterior no se reutiliza')
        self.assertEqual(line.folio_root['family_id'], self.family.id)
        session.workspace_update_line(line.id, {'new_name': 'OTRO', 'uom_id': line.uom_id.id})
        self.assertEqual(line.new_name, 'OTRO')

    def test_reserve_folio_needs_a_confirmed_brand_and_confirming_repairs_a_root_mismatch(self):
        session = self.session()
        product = self.product()
        session.workspace_add_products(product.ids)
        line = self.line(session, product)
        with self.assertRaisesRegex(UserError, 'Confirme primero la marca'):
            session.clasificador_reserve_folio(line.id)
        session.clasificador_set_line_brand(line.id, self.brand_a.id)
        line.write({'folio_root': dict(line.folio_root, classifier_id=-1, code='XX-YYY-ZZZ')})
        self.assertTrue(line._clasificador_root_state()['root_mismatch'])
        preview = session.workspace_confirmation_preview()
        self.assertEqual(line.reference, self.prefix_a + '-02', 'al preparar la confirmación el folio inconsistente se reserva de nuevo')
        self.assertFalse(line._clasificador_root_state()['root_mismatch'])
        session.workspace_confirm(expected_revision=preview['revision'])
        self.assertEqual(product.default_code, self.prefix_a + '-02')

    # ------------------------------------------------------------ convivencia con el asistente base
    def test_each_wizard_only_sees_its_own_sessions(self):
        Session = self.env['biotex.classification.session'].with_user(self.operator)
        Session.search([('user_id', '=', self.operator.id), ('state', '=', 'draft')]).unlink()
        per_line = self.session()
        classic = Session.create({'group_id': self.group.id, 'family_id': self.family.id, 'classifier_id': self.classifier.id, 'brand_id': self.brand_a.id})
        self.assertEqual([d['id'] for d in Session.workspace_bootstrap()['drafts']], [classic.id])
        self.assertEqual([d['id'] for d in self.Session().workspace_bootstrap()['drafts']], [per_line.id])
        self.assertIsNone(Session.workspace_bootstrap(per_line.id)['session'], 'el asistente base no abre una sesión de marca por producto')
        self.assertEqual(self.Session().workspace_bootstrap(per_line.id)['session']['id'], per_line.id)
        self.assertIsNone(self.Session().workspace_bootstrap(classic.id)['session'])
        # la acción de la lista de productos solo retoma sesiones del asistente base
        classic.action_cancel()
        product = self.product()
        product.with_user(self.operator).action_open_classifier()
        reused = Session.search([('user_id', '=', self.operator.id), ('state', '=', 'draft'), ('id', '!=', per_line.id)])
        self.assertEqual(len(reused), 1)
        self.assertFalse(reused.brand_per_line)
        self.assertNotIn(product, per_line.line_ids.product_id)
        # la ficha del producto y la sesión abren el asistente correcto
        self.assertEqual(per_line.action_open_workspace()['tag'], 'biotex_asistente_clasificador.workspace')
        self.assertEqual(reused.action_open_workspace()['tag'], 'biotex_catalog.classification_workspace')
        mine = self.product()
        per_line.workspace_add_products(mine.ids)
        self.assertEqual(mine.with_user(self.operator).action_open_classification_session()['tag'], 'biotex_asistente_clasificador.workspace')
        self.assertEqual(product.with_user(self.operator).action_open_classification_session()['type'], 'ir.actions.act_url')

    def test_classic_sessions_keep_their_behaviour(self):
        classic = self.env['biotex.classification.session'].with_user(self.operator).create({
            'group_id': self.group.id, 'family_id': self.family.id, 'classifier_id': self.classifier.id, 'brand_id': self.brand_a.id})
        product = self.product(biotex_brand_id=self.brand_b.id)
        classic.workspace_add_products(product.ids)
        line = classic.line_ids
        self.assertEqual(line.brand_id, self.brand_b, 'en la sesión clásica la línea conserva la marca de la ficha como atributo')
        self.assertEqual(line.reference, self.prefix_a + '-01', 'el consecutivo se reserva al agregar')
        self.assertEqual(line.line_class_code, self.prefix_a)
        self.assertEqual((line.folio, line.folio_number), ('01', 1))
        self.assertEqual(line._target_brand(), self.brand_a)
        self.assertEqual(classic.workspace_line_detail(line.id)['classification_brand_id'], self.brand_a.id)
        with self.assertRaisesRegex(UserError, 'clasificación principal'):
            line.write({'brand_id': self.brand_a.id})
        with self.assertRaises(UserError):
            classic.clasificador_set_line_brand(line.id, self.brand_a.id)
        self.confirm(classic)
        self.assertEqual((product.default_code, product.biotex_brand_id), (self.prefix_a + '-01', self.brand_a))
