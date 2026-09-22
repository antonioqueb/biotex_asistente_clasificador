/** @odoo-module **/
import { markup, onMounted } from "@odoo/owl";
import { _t } from "@web/core/l10n/translation";
import { escape } from "@web/core/utils/strings";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";
import { BiotexLineEditorDialog } from "@biotex_catalog/classification/line_editor";
import { referenceTones } from "@biotex_catalog/classification/reference";

const MODEL = "biotex.classification.session";

/**
 * Modal de edición del Clasificador Global: el del asistente base más el campo **Marca**.
 *
 * La marca se elige de un catálogo que se relee cada vez que se abre la lista (una marca creada en otra
 * pestaña aparece sin recargar) y se puede crear al vuelo. "Confirmar marca" es la acción que reserva el
 * folio: llama al servidor, actualiza la referencia del encabezado y refresca el paso 3 al instante.
 * El campo nunca se bloquea: cambiar la marca de un producto ya clasificado avisa (caso B) y, si se
 * acepta, reserva un folio nuevo para la llave resultante.
 *
 * Regla de raíz al guardar (producto con marca y folio): si grupo, familia y clasificador de la sesión
 * son los mismos con los que se reservó el folio, se conservan marca y folio y el servidor refresca la
 * referencia; si la raíz cambió, el modal lo avisa y exige "Cambiar marca y reservar folio" antes de guardar.
 *
 * Unidades y empaques: una sola tabla. La primera fila es la unidad indivisible (unidad base) derivada del
 * `uom_id` de la línea: fija, con cantidad de elementos y código de barras editables; debajo, los empacados reales
 * (`presentation_data`, que al confirmar se escriben como `product.uom` con código de barras).
 */
export class BiotexClasificadorLineEditorDialog extends BiotexLineEditorDialog {
    static template = "biotex_asistente_clasificador.LineEditorDialog";
    static props = {
        ...BiotexLineEditorDialog.props,
        newProduct: { type: Boolean, optional: true },
        onBrandChanged: Function,
    };

    setup() {
        super.setup();
        this.state.brand = {
            open: false, loading: false, query: "", options: [], hints: [],
            pendingId: false, pendingLabel: "", pendingCode: "", confirming: false, initialized: false,
        };
        this.brandSearchVersion = 0;
        this.state.uomEditing = false;
        // la sugerencia de marca se calcula cuando la línea ya está cargada (onWillStart del modal base)
        onMounted(() => {
            const quantity = this.isNewProduct && !this.line.new_name ? "" : (this.line.base_unit_quantity ?? 1);
            this.state.draft.base_unit_quantity = quantity;
            this.state.initial.base_unit_quantity = quantity;
            if (this.isNewProduct && !this.state.draft.uom_id) this.state.uomEditing = true;
            this.ensureBrandSuggestion();
        });
    }

    // ------------------------------------------------------------------ estado
    get line() { return this.state.line || {}; }
    get isNewProduct() { return !!(this.props.newProduct || this.line.is_new_product); }
    get brandConfirmedId() { return this.line.brand_id || false; }
    get brandConfirmedLabel() { return this.line.brand_name || ""; }
    get brandCatalogLabel() { return this.line.suggested_brand_name || ""; }
    get brandPendingId() { return this.state.brand.pendingId; }

    /** La referencia del encabezado: la final si ya hay folio, si no la pendiente GG-FFF-CCC-????-??. */
    get referenceSegments() {
        const code = this.line.reference || this.line.pending_code || this.props.classCode || "";
        return code ? referenceTones(code).map((segment) => ({
            ...segment, tone: /^\?+$/.test(segment.text) ? "consecutive" : segment.tone,
        })) : [];
    }

    /** Sugerencia inicial: la marca actual de la ficha, cuando la línea aún no tiene marca confirmada. */
    ensureBrandSuggestion() {
        const brand = this.state.brand;
        if (brand.initialized || this.state.loading) return;
        brand.initialized = true;
        if (!this.brandConfirmedId && this.line.suggested_brand_id) {
            brand.pendingId = this.line.suggested_brand_id;
            brand.pendingLabel = this.line.suggested_brand_name;
            brand.pendingCode = this.line.suggested_brand_name.split(" · ")[0] || "";
        }
    }

    // ------------------------------------------------------------------ regla de raíz (grupo + familia + clasificador)
    /** El folio se reservó con otra raíz: la referencia actual es inconsistente hasta reservar folio nuevo. */
    get rootMismatch() { return !!this.line.root_mismatch; }

    /** Llave destino con la marca ya confirmada: GG-FFF-CCC (raíz vigente) + MMMM. */
    get rootTargetPrefix() { return this.previewPrefix(this.line.brand_code); }

