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
        missing: 'marca', suggested_brand_id: false, suggested_brand_name: '', product_reference: '', ...extra,
    });
    const lines = [
        line(1, { brand_id: 5, brand_code: 'ZZZZ', brand_short: 'Zeta', consecutive: 1, reference: `${base}-ZZZZ-01`, display_code: `${base}-ZZZZ-01`, folio: '01', folio_number: 1, classified: true, line_class_code: `${base}-ZZZZ` }),
        line(2, { brand_id: 4, brand_code: 'AAAA', brand_short: 'Alfa', consecutive: 2, reference: `${base}-AAAA-02`, display_code: `${base}-AAAA-02`, folio: '02', folio_number: 2, classified: true, line_class_code: `${base}-AAAA` }),
        line(3, { brand_id: 4, brand_code: 'AAAA', brand_short: 'Alfa', consecutive: 1, reference: `${base}-AAAA-01`, display_code: `${base}-AAAA-01`, folio: '01', folio_number: 1, classified: true, line_class_code: `${base}-AAAA` }),
        line(4, { suggested_brand_id: 4, suggested_brand_name: 'AAAA · Alfa' }),
    ];
    const session = () => ({ id: 7, state: 'draft', class_code: base, complete: true, group_id: 1, family_id: 2, classifier_id: 3, brand_id: false,
        brand_per_line: true, pending_count: lines.filter((l) => !l.classified).length, pending_code: `${base}-????-??`, lines: lines.map((l) => ({ ...l })) });
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
            if (method === 'workspace_bootstrap') return { notice: '', pending_reclassify: [], tree, brands: [], uoms: [{ id: 1, name: 'Unidades' }], session: session(), drafts: [] };
            if (method === 'biotex_get_tree') { treeReads++; return tree; }
            if (method === 'workspace_search_products') return { total: records.length, offset: 0, limit: 20, records };
            if (method === 'clasificador_edit_product') return { line_id: 4, session: session() };
            if (method === 'workspace_line_detail') return { line: { ...lines[3], photos: [], country_ids: [], equipment_ids: [], specialty_ids: [], measure_data: [], presentation_data: [] },
                catalogs: { uoms: [{ id: 1, name: 'Unidades' }], package_types: [], countries: [], brands: [], specialties: [], contents: [], measure_types: [] },
                classification_brand_id: false, classification_brand_name: '', brand_manufacturer_id: false, brand_manufacturer_name: '',
                brand_hints: [4], pending_code: `${base}-????-??`, session_code: base };
            if (method === 'clasificador_brands') { brandReads++; return [{ id: 4, name: 'Alfa', code: 'AAAA', used: true, manufacturer: '' }, { id: 5, name: 'Zeta', code: 'ZZZZ', used: false, manufacturer: '' }]; }
            if (method === 'clasificador_set_line_brand') {
                const l = lines[3]; Object.assign(l, { brand_id: kwargs?.brand_id ?? args[2], brand_code: 'AAAA', brand_short: 'Alfa', brand_name: 'AAAA · Alfa', consecutive: 3, reference: `${base}-AAAA-03`, display_code: `${base}-AAAA-03`, folio: '03', folio_number: 3, classified: true, line_class_code: `${base}-AAAA` });
                return { session: session(), line: { ...l } };
            }
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
    assert.ok(!rows[0].querySelector('.o_bcw_add') && rows[2].querySelector('.o_bcw_add'), '+Agregar solo para productos fuera de la sesión');
    assert.equal(rows[1].querySelector('.o_bac_actions .o_bcw_icon_btn').disabled, false, 'Ver imágenes activo con imagen');
    assert.equal(rows[0].querySelector('.o_bac_actions .o_bcw_icon_btn').disabled, true, 'Ver imágenes inactivo sin imagen');
    rows[1].querySelector('.o_bac_actions .o_bcw_icon_btn').click(); await tick();
    assert.equal(w.dialogs.at(-1).props.images.length, 1, 'Ver imágenes abre la galería con las imágenes del producto');
    rows[3].querySelector('.o_bac_edit').click(); await tick();
    assert.equal(w.dialogs.at(-1).component.name, 'ConfirmationDialog', 'editar un producto de otra clasificación pide aceptar');
    rows[2].querySelector('.o_bac_edit').click(); await tick();
    assert.equal(calls.at(-1).method, 'clasificador_edit_product', 'Editar sin +Agregar agrega la línea');
    assert.equal(w.dialogs.at(-1).component.name, 'BiotexClasificadorLineEditorDialog');
    // paso 3: solo lectura, por marca y folio, con pendientes aparte
    ws.goStage(3); await tick();
    const done = [...doc.querySelectorAll('.o_bac_table_done tbody tr')].map((tr) => tr.children[3].textContent.trim());
    assert.deepEqual(done, [`${base}-AAAA-01`, `${base}-AAAA-02`, `${base}-ZZZZ-01`], 'orden por marca y folio');
    assert.ok(!doc.querySelector('.o_bac_table_done input, .o_bac_table_done select, .o_bac_table_done .o_bcw_grip, .o_bac_table_done .fa-pencil, .o_bac_table_done .fa-trash-o'), 'sin edición, borrado ni arrastre');
    assert.match(doc.querySelector('.o_bac_pending').textContent, /1 producto\(s\) sin marca/);
    assert.equal(doc.querySelector('.o_bcw_foot .btn-primary').disabled, true, 'Generar claves bloqueado con pendientes');
    // refresco en vivo: una edición devuelve la sesión y el paso 3 se reubica solo
    lines[3] = { ...lines[3], brand_id: 4, brand_code: 'AAAA', brand_short: 'Alfa', consecutive: 3, reference: `${base}-AAAA-03`, display_code: `${base}-AAAA-03`, folio: '03', folio_number: 3, classified: true };
    w.dialogs.at(-1).props.onSaved(session()); await tick();
    assert.equal(doc.querySelectorAll('.o_bac_table_done tbody tr').length, 4, 'la línea recién clasificada se inserta');
    assert.ok(!doc.querySelector('.o_bac_pending'));
    assert.equal(doc.querySelector('.o_bcw_foot .btn-primary').disabled, false);
    // reubicación por cambio de marca (caso B): la línea 1 pasa de Zeta a Alfa
    lines[0] = { ...lines[0], brand_id: 4, brand_code: 'AAAA', brand_short: 'Alfa', consecutive: 4, reference: `${base}-AAAA-04`, display_code: `${base}-AAAA-04`, folio: '04', folio_number: 4 };
    w.dialogs.at(-1).props.onBrandChanged(session()); await tick();
    assert.deepEqual([...doc.querySelectorAll('.o_bac_table_done tbody tr')].map((tr) => tr.children[3].textContent.trim()),
        [`${base}-AAAA-01`, `${base}-AAAA-02`, `${base}-AAAA-03`, `${base}-AAAA-04`], 'reubicación por marca y folio');
    app.destroy();

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
    editorApp.destroy();
    dom.window.close();
    console.log('Asistente Clasificador: plantillas OWL compiladas, paso 1/2/3 y modal de marca OK');
})().catch((error) => { console.error(error); process.exit(1); });
