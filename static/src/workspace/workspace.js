/** @odoo-module **/
import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { BiotexClassificationWorkspace } from "@biotex_catalog/classification/classification";
import { BiotexClassBadge } from "@biotex_catalog/fields/class_badge";
import { BiotexClasificadorLineEditorDialog } from "./line_editor";

const MODEL = "biotex.classification.session";
const PAGE_SIZE = 20;
const CONTEXT = { clasificador: true };

/**
 * Clasificador Global: variante del asistente de clasificación masiva.
 *
 * - Paso 1: grupo, familia y clasificador (sin marca). Los selectores releen el catálogo al abrirse.
 * - Paso 2: cada resultado muestra el estado de catálogo (badge `biotex_class_state`) y el de sesión,
 *   con **Agregar** como única acción: incorpora el producto a la sesión con la marca pendiente, sin abrir
 *   el modal. Enter y el lector agregan igual.
 * - Paso 3: todos los productos de la sesión. Los pendientes de marca van primero; los clasificados,
 *   por marca y folio. El lápiz abre el modal de edición (editLine), donde se confirma la marca (que
 *   reserva el folio), se capturan fotos y demás datos. Un pendiente se puede quitar de la sesión.
 * - Cierre: "Guardar y salir" y "Generar claves" liberan de la sesión los productos que quedaron sin
 *   marca ni folio (`clasificador_release_pending`): vuelven al catálogo tal como están hoy.
 */
export class BiotexClasificadorWorkspace extends BiotexClassificationWorkspace {
    static template = "biotex_asistente_clasificador.Workspace";
    static components = { BiotexClassBadge };

    setup() {
        super.setup();
        // La marca deja de ser un nivel de la sesión: se resuelve por producto en el modal de edición.
        this.levels = this.levels.filter((level) => level.key !== "brand");
        this.state.treeLoading = false;
    }

    // ================================================================= carga
    async bootstrap(sessionId) {
        this.searchVersion++;
        const data = await this.orm.call(MODEL, "workspace_bootstrap", [sessionId], { context: CONTEXT });
        Object.assign(this.state, { tree: data.tree, brands: data.brands, uoms: data.uoms, drafts: data.drafts, loading: false });
        this.applySession(data.session);
        if (data.notice) this.notification.add(data.notice, { type: "warning", sticky: true });
        if (this.state.session) {
            // Sin llave base se empieza por el paso 1; sin productos, por el paso 2 (buscar y agregar);
            // con productos se abre el paso 3, que es donde se editan (marca, folio, fotos).
            const stage = !this.classificationComplete ? 1 : (this.lines.length ? 3 : 2);
            this.state.stage = stage;
            this.state.collapsed[1] = this.classificationComplete;
            this.state.collapsed[2] = stage === 3;
            if (this.classificationComplete) await this.runSearch(0);
        }
    }

    // ================================================================= paso 1: selección (sin marca)
    get classificationComplete() { return this.levels.every((level) => !!this.state.pick[level.key]); }

    /** Cada apertura del selector relee el árbol: una familia o un clasificador recién creados aparecen sin recargar. */
    async togglePicker(key) {
        if (!this.levelEnabled(key)) return;
        this.state.pickerSearch = "";
        const opening = this.state.openPicker !== key;
        this.state.openPicker = opening ? key : null;
        if (opening) await this.refreshTree();
    }

    async refreshTree() {
        this.state.treeLoading = true;
        try {
            this.state.tree = await this.orm.call("product.category", "biotex_get_tree", []);
        } catch (e) {
            this.notify(e);
        } finally {
            this.state.treeLoading = false;
        }
    }

    async select(key, option) {
        const p = this.state.pick;
        const downstream = { group: ["family", "classifier"], family: ["classifier"], classifier: [] };
        p[key] = option.id;
        for (const k of downstream[key]) p[k] = false;
        p.brand = false;
        this.state.openPicker = null;
        this.state.pickerSearch = "";
        const next = this.levels.map((level) => level.key).find((k) => !p[k]);
        if (next) {
            await this.togglePicker(next);
        } else {
            await this.persistClassification();
        }
    }