    /** El botón de reservar folio se habilita con una marca distinta elegida o cuando la raíz cambió. */
    get canReserveFolio() {
        if (this.props.readonly || this.state.brand.confirming) return false;
        if (this.brandPendingId && this.brandPendingId !== this.brandConfirmedId) return true;
        return this.rootMismatch && !!this.brandConfirmedId;
    }

    get brandHelp() {
        const line = this.line;
        if (this.rootMismatch && !(this.brandPendingId && this.brandPendingId !== this.brandConfirmedId)) {
            return _t("La raíz de clasificación cambió; se debe reservar un folio nuevo.");
        }
        if (this.brandPendingId && this.brandPendingId !== this.brandConfirmedId) {
            return _t("Al confirmar se reserva el siguiente folio de %s.", this.previewPrefix(this.state.brand.pendingCode));
        }
        if (line.preserve_reference) return _t("Ya clasificado con esta marca: conserva la referencia %s y su nombre. Puedes cambiar la marca; se reservaría un folio nuevo.", line.reference);
        if (line.classified) return _t("Folio %s reservado para %s. Cambiar la marca reserva un folio nuevo; el actual no se reutiliza.", line.folio, line.line_class_code);
        return _t("Elige o crea la marca y confírmala: en ese momento se genera el folio consecutivo para %s.", (line.pending_code || "").replace("-??", ""));
    }

    previewPrefix(brandCode) {
        return `${(this.line.pending_code || "").split("-").slice(0, 3).join("-")}-${brandCode || "????"}`;
    }

    // ------------------------------------------------------------------ catálogo de marcas (fresco en cada apertura)
    async openBrands(ev) {
        this.state.brand.open = true;
        await this.searchBrands(ev?.target?.value ?? this.state.brand.query);
    }

    onBrandQuery(ev) {
        this.state.brand.query = ev.target.value;
        this.searchBrands(ev.target.value);
    }

    async searchBrands(query) {
        const version = ++this.brandSearchVersion;
        this.state.brand.loading = true;
        try {
            const rows = await this.orm.call(MODEL, "clasificador_brands", [], { query: query || "", session_id: this.props.sessionId });
            if (version !== this.brandSearchVersion) return;
            this.state.brand.options = rows;
        } catch (e) {
            if (version === this.brandSearchVersion) this.notification.add(e.data?.message || e.message, { type: "danger" });
        } finally {
            if (version === this.brandSearchVersion) this.state.brand.loading = false;
        }
    }

    closeBrands() { this.state.brand.open = false; }

    /** Opción "Crear marca": solo cuando lo escrito no coincide exactamente con una marca existente. */
    get canCreateBrand() {
        const q = (this.state.brand.query || "").trim().toLowerCase();
        return !!q && !this.state.brand.options.some((b) => b.name.toLowerCase() === q || b.code.toLowerCase() === q);
    }

    onBrandKeydown(ev) {
        if (ev.key === "Escape") {
            this.closeBrands();
            ev.stopPropagation();
        } else if (ev.key === "Enter") {
            ev.preventDefault();
            const opts = this.state.brand.options;
            if (opts.length === 1) this.pickBrand(opts[0]);
            else if (!opts.length && this.canCreateBrand) this.createBrand();
        }
    }

    pickBrand(brand) {
        Object.assign(this.state.brand, { open: false, query: "", options: [], pendingId: brand.id, pendingLabel: `${brand.code} · ${brand.name}`, pendingCode: brand.code });
    }

    clearPendingBrand() {
        Object.assign(this.state.brand, { pendingId: false, pendingLabel: "", pendingCode: "", query: "" });
    }

    async createBrand() {
        const name = (this.state.brand.query || "").trim();
        if (!name) return;
        try {
            const brand = await this.orm.call(MODEL, "clasificador_create_brand", [name]);
            this.pickBrand(brand);
            this.notification.add(_t("Marca %s · %s disponible en el catálogo.", brand.code, brand.name), { type: "success" });
        } catch (e) {
            this.notification.add(e.data?.message || e.message, { type: "danger", sticky: true });
        }
    }

