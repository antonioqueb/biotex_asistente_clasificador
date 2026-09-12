/** @odoo-module **/
import { registry } from "@web/core/registry";
import { _t } from "@web/core/l10n/translation";
import { BiotexClassificationWorkspace } from "@biotex_catalog/classification/classification";
import { BiotexImageGalleryDialog } from "@biotex_catalog/classification/image_gallery_dialog";
import { BiotexClassBadge } from "@biotex_catalog/fields/class_badge";
import { BiotexClasificadorLineEditorDialog } from "./line_editor";

const MODEL = "biotex.classification.session";
const PAGE_SIZE = 20;
const CONTEXT = { clasificador: true };

/**
 * Asistente Clasificador: variante del asistente de clasificación masiva.
 *
 * - Paso 1: grupo, familia y clasificador (sin marca). Los selectores releen el catálogo al abrirse.
 * - Paso 2: cada resultado muestra el estado de catálogo (badge `biotex_class_state`) y el de sesión,
 *   con las acciones Ver imágenes, Editar y +Agregar. Editar clasifica sin pasar por +Agregar y es
 *   donde se confirma la marca (que reserva el folio). No hay acción de eliminar.
 * - Paso 3: solo lectura, ordenado por marca y folio; se refresca con cada edición.
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
            // Sin llave base se empieza por el paso 1; con productos se trabaja en el paso 2 (ahí se edita)
            // y solo cuando todo tiene marca y folio se abre directo la revisión del paso 3.
            const stage = !this.classificationComplete ? 1 : (this.lines.length && !this.pendingLines.length ? 3 : 2);
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
                    this.goStage(2);
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
                            : _t("Agregue o edite al menos un producto para continuar."),
                { type: "warning" });
            return;
        }
        this.state.stage = stage;
        this.state.collapsed[1] = stage > 1;
        this.state.collapsed[2] = stage > 2;
        this.state.openPicker = null;
    }

    // ================================================================= paso 2: búsqueda y acciones
    /** Igual que el asistente base, pero sin ocultar los productos ya agregados: aquí se editan. */
    async runSearch(offset) {
        if (!this.state.session || this.destroyed) return false;
        const version = ++this.searchVersion;
        const sessionId = this.state.session.id;
        const query = this.state.search.query;
        this.state.search.loading = true;
        try {
            const res = await this.orm.call(MODEL, "workspace_search_products", [[sessionId]], { query, offset, limit: PAGE_SIZE });
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

    canAdd(record) { return !record.locked_by && !this.lineOf(record); }

    /** "+Agregar": incorpora el producto con la marca pendiente; la fila se queda en el resultado para editarla. */
    async addProduct(record, { clearQuery = false, query = this.state.search.query } = {}) {
        if (this.confirmed || this.state.busy || this.lineOf(record)) return false;
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
            if (this.lineOf(record)) {
                this.notification.add(_t("Producto agregado con marca pendiente. Usa Editar para asignar la marca y reservar el folio."), { type: "success" });
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

    openRecordImages(record) {
        const line = this.lineOf(record);
        const images = (line?.images?.length ? line.images : record.images) || [];
        if (!images.length) return;
        this.dialog.add(BiotexImageGalleryDialog, { title: line?.new_name || record.name, images: images.slice(0, 3) });
    }

    recordImageCount(record) { return Math.min(((this.lineOf(record)?.images?.length ? this.lineOf(record).images : record.images) || []).length, 3); }

    /**
     * Editar desde el paso 2: agrega el producto a la sesión si hace falta (marca pendiente) y abre el
     * modal. Un producto con clave de otra clasificación pide aceptar primero, como al agregarlo.
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
        this.dialog.add(BiotexClasificadorLineEditorDialog, {
            lineId: line.id,
            sessionId: this.state.session.id,
            classCode: line.reference || this.pendingCode,
            readonly: this.confirmed,
            // cada guardado y cada marca confirmada devuelven la sesión: el paso 3 se refresca al momento
            onSaved: (session) => { this.applySession(session); this.clearLineErrors(line.id); },
            onBrandChanged: (session) => this.applySession(session),
        }, {
            onClose: () => { if (!this.destroyed) this.runSearch(this.state.search.offset); },
        });
    }

    // ================================================================= paso 3: solo lectura
    /** Productos con marca y folio, por marca y dentro de cada marca por folio ascendente. */
    get classifiedLines() {
        return this.lines.filter((line) => line.classified).sort((a, b) =>
            (a.brand_short || "").localeCompare(b.brand_short || "", "es", { sensitivity: "base" })
            || (a.brand_code || "").localeCompare(b.brand_code || "")
            || (a.folio_number - b.folio_number) || (a.id - b.id));
    }

    get pendingLines() { return this.lines.filter((line) => !line.classified); }

    /** Marcas distintas del paso 3, para el resumen del encabezado. */
    get brandCount() { return new Set(this.classifiedLines.map((line) => line.brand_id)).size; }

    stageReachable(stage) {
        if (stage <= 1) return true;
        if (stage === 2) return this.classificationComplete && !!this.state.session;
        return this.lines.length > 0;
    }

    // ================================================================= cierre
    async confirm() {
        if (this.pendingLines.length) {
            this.notification.add(
                _t("Hay %s producto(s) sin marca o folio. Asigna la marca desde Editar en el paso 2 antes de generar claves.", this.pendingLines.length),
                { type: "warning" });
            this.goStage(2);
            return;
        }
        return super.confirm();
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
