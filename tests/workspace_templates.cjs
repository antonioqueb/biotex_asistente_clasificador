/* Verificación local sin Odoo: compila las plantillas OWL del asistente y del modal, monta ambos
 * componentes con servicios simulados y comprueba el comportamiento del paso 2 y del paso 3.
 *
 * Uso: NODE_PATH=<dir con jsdom> OWL_PATH=<owl.js de Odoo 19> node tests/workspace_templates.cjs
 * La herencia `t-inherit` (que en Odoo resuelve el cliente web) se aplica aquí con una versión mínima
 * por xpath: sirve para comprobar que las expresiones resuelven, no sustituye la prueba en Odoo.
 */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const CATALOG = path.join(__dirname, '../../biotex_catalog/static/src');
const MINE = path.join(__dirname, '../static/src/workspace');
const read = (file) => fs.readFileSync(file, 'utf8');
// los módulos comparten nombres de constantes (MODEL, PAGE_SIZE): en un solo ámbito se declaran con var
const strip = (source) => source.replace(/^import [^;]*;$/gm, '').replace(/^export (class|function|const) /gm, '$1 ').replace(/^const ([A-Z_]+) = /gm, 'var $1 = ');

function applyInheritance(window, xmlSources) {
    const parser = new window.DOMParser();
    const docs = xmlSources.map((xml) => parser.parseFromString(xml, 'text/xml'));
    const byName = new Map();
    for (const doc of docs) for (const node of doc.querySelectorAll('templates > [t-name]')) byName.set(node.getAttribute('t-name'), node);
    const outDoc = parser.parseFromString('<templates/>', 'text/xml');
    const out = outDoc.documentElement;
    for (const [name, node] of byName) {
        if (!node.hasAttribute('t-inherit')) { out.appendChild(outDoc.importNode(node, true)); continue; }
        const base = byName.get(node.getAttribute('t-inherit'));
        assert.ok(base, `plantilla base ${node.getAttribute('t-inherit')} no encontrada`);
        const clone = outDoc.importNode(base, true);
        clone.setAttribute('t-name', name);
        clone.removeAttribute('t-inherit');
        const holder = outDoc.createElement('holder');
        holder.appendChild(clone);
        for (const op of node.children) {
            const expr = op.getAttribute('expr');
            // el xpath se evalúa relativo a la plantilla clonada, como hace el cliente web de Odoo
            const target = outDoc.evaluate(expr.replace(/^\/\//, './/'), clone, null, 9, null).singleNodeValue;
            assert.ok(target, `xpath sin resultado: ${expr}`);
            const nodes = [...op.childNodes].map((n) => outDoc.importNode(n, true));
            const position = op.getAttribute('position') || 'inside';
            if (position === 'replace') { for (const n of nodes) target.parentNode.insertBefore(n, target); target.remove(); }
            else if (position === 'after') { for (const n of nodes.reverse()) target.parentNode.insertBefore(n, target.nextSibling); }
            else if (position === 'before') { for (const n of nodes) target.parentNode.insertBefore(n, target); }
            else if (position === 'inside') { for (const n of nodes) target.appendChild(n); }
            else if (position === 'attributes') { for (const a of op.querySelectorAll('attribute')) target.setAttribute(a.getAttribute('name'), a.textContent); }
        }
        out.appendChild(clone);
    }
    return new window.XMLSerializer().serializeToString(out);
}

(async () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://clasificador.example.test/' });
    const w = dom.window;
    w.eval(read(process.env.OWL_PATH));
    const templates = applyInheritance(w, [
        read(path.join(CATALOG, 'classification/classification.xml')),
        read(path.join(CATALOG, 'classification/product_review.xml')),
        read(path.join(CATALOG, 'classification/image_gallery_dialog.xml')),
        read(path.join(CATALOG, 'classification/review_dialog.xml')),
        read(path.join(CATALOG, 'fields/class_badge.xml')),
        read(path.join(MINE, 'workspace.xml')),
        read(path.join(MINE, 'line_editor.xml')),
    ]);
    assert.match(templates, /t-name="biotex_asistente_clasificador\.LineEditorDialog"/);
    assert.match(templates, /bac_editor_brand/);

    // ------------------------------------------------------------ servicios simulados
    const calls = [];
    const base = 'CE-TCL-EKG';
    const line = (id, extra) => ({
        id, product_id: 100 + id, sequence: id * 10, old_name: `PRODUCTO ${id}`, old_reference: '', new_name: `PRODUCTO ${id}`,
        uom_id: 1, uom_name: 'Unidades', consecutive: 0, consecutive_label: '', reference: '', preserve_reference: false, reclassify_from: '',
        reclassified: false, state: 'draft', brand_name: '', measure: '', barcode: '', detail_filled: 0, uom_locked: false, product_uom_id: 1,
        product_uom_name: 'Unidades', images: [], brand_id: false, brand_code: '', brand_short: '', line_class_code: '', pending_code: `${base}-????-??`,
        display_code: `${base}-????-??`, folio: '', folio_number: 0, classified: false, same_classification: false, class_state: 'unclassified',
        missing: 'marca', suggested_brand_id: false, suggested_brand_name: '', product_reference: '', session_root: base, product_root: '', root_mismatch: false, ...extra,
    });
    const lines = [
        line(1, { brand_id: 5, brand_code: 'ZZZZ', brand_short: 'Zeta', consecutive: 1, reference: `${base}-ZZZZ-01`, display_code: `${base}-ZZZZ-01`, folio: '01', folio_number: 1, classified: true, line_class_code: `${base}-ZZZZ` }),
        line(2, { brand_id: 4, brand_code: 'AAAA', brand_short: 'Alfa', consecutive: 2, reference: `${base}-AAAA-02`, display_code: `${base}-AAAA-02`, folio: '02', folio_number: 2, classified: true, line_class_code: `${base}-AAAA` }),
        line(3, { brand_id: 4, brand_code: 'AAAA', brand_short: 'Alfa', consecutive: 1, reference: `${base}-AAAA-01`, display_code: `${base}-AAAA-01`, folio: '01', folio_number: 1, classified: true, line_class_code: `${base}-AAAA` }),
        line(4, { suggested_brand_id: 4, suggested_brand_name: 'AAAA · Alfa' }),
    ];
    const session = () => ({ id: 7, state: 'draft', class_code: base, complete: true, group_id: 1, family_id: 2, classifier_id: 3, brand_id: false,
        brand_per_line: true, pending_count: lines.filter((l) => !l.classified || l.is_new_product).length, pending_code: `${base}-????-??`, lines: lines.map((l) => ({ ...l })) });
    const tree = [{ id: 1, code: 'CE', name: 'Consumibles', axis: 'Equipo', division: 'D', families: [
        { id: 2, code: 'TCL', name: 'Familia', composite: 'CE-TCL', classifiers: [{ id: 3, code: 'EKG', name: 'Electro' }] }] }];
    const records = [
        { id: 101, name: 'PRODUCTO 1', default_code: '', reference: '', brand: '', brand_id: false, locked_by: '', reclassify_from: '', same_classification: false, class_state: 'unclassified', missing: 'marca, clave', images: [], line: lines[0] },
        { id: 104, name: 'PRODUCTO 4', default_code: '', reference: '', brand: 'Alfa', brand_id: 4, locked_by: '', reclassify_from: '', same_classification: false, class_state: 'unclassified', missing: 'clave', images: [{ field: 'image_1920', label: 'Principal', url: '/img', thumb_url: '/thumb', pending: false }], line: lines[3] },
        { id: 200, name: 'YA EN ESTA', default_code: `${base}-AAAA-09`, reference: '', brand: 'Alfa', brand_id: 4, locked_by: '', reclassify_from: '', same_classification: true, class_state: 'complete', missing: '', images: [], line: null },
        { id: 201, name: 'OTRA CLASIF', default_code: 'CE-XXX-EKG-AAAA-01', reference: '', brand: 'Alfa', brand_id: 4, locked_by: '', reclassify_from: 'CE-XXX-EKG-AAAA-01', same_classification: false, class_state: 'complete', missing: '', images: [], line: null },
        { id: 202, name: 'BLOQUEADO', default_code: '', reference: '', brand: '', brand_id: false, locked_by: 'CE-TCL-EKG · 2026-09-12', reclassify_from: '', same_classification: false, class_state: 'no_photo', missing: 'foto', images: [], line: null },
    ];
    let treeReads = 0;
    let brandReads = 0;
    w.services = {
        orm: { call: async (model, method, args, kwargs) => {
            calls.push({ model, method, args, kwargs });
            if (method === 'workspace_bootstrap') return { notice: '', pending_reclassify: [], tree, brands: [], uoms: [{ id: 1, name: 'Unidades' }],
                session: w.classic ? { ...session(), brand_id: 4, brand_per_line: false, can_review: true } : session(), drafts: [] };
            if (method === 'biotex_get_tree') { treeReads++; return tree; }
            if (method === 'workspace_search_products') {
                const filtered = records.filter((r) => !kwargs.review || kwargs.review === 'all' || !!r.reviewed === (kwargs.review === 'reviewed'));
                return { total: filtered.length, offset: 0, limit: 20, records: filtered };
            }
            if (model === 'product.template' && method === 'write') {
                const record = records.find((r) => r.id === args[0][0]);
                record.reviewed = args[1].biotex_reviewed;
                return true;
            }
            if (method === 'clasificador_edit_product') return { line_id: 4, session: session() };
            if (method === 'clasificador_new_product') {
                const id = Math.max(...lines.map((l) => l.id)) + 1;
                lines.push(line(id, { product_id: false, old_name: '', new_name: '', uom_id: false,
                    product_uom_id: false, product_uom_name: '', is_new_product: true }));
                return { line_id: id, session: session() };
            }
            if (method === 'clasificador_cancel_new_product') {
                const index = lines.findIndex((l) => l.id === args[1] && l.is_new_product);
                if (index !== -1) lines.splice(index, 1);
                return session();
            }
            if (method === 'clasificador_create_product') {
                if (w.createError) throw new Error('No se pudo guardar el producto');
                const l = lines.find((l) => l.id === args[1]);
                Object.assign(l, args[2], { is_new_product: false, product_id: 9000 + l.id,
                    old_name: args[2].new_name.toUpperCase(), new_name: args[2].new_name.toUpperCase(), preserve_reference: true });
                return session();
            }
            if (method === 'workspace_line_detail') return { line: { ...(w.detailLine || lines.find((l) => l.id === args[1])), photos: [], country_ids: [], equipment_ids: [], specialty_ids: [], measure_data: [], presentation_data: [] },
                catalogs: { uoms: [{ id: 1, name: 'Unidades' }, { id: 2, name: 'BOLSA' }, { id: 3, name: 'CAJA' }], package_types: [], countries: [], brands: [], specialties: [], contents: [], measure_types: [] },
                classification_brand_id: false, classification_brand_name: '', brand_manufacturer_id: false, brand_manufacturer_name: '',
                brand_hints: [4], pending_code: `${base}-????-??`, session_code: base };
            if (method === 'clasificador_brands') { brandReads++; return [{ id: 4, name: 'Alfa', code: 'AAAA', used: true, manufacturer: '' }, { id: 5, name: 'Zeta', code: 'ZZZZ', used: false, manufacturer: '' }]; }
            if (method === 'clasificador_set_line_brand') {
                const l = lines.find((l) => l.id === args[1]); Object.assign(l, { brand_id: kwargs?.brand_id ?? args[2], brand_code: 'AAAA', brand_short: 'Alfa', brand_name: 'AAAA · Alfa', consecutive: 3, reference: `${base}-AAAA-03`, display_code: `${base}-AAAA-03`, folio: '03', folio_number: 3, classified: true, line_class_code: `${base}-AAAA` });
                return { session: session(), line: { ...l } };
            }
            if (method === 'clasificador_reserve_folio') {
                const l = w.detailLine; Object.assign(l, { consecutive: 1, reference: `${base}-AAAA-01`, display_code: `${base}-AAAA-01`, folio: '01', folio_number: 1, root_mismatch: false, product_root: base, session_root: base });
                return { session: session(), line: { ...l } };
            }
            if (method === 'workspace_update_line') return session();
            throw new Error('RPC no simulado: ' + method);
        } },
        action: { doAction() {} }, notification: { add: (m) => w.notifications.push(m) },
        dialog: { add: (component, props, options) => { w.dialogs.push({ component, props, options }); } },
    };
    w.notifications = []; w.dialogs = [];
    const sources = [
        'classification/reference.js', 'classification/image_gallery_dialog.js', 'classification/review_dialog.js', 'classification/line_editor.js',
        'classification/classification.js', 'fields/class_badge.js',
    ].map((f) => strip(read(path.join(CATALOG, f)))).concat(['line_editor.js', 'workspace.js'].map((f) => strip(read(path.join(MINE, f)))));
    w.eval(`const {Component, useState, useRef, onWillStart, onWillUnmount, onMounted, onPatched, markup} = owl;
        const useService = (name) => window.services[name];
        const useDebounced = (fn) => Object.assign(() => fn(), { cancel() {} });
        const _t = (text, ...args) => { let i = 0; return String(text).replace(/%s/g, () => args[i++]); };
        const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const registry = { category: () => ({ add() {} }) };
        const standardFieldProps = { name: String, record: Object, readonly: { type: Boolean, optional: true }, id: { type: String, optional: true } };
        class Dialog extends Component { static template = owl.xml\`<section class="o_dialog"><header><t t-slot="header"/></header><t t-slot="default"/><footer><t t-slot="footer"/></footer></section>\`; static props = { '*': true }; }
        class ConfirmationDialog extends Component { static template = owl.xml\`<div/>\`; static props = ['*']; }
        ${sources.join('\n')}
        window.ClassicWorkspace = BiotexClassificationWorkspace;
        window.Workspace = BiotexClasificadorWorkspace; window.Editor = BiotexClasificadorLineEditorDialog;`);
    const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

    // ------------------------------------------------------------ asistente: pasos 1, 2 y 3
    const app = new w.owl.App(w.Workspace, { templates, dev: true, props: { action: { context: { biotex_session_id: 7 } } } });
    const ws = await app.mount(w.document.body);
    await tick();
    const doc = w.document;
    assert.equal(calls[0].method, 'workspace_bootstrap');
    assert.equal(calls[0].kwargs.context.clasificador, true, 'el bootstrap se pide con el contexto del clasificador');
    assert.equal(ws.state.stage, 2, 'con productos pendientes se abre el paso 2');
    // paso 1: tres niveles, sin marca, con llave pendiente
    ws.toggleCollapse(1); await tick();
    assert.equal(doc.querySelectorAll('.o_bac_levels .o_bcw_pick').length, 3, 'grupo, familia y clasificador');
    assert.ok(!doc.querySelector('.o_bac_levels .o_bcw_tone_brand'), 'la marca no es un nivel del paso 1');
    assert.match(doc.querySelector('.o_bcw_summary .o_bcw_code').textContent, /CE-TCL-EKG-\?\?\?\?-\?\?/);
    await ws.togglePicker('family'); await tick();
    assert.equal(treeReads, 1, 'abrir el selector relee el catálogo');
    await ws.togglePicker('family'); await ws.togglePicker('classifier'); await tick();
    assert.equal(treeReads, 2, 'cada apertura vuelve a leer');
    ws.toggleCollapse(1); await tick();
    // paso 2: badges, código pendiente y acciones
    const rows = [...doc.querySelectorAll('.o_bac_table tbody tr[data-product-id]')];
    assert.equal(rows.length, records.length, 'los productos ya agregados siguen en el resultado');
    assert.equal(doc.querySelectorAll('.o_bac_table .badge').length, records.length, 'badge biotex_class_state en cada fila');
    assert.match(rows[0].textContent, /Completo|Sin clasificar|Sin foto/);
    assert.match(rows[0].querySelector('.o_bcw_mono').textContent, /CE-TCL-EKG-ZZZZ-01/);
    assert.match(rows[1].textContent, /Marca pendiente/);
    assert.match(rows[1].querySelector('.o_bac_code_pending').textContent, /CE-TCL-EKG-\?\?\?\?-\?\?/);
    assert.match(rows[2].textContent, /Ya en esta clasificación/);
    assert.match(rows[3].textContent, /Otra clasificación/);
    assert.ok(rows[3].classList.contains('o_bcw_row_reclassified'));
    assert.match(rows[4].textContent, /En clasificación/);
    assert.ok(!doc.querySelector('.o_bac_table .fa-trash-o, .o_bac_table .o_bcw_danger'), 'ninguna acción de eliminar en el paso 2');
    assert.ok(rows[1].querySelector('.o_bac_edit') && rows[2].querySelector('.o_bac_edit') && !rows[4].querySelector('.o_bac_edit'), 'Editar salvo en otra sesión');
    assert.equal(doc.querySelectorAll('.o_bac_table .o_bcw_add').length, 0, 'no hay Agregar en ningún resultado');
    for (const row of rows.slice(0, 4)) {
        assert.equal(row.querySelectorAll('.o_bac_actions button').length, 1, 'Editar es la única acción por producto');
        assert.match(row.querySelector('.o_bac_actions button').textContent, /Editar/);
    }
    rows[3].querySelector('.o_bac_edit').click(); await tick();
    assert.equal(w.dialogs.at(-1).component.name, 'ConfirmationDialog', 'editar un producto de otra clasificación pide aceptar');
    rows[2].querySelector('.o_bac_edit').click(); await tick();
    assert.equal(calls.at(-1).method, 'clasificador_edit_product', 'Editar sin +Agregar agrega la línea');
    assert.equal(w.dialogs.at(-1).component.name, 'BiotexClasificadorLineEditorDialog');
    ws.state.search.selectedId = 200;
    await ws.onSearchKeydown({ key: 'Enter', preventDefault() {} }); await tick();
    assert.equal(calls.at(-1).method, 'clasificador_edit_product', 'Enter abre Editar');
    const savedRecords = records.splice(0, records.length, records[2]);
    ws.state.scan = true;
    await ws.onSearchKeydown({ key: 'Enter', preventDefault() {} }); await tick();
    assert.equal(calls.at(-1).method, 'clasificador_edit_product', 'el lector también abre Editar');
    assert.ok(!calls.some((call) => call.method === 'workspace_add_products'), 'ninguna acción usa la incorporación sin edición');
    records.splice(0, records.length, ...savedRecords);
    ws.state.scan = false;
    // Revisión independiente: estado visible para todos; escritura solo para revisores.
    await ws.runSearch(0); await tick();
    assert.equal(doc.querySelectorAll('[aria-label^="Marcar revisado:"]').length, 0);
    assert.match(doc.querySelector('[data-product-id="200"]').textContent, /Completo/);
    assert.match(doc.querySelector('[data-product-id="200"]').textContent, /Pendiente de revisar/);
    ws.state.session.can_review = true; await tick();
    const reviewSelect = doc.querySelector('#biotex_review_filter');
    reviewSelect.value = 'pending';
    reviewSelect.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
    assert.equal(calls.at(-1).kwargs.review, 'pending');
    doc.querySelector('[data-product-id="200"] [aria-label^="Marcar revisado:"]').click(); await tick();
    assert.ok(!doc.querySelector('[data-product-id="200"]'), 'sale de pendientes después de guardar');
    assert.equal(records.find((r) => r.id === 200).reviewed, true);
    reviewSelect.value = 'reviewed';
    reviewSelect.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
    assert.equal(doc.querySelectorAll('.o_bac_table [data-product-id]').length, 1);
    assert.match(doc.querySelector('[data-product-id="200"]').textContent, /Revisado/);
    doc.querySelector('[data-product-id="200"] [aria-label^="Marcar pendiente de revisar:"]').click(); await tick();
    assert.equal(records.find((r) => r.id === 200).reviewed, false);
    assert.equal(doc.querySelectorAll('.o_bac_table [data-product-id]').length, 0);
    reviewSelect.value = 'all';
    reviewSelect.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
    assert.equal(doc.querySelectorAll('.o_bac_table [data-product-id]').length, records.length);
    // paso 3: solo lectura, por marca y folio, con pendientes aparte
    ws.goStage(3); await tick();
    const done = [...doc.querySelectorAll('.o_bac_table_done tbody tr')].map((tr) => tr.children[3].textContent.trim());
    assert.deepEqual(done, [`${base}-AAAA-01`, `${base}-AAAA-02`, `${base}-ZZZZ-01`], 'orden por marca y folio');
    assert.ok(!doc.querySelector('.o_bac_table_done input, .o_bac_table_done select, .o_bac_table_done .o_bcw_grip, .o_bac_table_done .fa-trash-o'), 'sin edición en línea, borrado ni arrastre');
    // cambio 1: columna Acciones con el lápiz (mismo modal que el paso 2, precargado con la línea de la fila)
    assert.match(doc.querySelector('.o_bac_table_done thead').textContent, /Acciones/);
    const pencils = doc.querySelectorAll('.o_bac_table_done tbody .o_bac_edit3 .fa-pencil');
    assert.equal(pencils.length, 3, 'un lápiz por producto clasificado');
    const dialogsBefore = w.dialogs.length;
    doc.querySelectorAll('.o_bac_table_done tbody .o_bac_edit3')[1].click(); await tick();
    assert.equal(w.dialogs.length, dialogsBefore + 1);
    assert.equal(w.dialogs.at(-1).component.name, 'BiotexClasificadorLineEditorDialog', 'el lápiz del paso 3 abre el modal de edición');
    assert.equal(w.dialogs.at(-1).props.lineId, 2, 'precargado con la línea de la fila (AAAA-02)');
    assert.equal(w.dialogs.at(-1).props.classCode, `${base}-AAAA-02`);
    assert.match(doc.querySelector('.o_bac_pending').textContent, /1 producto\(s\) sin marca/);
    assert.match(doc.querySelector('.o_bcw_stage3_meta [role="status"]').textContent, /Clasificados:\s*3\s*· Marcas:\s*2\s*·\s*Sin marca:\s*1/);
    assert.equal(doc.querySelector('.o_bcw_foot .btn-primary').disabled, true, 'Generar claves bloqueado con pendientes');
    // refresco en vivo: una edición devuelve la sesión y el paso 3 se reubica solo
    lines[3] = { ...lines[3], brand_id: 4, brand_code: 'AAAA', brand_short: 'Alfa', consecutive: 3, reference: `${base}-AAAA-03`, display_code: `${base}-AAAA-03`, folio: '03', folio_number: 3, classified: true };
    w.dialogs.at(-1).props.onSaved(session()); await tick();
    assert.equal(doc.querySelectorAll('.o_bac_table_done tbody tr').length, 4, 'la línea recién clasificada se inserta');
    assert.ok(!doc.querySelector('.o_bac_pending'));
    assert.match(doc.querySelector('.o_bcw_stage3_meta [role="status"]').textContent, /Clasificados:\s*4\s*· Marcas:\s*2/);
    assert.doesNotMatch(doc.querySelector('.o_bcw_stage3_meta [role="status"]').textContent, /Sin marca/);
    assert.equal(doc.querySelector('.o_bcw_foot .btn-primary').disabled, false);
    // reubicación por cambio de marca (caso B): la línea 1 pasa de Zeta a Alfa
    lines[0] = { ...lines[0], brand_id: 4, brand_code: 'AAAA', brand_short: 'Alfa', consecutive: 4, reference: `${base}-AAAA-04`, display_code: `${base}-AAAA-04`, folio: '04', folio_number: 4 };
    w.dialogs.at(-1).props.onBrandChanged(session()); await tick();
    assert.deepEqual([...doc.querySelectorAll('.o_bac_table_done tbody tr')].map((tr) => tr.children[3].textContent.trim()),
        [`${base}-AAAA-01`, `${base}-AAAA-02`, `${base}-AAAA-03`, `${base}-AAAA-04`], 'reubicación por marca y folio');
    app.destroy();

    // Los controles compartidos también funcionan en el Clasificador por Grupos.
    w.classic = true;
    const classicApp = new w.owl.App(w.ClassicWorkspace, { templates, dev: true, props: { action: { context: {} } } });
    const classic = await classicApp.mount(w.document.body);
    classic.goStage(2); await tick();
    const classicFilter = doc.querySelector('#biotex_review_filter');
    assert.ok(classicFilter);
    doc.querySelector('[data-product-id="200"] [aria-label^="Marcar revisado:"]').click(); await tick();
    assert.equal(records.find((r) => r.id === 200).reviewed, true);
    classicFilter.value = 'reviewed';
    classicFilter.dispatchEvent(new w.Event('change', { bubbles: true })); await tick();
    assert.equal(doc.querySelectorAll('[data-product-id]').length, 1);
    doc.querySelector('[data-product-id="200"] [aria-label^="Marcar pendiente de revisar:"]').click(); await tick();
    assert.equal(doc.querySelectorAll('[data-product-id]').length, 0);
    classicApp.destroy();
    w.classic = false;

    // ------------------------------------------------------------ modal: marca, catálogo fresco y confirmación
    lines[3] = line(4, { suggested_brand_id: 4, suggested_brand_name: 'AAAA · Alfa' });
    const editorApp = new w.owl.App(w.Editor, { templates, dev: true, props: {
        close() {}, lineId: 4, sessionId: 7, classCode: `${base}-????-??`, readonly: false, onSaved() {}, onBrandChanged: (s) => { w.lastSession = s; } } });
    const editor = await editorApp.mount(w.document.body);
    await tick();
    const brandBlock = doc.querySelector('.o_bac_brand');
    assert.ok(brandBlock, 'el campo Marca está debajo del nombre');
    assert.equal(brandBlock.previousElementSibling.querySelector('#bcw_editor_name') !== null, true);
    assert.match(doc.querySelector('.o_bcw_modal_ref').textContent, /CE-TCL-EKG-\?\?\?\?-\?\?/, 'referencia pendiente en el encabezado');
    assert.match(brandBlock.textContent, /AAAA · Alfa/, 'la marca de la ficha se sugiere');
    editor.clearPendingBrand(); await tick();
    const input = doc.querySelector('#bac_editor_brand');
    input.dispatchEvent(new w.Event('focus')); await tick();
    assert.equal(brandReads, 1, 'abrir el selector lee el catálogo de marcas');
    assert.equal(doc.querySelectorAll('.o_bac_brand_lookup .o_bcw_lookup_item').length, 2);
    input.value = 'Nueva marca'; input.dispatchEvent(new w.Event('input')); await tick();
    assert.equal(brandReads, 2, 'cada tecleo vuelve a leer');
    assert.ok(doc.querySelector('.o_bac_brand_create'), 'se ofrece crear la marca');
    input.value = ''; input.dispatchEvent(new w.Event('input')); await tick();
    doc.querySelectorAll('.o_bac_brand_lookup .o_bcw_lookup_item')[0].click(); await tick();
    assert.match(doc.querySelector('.o_bac_chip_pending').textContent, /AAAA · Alfa/);
    assert.equal(doc.querySelector('.o_bac_brand_confirm').disabled, false);
    doc.querySelector('.o_bac_brand_confirm').click(); await tick();
    assert.equal(calls.at(-1).method, 'clasificador_set_line_brand');
    assert.equal(JSON.stringify(calls.at(-1).args), '[[7],4,4]');
    assert.ok(w.lastSession, 'la confirmación de la marca refresca el paso 3');
    assert.match(doc.querySelector('.o_bcw_modal_ref').textContent, /CE-TCL-EKG-AAAA-03/, 'la referencia final aparece al momento');
    assert.match(doc.querySelector('.o_bac_brand_current').textContent, /folio 03/);
    assert.equal(doc.querySelector('#bac_editor_brand').readOnly, false, 'la marca sigue editable');

    // ------------------------------------------------------------ cambio 3: "Unidades y empaques" en una sola tabla
    assert.ok(!doc.querySelector('[aria-label="Empacados de productos y códigos de barras"]'), 'la sección de empacados aparte desaparece');
    assert.ok(!doc.querySelector('.o_bcw_grid #bcw_editor_uom'), 'la unidad indivisible deja de ser un campo suelto');
    const units = doc.querySelector('[aria-label="Unidades y empaques"]');
    assert.ok(units, 'sección unificada');
    assert.match(units.querySelector('thead').textContent, /Tipo de empaque.*Cantidad de elementos.*Código de barras/s);
    const baseRow = units.querySelector('tbody tr');
    assert.ok(baseRow.classList.contains('o_bac_unit_base'), 'la primera fila es la unidad base');
    assert.match(baseRow.children[0].textContent, /Unidades · Unidad base/);
    assert.ok(baseRow.querySelector('.fa-key'), 'ícono de llave');
    assert.ok(!baseRow.querySelector('select'), 'la unidad base se muestra como texto fijo');
    const baseQty = baseRow.children[1].querySelector('input');
    assert.equal(baseQty.disabled, false); assert.equal(baseQty.readOnly, false); assert.equal(baseQty.value, '1');
    const description = doc.querySelector('#bac_base_unit_description');
    assert.equal(description.readOnly, true);
    assert.equal(description.value, 'UNIDADES CON 1');
    baseQty.value = '3'; baseQty.dispatchEvent(new w.Event('input')); await tick();
    assert.equal(description.value, 'UNIDADES CON 3', 'la descripción responde a la cantidad');
    for (const value of ['', '0', '-2']) {
        baseQty.value = value; baseQty.dispatchEvent(new w.Event('input')); await tick();
        assert.equal(editor.validate(), false);
        assert.ok(editor.state.errors.base_unit_quantity);
    }
    baseQty.value = '2.5'; baseQty.dispatchEvent(new w.Event('input')); await tick();
    assert.equal(editor.validate(), true, 'se aceptan cantidades decimales positivas');
    assert.equal(description.value, 'UNIDADES CON 2.5');
    baseQty.value = '3'; baseQty.dispatchEvent(new w.Event('input')); await tick();
    const baseBarcode = baseRow.querySelector('.o_bac_unit_barcode');
    assert.equal(baseBarcode.readOnly, false, 'el código de barras de la unidad base sí se edita');
    baseBarcode.value = '7501234567890'; baseBarcode.dispatchEvent(new w.Event('input')); await tick();
    assert.equal(editor.state.draft.barcode, '7501234567890');
    assert.ok(!baseRow.querySelector('.o_bac_unit_lock, .fa-trash'), 'sin candado de cantidad ni eliminar');
    // la unidad base sigue pudiéndose cambiar (sin movimientos) con "Cambiar unidad"
    baseRow.querySelector('.o_bac_unit_change').click(); await tick();
    assert.ok(units.querySelector('tr.o_bac_unit_base select#bcw_editor_uom'), 'el selector aparece dentro de la fila base');
    const selectUnit = units.querySelector('#bcw_editor_uom');
    selectUnit.value = '2'; selectUnit.dispatchEvent(new w.Event('change')); await tick();
    assert.equal(description.value, 'BOLSA CON 3', 'la descripción responde al cambio de unidad');
    editor.startUomEdit(); await tick();
    const selectBox = units.querySelector('#bcw_editor_uom');
    selectBox.value = '3'; selectBox.dispatchEvent(new w.Event('change'));
    baseQty.value = '10'; baseQty.dispatchEvent(new w.Event('input')); await tick();
    assert.equal(description.value, 'CAJA CON 10');
    await editor.save();
    assert.equal(calls.at(-1).method, 'workspace_update_line');
    assert.equal(calls.at(-1).args[2].base_unit_quantity, 10, 'guardar envía el contenido propio de la unidad');
    editor.state.draft.uom_id = 1;
    editor.cancelUomEdit(); await tick();
    assert.ok(!units.querySelector('tr.o_bac_unit_base select'));
    // empacados: debajo de la fila base, con su eliminar, y "Agregar empacado" al final de la misma tabla
    units.querySelector('.o_bac_add_pack').click(); await tick();
    const rowsU = [...units.querySelectorAll('tbody tr')];
    assert.equal(rowsU.length, 2);
    assert.ok(rowsU[0].classList.contains('o_bac_unit_base') && rowsU[1].classList.contains('o_bac_unit_pack'), 'la fila base va siempre primero');
    assert.ok(rowsU[1].querySelector('select') && rowsU[1].querySelector('.fa-trash'), 'empacado con tipo por combo y eliminar');
    assert.match(rowsU[1].children[1].textContent, /Unidades/, 'cantidad en la unidad base');
    editorApp.destroy();

    // fila base bloqueada por movimientos de inventario: sin "Cambiar unidad", con el mensaje de conservación
    w.detailLine = line(4, { uom_locked: true, base_unit_quantity: 3 });
    const lockedApp = new w.owl.App(w.Editor, { templates, dev: true, props: { close() {}, lineId: 4, sessionId: 7, classCode: `${base}-????-??`, readonly: false, onSaved() {}, onBrandChanged() {} } });
    const lockedEditor = await lockedApp.mount(w.document.body); await tick();
    const lockedRow = doc.querySelector('[aria-label="Unidades y empaques"] tbody tr.o_bac_unit_base');
    assert.ok(!lockedRow.querySelector('.o_bac_unit_change'), 'con movimientos no se ofrece cambiar la unidad');
    assert.match(lockedRow.textContent, /esa unidad se conserva/);
    const lockedQty = lockedRow.querySelector('[aria-label="Cantidad de elementos de la unidad base"]');
    assert.equal(lockedQty.value, '3', 'se recupera la cantidad guardada');
    assert.equal(lockedEditor.dirty, false, 'cargar el contenido no crea cambios pendientes');
    assert.equal(lockedQty.readOnly, false, 'los movimientos no bloquean el contenido informativo');
    lockedEditor.startUomEdit(); await tick();
    assert.ok(!lockedRow.querySelector('select'), 'ni por código');
    lockedApp.destroy();
    const readonlyApp = new w.owl.App(w.Editor, { templates, dev: true, props: { close() {}, lineId: 4, sessionId: 7, readonly: true, onSaved() {}, onBrandChanged() {} } });
    await readonlyApp.mount(w.document.body); await tick();
    assert.equal(doc.querySelector('[aria-label="Cantidad de elementos de la unidad base"]').readOnly, true, 'la sesión confirmada sigue en solo lectura');
    readonlyApp.destroy();

    // ------------------------------------------------------------ cambio 2: regla de raíz al guardar
    w.detailLine = line(4, { brand_id: 4, brand_code: 'AAAA', brand_short: 'Alfa', brand_name: 'AAAA · Alfa', consecutive: 7, reference: 'CE-XXX-EKG-AAAA-07', display_code: 'CE-XXX-EKG-AAAA-07',
        folio: '07', folio_number: 7, classified: true, line_class_code: `${base}-AAAA`, session_root: base, product_root: 'CE-XXX-EKG', root_mismatch: true });
    const rootApp = new w.owl.App(w.Editor, { templates, dev: true, props: { close() {}, lineId: 4, sessionId: 7, classCode: 'CE-XXX-EKG-AAAA-07', readonly: false, onSaved() {}, onBrandChanged: (s) => { w.rootSession = s; } } });
    const rootEditor = await rootApp.mount(w.document.body); await tick();
    assert.ok(doc.querySelector('.o_bac_root_warn'), 'aviso de raíz cambiada');
    assert.match(doc.querySelector('.o_bac_root_warn').textContent, /La raíz de clasificación cambió; se debe reservar un folio nuevo/);
    assert.match(doc.querySelector('.o_bac_root_warn').textContent, /CE-XXX-EKG/);
    assert.equal(doc.querySelector('.o_bac_brand_confirm').disabled, false, 'el botón de reservar folio se habilita sin cambiar la marca');
    assert.match(doc.querySelector('.o_bac_brand_confirm').textContent, /Cambiar marca y reservar folio/);
    const callsBefore = calls.length;
    rootEditor.save(); await tick();
    assert.ok(!calls.slice(callsBefore).some((c) => c.method === 'workspace_update_line'), 'no se guarda con la referencia inconsistente');
    assert.equal(w.dialogs.at(-1).component.name, 'ConfirmationDialog');
    assert.match(w.dialogs.at(-1).props.title, /raíz de clasificación cambió/);
    assert.match(w.dialogs.at(-1).props.body, /CE-TCL-EKG-AAAA/, 'la llave destino conserva la marca');
    await w.dialogs.at(-1).props.confirm(); await tick(60);
    const after = calls.slice(callsBefore).map((c) => c.method);
    assert.deepEqual(after.filter((m) => ['clasificador_reserve_folio', 'workspace_update_line'].includes(m)), ['clasificador_reserve_folio', 'workspace_update_line'], 'reserva folio nuevo y después guarda');
    assert.ok(w.rootSession, 'la reserva refresca el paso 3');
    assert.ok(!doc.querySelector('.o_bac_root_warn'), 'con la raíz vigente desaparece el aviso');
    assert.match(doc.querySelector('.o_bcw_modal_ref').textContent, /CE-TCL-EKG-AAAA-01/);
    // el botón Cambiar marca y reservar folio se desactiva de nuevo hasta elegir otra marca
    assert.equal(doc.querySelector('.o_bac_brand_confirm').disabled, true);
    rootApp.destroy();

    // ------------------------------------------------------------ alta desde cero y regreso al mismo editor
    delete w.detailLine;
    const newWorkspaceApp = new w.owl.App(w.Workspace, { templates, dev: true,
        props: { action: { context: { biotex_session_id: 7 } } } });
    const newWorkspace = await newWorkspaceApp.mount(w.document.body); await tick();
    const newButton = doc.querySelector('.o_bac_new_product');
    assert.ok(newButton, 'Nuevo está en el encabezado de la sección 2');
    assert.ok(newButton.closest('.o_bac_search_head'));
    assert.equal(newButton.disabled, false);
    newWorkspace.state.pick.classifier = false; await tick();
    assert.equal(newButton.disabled, true, 'misma condición de llave base completa');
    const beforeDisabled = calls.length;
    await newWorkspace.newProduct();
    assert.equal(calls.length, beforeDisabled, 'sin llave no llama al servidor');
    newWorkspace.state.pick.classifier = 3; await tick();
    assert.equal(newButton.disabled, false);
    newWorkspace.state.busy = true; await tick();
    assert.equal(newButton.disabled, true, 'evita altas durante otra operación');
    newWorkspace.state.busy = false;
    newWorkspace.state.session.state = 'confirmed'; await tick();
    assert.equal(newButton.disabled, true, 'una sesión aplicada es de consulta');
    newWorkspace.state.session.state = 'draft'; await tick();
    newButton.click(); await tick();
    const newDialog = w.dialogs.at(-1);
    assert.equal(newDialog.component, w.Editor, 'reutiliza el editor estándar');
    assert.equal(newDialog.props.newProduct, true);
    assert.equal(newWorkspace.pendingLines.at(-1).is_new_product, true);
    let closes = 0;
    const newEditorApp = new w.owl.App(w.Editor, { templates, dev: true, props: {
        ...newDialog.props, close() { closes++; },
    } });
    const newEditor = await newEditorApp.mount(w.document.body); await tick();
    let title = doc.querySelector('.o_bac_editor_title');
    assert.ok(title.classList.contains('o_bac_editor_title_new'), 'título de alta con acento');
    assert.ok(title.querySelector('.fa-plus-circle'), 'ícono de crear');
    assert.match(title.textContent, /Nuevo producto/);
    assert.equal(title.querySelector('.o_bac_new_badge').textContent, 'NUEVO');
    const reference = doc.querySelector('.o_bcw_modal_ref');
    assert.equal(reference.getAttribute('aria-label'), 'Referencia pendiente');
    assert.match(reference.textContent, /Referencia pendiente: el folio se reserva al confirmar la marca/);
    for (const [tone, text] of [['group', 'CE'], ['family', 'TCL'], ['classifier', 'EKG']]) {
        assert.equal(reference.querySelector(`.o_bcw_tone_${tone}`).textContent, text, 'conserva el color del segmento');
    }
    assert.equal(reference.querySelector('.o_bcw_tone_consecutive').textContent, '????', 'placeholder neutro');
    for (const field of ['new_name', 'uom_id', 'manufacturer_id', 'barcode', 'notes', 'model',
                         'description_extra', 'base_unit_quantity', 'package_type_id']) {
        assert.ok(!newEditor.state.draft[field], `${field} empieza vacío`);
    }
    assert.equal(doc.querySelector('#bcw_editor_uom').value, '', 'unidad sin precargar');
    assert.equal(doc.querySelector('[aria-label="Cantidad de elementos de la unidad base"]').value, '');
    assert.equal(newEditor.state.draft.presentation_data.length, 0);
    assert.equal(newEditor.state.draft.measure_data.length, 0);
    assert.equal(newEditor.brandPendingId, false);
    Object.assign(newEditor.state.draft, { new_name: 'Insumo nuevo', uom_id: 1, base_unit_quantity: 3 });
    const beforeBrand = calls.length;
    await newEditor.save(); await tick();
    assert.ok(newEditor.state.errors.brand_id, 'marca y folio obligatorios para alta');
    assert.ok(!calls.slice(beforeBrand).some((c) => c.method === 'clasificador_create_product'));
    await newEditor.applyBrand(4); await tick();
    assert.ok(!newEditor.state.errors.brand_id);
    assert.equal(reference.getAttribute('aria-label'), 'Referencia final');
    assert.match(reference.textContent, /Referencia final: el folio se reservó al confirmar la marca/);
    assert.equal(newEditor.state.draft.new_name, 'Insumo nuevo', 'confirmar marca no borra lo capturado');
    assert.ok(!newWorkspace.classifiedLines.some((l) => l.id === newDialog.props.lineId), 'el borrador no es un producto creado');
    w.createError = true;
    await newEditor.save(); await tick();
    assert.equal(closes, 0, 'un error mantiene abierto el modal y preserva datos');
    assert.equal(newEditor.state.draft.new_name, 'Insumo nuevo');
    assert.equal(newEditor.state.saving, false);
    w.createError = false;
    const beforeSave = calls.length;
    await newEditor.save(); await tick();
    assert.equal(closes, 1);
    assert.deepEqual(calls.slice(beforeSave).map((c) => c.method), ['clasificador_create_product']);
    const created = newWorkspace.classifiedLines.find((l) => l.id === newDialog.props.lineId);
    assert.ok(created?.product_id, 'Guardar incorpora el nuevo producto a la sección 3');
    await newDialog.options.onClose();
    assert.ok(!calls.slice(beforeSave).some((c) => c.method === 'clasificador_cancel_new_product'));
    newEditorApp.destroy();
    await newWorkspace.editLine(created);
    const existingDialog = w.dialogs.at(-1);
    const existingApp = new w.owl.App(w.Editor, { templates, dev: true, props: { ...existingDialog.props, close() {} } });
    await existingApp.mount(w.document.body); await tick();
    title = doc.querySelector('.o_bac_editor_title');
    assert.match(title.textContent, /Editando Producto: INSUMO NUEVO/);
    assert.ok(title.querySelector('.fa-pencil-square-o'));
    assert.ok(!title.classList.contains('o_bac_editor_title_new'));
    assert.ok(!title.querySelector('.o_bac_new_badge'), 'el editor de existentes no muestra NUEVO');
    existingApp.destroy();
    await newWorkspace.newProduct();
    const cancelledDialog = w.dialogs.at(-1);
    await cancelledDialog.options.onClose(); await tick();
    assert.ok(!newWorkspace.lines.some((l) => l.id === cancelledDialog.props.lineId), 'cerrar descarta solo el borrador nuevo');
    assert.ok(newWorkspace.lines.some((l) => l.id === created.id), 'el alta guardada se conserva');
    newWorkspaceApp.destroy();
    dom.window.close();
    console.log('Clasificador Global: OWL OK; revisión y filtros en ambos clasificadores, edición, unidades, raíz, alta vacía, señales visuales, marca, guardado, sección 3 y cancelación');
})().catch((error) => { console.error(error); process.exit(1); });