    // ------------------------------------------------------------------ confirmar marca = reservar folio
    async confirmBrand() {
        const pendingId = this.brandPendingId;
        if (this.state.brand.confirming || this.props.readonly) return;
        if ((!pendingId || pendingId === this.brandConfirmedId) && this.rootMismatch) {
            // misma marca, raíz distinta: el flujo de reservar folio sin cambiar la marca
            this.clearPendingBrand();
            return this.reserveFolioForRoot();
        }
        if (!pendingId) return;
        if (pendingId === this.brandConfirmedId) { this.clearPendingBrand(); return; }
        const line = this.line;
        const productBrandId = line.suggested_brand_id;
        const targetPrefix = this.previewPrefix(this.state.brand.pendingCode);
        // Caso B: producto ya clasificado (clave completa) y marca distinta a la de su clave actual.
        if (line.product_reference && productBrandId && line.same_classification && pendingId !== productBrandId) {
            return this.confirmDifferentClassification(line, targetPrefix, () => this.applyBrand(pendingId));
        }
        if (line.reclassify_from && !line.brand_id) {
            // clave completa de otra clasificación: el aviso ya se aceptó al agregar/editar, se vuelve a mostrar la clave destino
            return this.confirmDifferentClassification(line, targetPrefix, () => this.applyBrand(pendingId));
        }
        if (line.classified && productBrandId && line.same_classification && pendingId === productBrandId) {
            // vuelve a la marca de su clave actual: recupera esa referencia, sin folio nuevo
            this.dialog.add(ConfirmationDialog, {
                title: _t("Volver a la clave actual del producto"),
                body: _t("Con la marca %s el producto conserva su referencia %s. El folio %s reservado en esta sesión no se reutiliza. ¿Continuar?", this.state.brand.pendingLabel, line.product_reference, line.folio),
                confirmLabel: _t("Conservar clave actual"),
                cancelLabel: _t("Cancelar"),
                confirm: () => this.applyBrand(pendingId),
                cancel: () => {},
            });
            return;
        }
        if (line.classified) {
            // sin clave previa en el catálogo, pero ya con folio en la sesión: el cambio consume un folio nuevo
            this.dialog.add(ConfirmationDialog, {
                title: _t("Cambiar la marca reserva un folio nuevo"),
                body: _t("El folio %s de %s no se reutiliza. Se reservará el siguiente folio de %s. ¿Continuar?", line.folio, line.line_class_code, targetPrefix),
                confirmLabel: _t("Cambiar marca"),
                cancelLabel: _t("Cancelar"),
                confirm: () => this.applyBrand(pendingId),
                cancel: () => {},
            });
            return;
        }
        return this.applyBrand(pendingId);
    }

    /** Mismo aviso del asistente base ("clasificación diferente"): ambas claves, aceptar o cancelar. */
    confirmDifferentClassification(line, targetPrefix, onAccept) {
        const current = line.reclassify_from || line.product_reference;
        const body = markup(`<p>${escape(_t("El producto ya tiene clave completa. Confirmar esta marca le genera una referencia nueva y su numeración actual cambiará."))}</p>
            <table class="table table-sm mb-2"><thead><tr><th>${escape(_t("Producto"))}</th><th>${escape(_t("Clave actual"))}</th><th>${escape(_t("Clasificación destino"))}</th></tr></thead><tbody>
            <tr><td>${escape(line.old_name || line.new_name || "")}</td><td class="o_bcw_mono text-danger fw-bold">${escape(current)}</td><td class="o_bcw_mono">${escape(targetPrefix)}-…</td></tr>
            </tbody></table>`);
        this.dialog.add(ConfirmationDialog, {
            title: _t("Clasificación diferente"),
            body,
            confirmLabel: _t("Aceptar y reservar folio"),
            confirmClass: "btn-danger",
            cancelLabel: _t("Cancelar"),
            confirm: onAccept,
            cancel: () => {},
        });
    }

    async applyBrand(brandId) {
        return this.reserveWith("clasificador_set_line_brand", [[this.props.sessionId], this.props.lineId, brandId], (line) =>
            line.preserve_reference
                ? _t("Marca confirmada: conserva la referencia %s.", line.reference)
                : _t("Marca confirmada: folio %s reservado (%s).", line.folio, line.reference));
    }

    /**
     * Raíz distinta con la misma marca: aviso con el folio que deja de corresponder y la llave destino;
     * al aceptar se reserva el siguiente folio de la raíz vigente (el anterior no se reutiliza).
     * `onDone` permite continuar con el guardado que lo disparó.
     */
    reserveFolioForRoot(onDone) {
        const line = this.line;
        if (!this.rootMismatch || !this.brandConfirmedId || this.props.readonly) return;
        const target = this.rootTargetPrefix;
        this.dialog.add(ConfirmationDialog, {
            title: _t("La raíz de clasificación cambió"),
            body: _t("El folio %s se reservó para %s y la sesión ahora clasifica en %s. Se debe reservar un folio nuevo: se tomará el siguiente de %s y el folio anterior no se reutiliza. ¿Continuar?",
                line.folio, line.product_root || (line.reference || "").split("-").slice(0, 3).join("-"), line.session_root, target),
            confirmLabel: _t("Reservar folio nuevo"),
            cancelLabel: _t("Cancelar"),
            confirm: async () => {
                const ok = await this.reserveWith("clasificador_reserve_folio", [[this.props.sessionId], this.props.lineId],
                    (l) => _t("Folio %s reservado para la raíz vigente (%s).", l.folio, l.reference));
                if (ok && onDone) await onDone();
            },
            cancel: () => {},
        });
    }