    async persistClassification() {
        if (!this.classificationComplete) return;
        this.state.busy = true;
        try {
            const p = this.state.pick;
            const vals = { group_id: p.group, family_id: p.family, classifier_id: p.classifier, brand_per_line: true };
            const data = await this.orm.call(MODEL, "workspace_set_classification", [this.state.session?.id || false, vals], { context: CONTEXT });
            if (data) {
                this.applySession(data);
                if (this.pendingProductIds.length) {
                    const populated = await this.orm.call(MODEL, "workspace_add_products", [[data.id], this.pendingProductIds]);
                    this.applySession(populated);
                    this.notifySkipped(populated);
                    this.pendingProductIds = [];
                    this.goStage(3);
                }
                await this.runSearch(0);
            } else {
                this.notification.add(_t("No se pudo guardar la clasificación. Vuelva a elegir el clasificador."), { type: "danger" });
            }
        } catch (e) {
            this.notify(e);
        } finally {
            this.state.busy = false;
        }
    }

    /** Llave pendiente de la sesión: GG-FFF-CCC-????-?? mientras el producto no tenga marca. */
    get pendingCode() { return this.state.session?.pending_code || ""; }

    goStage(stage) {
        if (!this.stageReachable(stage)) {
            this.notification.add(
                stage === 2 ? _t("Elija grupo, familia y clasificador para continuar.")
                            : _t("Agregue al menos un producto para continuar."),
                { type: "warning" });
            return;
        }
        this.state.stage = stage;
        this.state.collapsed[1] = stage > 1;
        this.state.collapsed[2] = stage > 2;
        this.state.openPicker = null;
    }

    // ================================================================= paso 2: búsqueda y acciones
    get canCreateProduct() {
        return this.classificationComplete && !!this.state.session && !this.confirmed && !this.state.busy;
    }

    async newProduct() {
        if (!this.canCreateProduct) return;
        this.state.busy = true;
        try {
            const data = await this.orm.call(MODEL, "clasificador_new_product", [[this.state.session.id]]);
            this.applySession(data.session);
            const line = this.lines.find((row) => row.id === data.line_id);
            if (line) await this.editLine(line);
        } catch (e) {
            this.notify(e);
        } finally {
            this.state.busy = false;
        }
    }

    /** Igual que el asistente base, pero sin ocultar los productos ya agregados: aquí se editan. */
    async runSearch(offset) {
        if (!this.state.session || this.destroyed) return false;
        const version = ++this.searchVersion;
        const sessionId = this.state.session.id;
        const query = this.state.search.query;
        this.state.search.loading = true;
        try {
            const res = await this.orm.call(MODEL, "workspace_search_products", [[sessionId]], {
                query, offset, limit: PAGE_SIZE, review: this.state.search.review || "all",
            });
            if (this.destroyed || version !== this.searchVersion || sessionId !== this.state.session?.id) return false;
            const records = res.records;
            Object.assign(this.state.search, { records, total: res.total, offset: res.offset,
                selectedId: records.some((r) => r.id === this.state.search.selectedId) ? this.state.search.selectedId : null });
            return true;
        } catch (e) {
            if (version === this.searchVersion && !this.destroyed) this.notify(e);
            return false;
        } finally {
            if (version === this.searchVersion && !this.destroyed) this.state.search.loading = false;
        }
    }

    /** Datos mínimos que espera el widget `biotex_class_badge` del catálogo, reutilizado tal cual. */
    badgeRecord(record) {
        return { data: { biotex_class_state: record.class_state, biotex_missing: record.missing || "" } };
    }

    /** Línea de esta sesión que ya corresponde al producto buscado (si se agregó o editó). */
    lineOf(record) { return record.line || this.lines.find((line) => line.product_id === record.id) || null; }

    /** Teclado y lector agregan igual que el botón; un producto ya agregado se avisa y se edita en el paso 3. */
    async onSearchKeydown(ev) {
        if (ev.key !== "Enter") return super.onSearchKeydown(ev);
        if (ev.isComposing || ev.repeat) return;
        ev.preventDefault();
        if (this.searchKeyBusy || this.state.busy || this.confirmed) return;
        this.searchKeyBusy = true;
        this.debouncedSearch.cancel();
        try {
            const query = this.state.search.query;
            const selectedId = this.state.search.selectedId;
            if (!await this.runSearch(this.state.search.offset)) return;
            const records = this.state.search.records;
            const record = this.state.scan
                ? (this.state.search.total === 1 ? records[0] : null)
                : (selectedId ? records.find((row) => row.id === selectedId) : (this.state.search.total === 1 ? records[0] : null));
            if (record) {
                await this.addProduct(record, { clearQuery: this.state.scan, query });
            } else {
                this.notification.add(_t("Selecciona un resultado con las flechas y pulsa Enter para agregarlo."), { type: "info" });
            }
        } finally {
            this.searchKeyBusy = false;
        }
    }