    /** Llamada común de reserva: aplica la línea devuelta, refresca el paso 3 y avisa. Devuelve true si funcionó. */
    async reserveWith(method, args, message) {
        this.state.brand.confirming = true;
        try {
            const data = await this.orm.call(MODEL, method, args);
            this.refreshLine(data.line);
            this.props.onBrandChanged(data.session);
            this.clearPendingBrand();
            this.notification.add(message(this.line), { type: "success" });
            return true;
        } catch (e) {
            this.notification.add(e.data?.message || e.message, { type: "danger", sticky: true });
            return false;
        } finally {
            this.state.brand.confirming = false;
        }
    }

    /** Guardar: con la raíz cambiada no se guarda una referencia inconsistente; primero se reserva el folio nuevo. */
    async save() {
        if (this.state.brand.confirming) return;
        if (this.rootMismatch && this.brandConfirmedId && !this.props.readonly && !this.state.saving) {
            return this.reserveFolioForRoot(() => this.save());
        }
        if (!this.isNewProduct) return super.save();
        if (this.props.readonly || this.state.saving || this.state.readingImages || !this.validate()) return;
        this.state.saving = true;
        try {
            const vals = { ...this.state.draft };
            vals.package_qty = vals.package_qty === "" ? 1 : vals.package_qty;
            if (!(vals.base_name || "").trim()) vals.base_name = vals.new_name;
            const session = await this.orm.call(MODEL, "clasificador_create_product", [
                [this.props.sessionId], this.props.lineId, vals,
            ]);
            this.props.onSaved(session);
            this.notification.add(_t("Producto creado"), { type: "success" });
            this.props.close();
        } catch (e) {
            this.notification.add(e.data?.message || e.message, { type: "danger", sticky: true });
        } finally {
            this.state.saving = false;
        }
    }

    // ------------------------------------------------------------------ unidades y empaques (tabla unificada)
    /** Nombre de la unidad base tal como se muestra en la primera fila fija. */
    get baseUnitLabel() { return this.baseUomName || this.line.product_uom_name || "—"; }

    get baseUnitQuantity() { return this.state.draft.base_unit_quantity ?? this.line.base_unit_quantity ?? 1; }

    get baseUnitDescription() {
        const quantity = Number(this.baseUnitQuantity);
        return this.state.draft.uom_id && Number.isFinite(quantity) && quantity > 0
            ? `${this.baseUnitLabel.toUpperCase()} CON ${quantity}` : "";
    }

    /** La unidad base se puede cambiar salvo con movimientos de inventario (esa unidad se conserva) o en solo lectura. */
    get canChangeBaseUom() { return !this.props.readonly && !this.line.uom_locked; }

    startUomEdit() { if (this.canChangeBaseUom) this.state.uomEditing = true; }

    onBaseUomChange(ev) {
        this.onSelect("uom_id", ev);
        this.state.uomEditing = false;
    }

    cancelUomEdit() { this.state.uomEditing = false; }

    validate() {
        const ok = super.validate();
        if (this.isNewProduct && !this.line.classified) {
            this.state.errors.brand_id = _t("Confirma la marca y reserva el folio antes de crear el producto.");
        }
        if (this.state.errors.uom_id) this.state.uomEditing = true;  // el selector de la fila base aparece para corregir
        const quantity = Number(this.baseUnitQuantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            this.state.errors.base_unit_quantity = _t("La cantidad de elementos debe ser un número mayor que cero.");
            this.scrollToFirstError();
            return false;
        }
        return ok && !this.state.errors.brand_id;
    }

    /** Aplica la línea devuelta por el servidor sin perder lo que el usuario escribió en el resto del modal. */
    refreshLine(detail) {
        this.state.line = { ...this.state.line, ...detail };
        if (detail.classified) delete this.state.errors.brand_id;
        if (detail.preserve_reference) {
            // clave y nombre conservados: el nombre vuelve al de la ficha
            this.state.draft.new_name = detail.new_name || this.state.draft.new_name;
            this.state.initial.new_name = this.state.draft.new_name;
            delete this.state.errors.new_name;
        }
        if (!this.state.draft.manufacturer_id && detail.manufacturer_id) {
            // sugerencia del fabricante de la marca recién confirmada
            this.state.draft.manufacturer_id = detail.manufacturer_id;
            this.state.initial.manufacturer_id = detail.manufacturer_id;
            this.state.labels.manufacturer = detail.manufacturer_name || "";
            this.state.manufacturerSuggested = !detail.manufacturer_manual;
        }
    }
}