    /**
     * Agregar desde el paso 2: incorpora el producto a la sesión con la marca pendiente y no abre el modal.
     * La marca, el folio, las fotos y demás datos se capturan en el paso 3 con Editar. Un producto con
     * clave de otra clasificación pide aceptar primero; uno ya agregado solo avisa.
     */
    async addProduct(record, { clearQuery = false, query = this.state.search.query } = {}) {
        if (record.locked_by || this.confirmed || this.state.busy) return false;
        if (this.lineOf(record)) {
            this.notification.add(_t("%s ya está en la sesión: edítalo en el paso 3 para asignar la marca.", record.name), { type: "info" });
            return false;
        }
        if (record.reclassify_from && !record._reclassifyAccepted) {
            this.confirmReclassify([record], () => this.addProduct({ ...record, _reclassifyAccepted: true }, { clearQuery, query }));
            return false;
        }
        this.state.busy = true;
        this.searchVersion++;
        try {
            const data = await this.orm.call(MODEL, "workspace_add_products", [[this.state.session.id]], { product_ids: [record.id] });
            this.applySession(data);
            this.notifySkipped(data);
            this.state.search.selectedId = null;
            if (clearQuery && this.state.search.query === query) this.state.search.query = "";
            await this.runSearch(this.state.search.offset);
            if (!data?.skipped?.length) {
                this.notification.add(_t("%s agregado al paso 3. Edítalo ahí para asignar la marca y reservar su folio.", record.name), { type: "success" });
            }
            return true;
        } catch (e) {
            this.notify(e);
        } finally {
            this.state.busy = false;
            this.searchInput.el?.focus();
            if (!clearQuery && this.state.search.query === query) this.searchInput.el?.select();
        }
    }

    /** Quitar del paso 3 un producto sin marca ni folio: vuelve al catálogo tal como está. */
    async removeLine(line) {
        if (line.classified && !line.is_new_product) return;  // con folio no se quita desde el asistente
        await super.removeLine(line);
    }

    /**
     * Abre un producto del resultado directo en el editor (lo agrega si hace falta). Ya no es la acción del
     * paso 2; se conserva para reabrir un producto de la sesión sin ir al paso 3.
     */
    async editProduct(record) {
        if (record.locked_by || this.confirmed || this.state.busy) return;
        const line = this.lineOf(record);
        if (!line && record.reclassify_from && !record._reclassifyAccepted) {
            this.confirmReclassify([record], () => this.editProduct({ ...record, _reclassifyAccepted: true }));
            return;
        }
        if (line) return this.editLine(line);
        this.state.busy = true;
        this.searchVersion++;
        try {
            const data = await this.orm.call(MODEL, "clasificador_edit_product", [[this.state.session.id]], { product_id: record.id });
            this.applySession(data.session);
            const created = this.lines.find((l) => l.id === data.line_id);
            if (created) await this.editLine(created);
        } catch (e) {
            this.notify(e);
        } finally {
            this.state.busy = false;
        }
    }

    async editLine(line) {
        await this.saveQueue;
        const sessionId = this.state.session.id;
        let saved = false;
        this.dialog.add(BiotexClasificadorLineEditorDialog, {
            lineId: line.id,
            sessionId: this.state.session.id,
            classCode: line.reference || this.pendingCode,
            readonly: this.confirmed,
            newProduct: !!line.is_new_product,
            // cada guardado y cada marca confirmada devuelven la sesión: el paso 3 se refresca al momento
            onSaved: (session) => { saved = true; this.applySession(session); this.clearLineErrors(line.id); },
            onBrandChanged: (session) => this.applySession(session),
        }, {
            onClose: async () => {
                try {
                    if (line.is_new_product && !saved) {
                        const session = await this.orm.call(MODEL, "clasificador_cancel_new_product", [[sessionId], line.id]);
                        if (!this.destroyed && this.state.session?.id === sessionId) this.applySession(session);
                    }
                } catch (e) {
                    if (!this.destroyed) this.notify(e);
                } finally {
                    if (!this.destroyed && this.state.session?.id === sessionId) this.runSearch(this.state.search.offset);
                }
            },
        });
    }

    // ================================================================= paso 3: clasificados (editables con el lápiz)
    /** Productos con marca y folio, por marca y dentro de cada marca por folio ascendente. */
    get classifiedLines() {
        return this.lines.filter((line) => line.classified && !line.is_new_product).sort((a, b) =>
            (a.brand_short || "").localeCompare(b.brand_short || "", "es", { sensitivity: "base" })
            || (a.brand_code || "").localeCompare(b.brand_code || "")
            || (a.folio_number - b.folio_number) || (a.id - b.id));
    }

    get pendingLines() { return this.lines.filter((line) => !line.classified || line.is_new_product); }

    /** Filas del paso 3: pendientes de marca primero (en el orden en que se agregaron) y después los clasificados. */
    get stepLines() {
        const pending = this.pendingLines.slice().sort((a, b) => (a.sequence - b.sequence) || (a.id - b.id));
        return [...pending, ...this.classifiedLines];
    }

    /** Marcas distintas del paso 3, para el resumen del encabezado. */
    get brandCount() { return new Set(this.classifiedLines.map((line) => line.brand_id)).size; }

    stageReachable(stage) {
        if (stage <= 1) return true;
        if (stage === 2) return this.classificationComplete && !!this.state.session;
        return this.lines.length > 0;
    }

    // ================================================================= cierre
    /**
     * Libera de la sesión los productos sin marca ni folio (y las altas sin guardar): vuelven al catálogo con
     * la clave, el nombre y los datos que tienen hoy. Devuelve true si la sesión quedó sin pendientes.
     */
    async releasePending() {
        if (!this.state.session || this.confirmed) return true;
        this.state.busy = true;
        try {
            await this.saveQueue;
            const data = await this.orm.call(MODEL, "clasificador_release_pending", [[this.state.session.id]]);
            this.applySession(data);
            if (data.released?.length) {
                this.notification.add(
                    _t("Se liberaron %s producto(s) sin marca ni folio: conservan los datos que tienen en el catálogo.", data.released.length),
                    { type: "info" });
            }
            return !this.pendingLines.length;
        } catch (e) {
            this.notify(e);
            return false;
        } finally {
            this.state.busy = false;
        }
    }

    /** Diálogo común de "Guardar y salir" y "Generar claves" cuando hay pendientes. */
    confirmRelease({ title, confirmLabel, onConfirm }) {
        const pending = this.pendingLines;
        const names = pending.map((line) => line.new_name || line.old_name || _t("Nuevo producto"));
        this.dialog.add(ConfirmationDialog, {
            title,
            body: _t("%s producto(s) no tienen marca ni folio y se liberarán de la sesión; conservan la clave, el nombre y los datos que tienen hoy en el catálogo:\n- %s",
                pending.length, names.join("\n- ")),
            confirmLabel,
            cancelLabel: _t("Seguir trabajando"),
            confirm: onConfirm,
            cancel: () => {},
        });
    }

    async confirm() {
        if (this.state.busy || this.confirmed) return;
        if (!this.classifiedLines.length) {
            this.notification.add(_t("Ningún producto tiene marca y folio. Edítalos en el paso 3 para asignar la marca antes de generar claves."), { type: "warning" });
            this.goStage(3);
            return;
        }
        if (this.pendingLines.length) {
            this.confirmRelease({
                title: _t("Productos sin marca ni folio"),
                confirmLabel: _t("Liberar y generar claves"),
                onConfirm: async () => { if (await this.releasePending()) await super.confirm(); },
            });
            return;
        }
        return super.confirm();
    }

    async saveAndExit() {
        await this.saveQueue;
        if (this.lineSaveErrors.size) {
            this.notification.add(_t("Hay cambios de nombre o unidad sin guardar. Corrígelos antes de salir."), { type: "warning" });
            return;
        }
        const exit = () => this.action.doAction("biotex_catalog.action_biotex_classification_sessions", { clearBreadcrumbs: true });
        if (this.state.session && !this.confirmed && this.pendingLines.length) {
            this.confirmRelease({
                title: _t("Guardar y salir"),
                confirmLabel: _t("Liberar y salir"),
                onConfirm: async () => { if (await this.releasePending()) exit(); },
            });
            return;
        }
        exit();
    }

    async startNew() {
        this.state.loading = true;
        Object.assign(this.state, {
            session: null, pick: { group: false, family: false, classifier: false, brand: false },
            stage: 1, collapsed: { 1: false, 2: false }, search: { query: "", offset: 0, total: 0, records: [], loading: false, selectedId: null },
        });
        await this.bootstrap(null);
    }
}

registry.category("actions").add("biotex_asistente_clasificador.workspace", BiotexClasificadorWorkspace);
