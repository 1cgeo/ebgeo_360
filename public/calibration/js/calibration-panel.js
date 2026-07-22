/**
 * @fileoverview Calibration sidebar panel for the Street View 360 calibration interface.
 * Provides controls for mesh_rotation_y, target overrides, and save/discard actions.
 */

import {
    state, onChange, isDirty,
    setMeshRotationY,
    setMeshRotationX, setMeshRotationZ,
    selectTarget, deselectTarget,
    setTargetHidden, isTargetHidden,
    getCurrentPhotoIndex, resetAllReviewedState,
} from './state.js';
import { batchUpdateProject, resetProjectReviewed } from './api.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let panelEl = null;
let isSaving = false;
let sphericalGridVisible = false;

// Collapsible section state (persisted in localStorage)
const collapsedSections = new Map();
const COLLAPSED_STORAGE_KEY = 'cal-panel-collapsed';

// Nearby preview mode
let nearbyPreviewEnabled = false;
let previewingNearbyId = null;

// Ultima foto cujo item foi rolado para a vista — evita scrollIntoView (e o
// layout thrashing associado) em re-renders que nao trocam a foto atual.
let lastScrolledPhotoId = null;

// Assinatura da estrutura do painel do ultimo render completo. Quando o proximo
// render produz a mesma estrutura (mesmas listas, mesmas secoes, mesmo target
// selecionado), aplicamos apenas atualizacoes pontuais (classes/valores) em vez
// de reconstruir todo o DOM via innerHTML e re-anexar todos os listeners.
let lastStructureSignature = null;

// Callbacks set by app.js
let onSaveCallback = null;
let onDiscardCallback = null;
let onMeshRotationPreview = null;
let onMeshRotationXPreview = null;
let onMeshRotationZPreview = null;
let onNavigateToPhoto = null;
let onMarkReviewedCallback = null;
let onNextPhotoCallback = null;
let onPrevPhotoCallback = null;
let onBackToProjectsCallback = null;
let onSphericalGridToggleCallback = null;
let onAddTargetCallback = null;
let onDeleteTargetCallback = null;
let onNearbyPreviewToggleCallback = null;
let onNearbySelectCallback = null;
let onDeletePhotoCallback = null;

// ============================================================================
// COLLAPSIBLE SECTIONS
// ============================================================================

function initCollapsedState() {
    try {
        const saved = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || '{}');
        for (const [key, val] of Object.entries(saved)) {
            collapsedSections.set(key, val);
        }
    } catch { /* ignore */ }
}

function isSectionCollapsed(key) {
    return collapsedSections.get(key) ?? false;
}

function toggleSection(key) {
    collapsedSections.set(key, !isSectionCollapsed(key));
    try {
        const obj = Object.fromEntries(collapsedSections);
        localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(obj));
    } catch { /* ignore */ }
}

/**
 * Renders a collapsible section with chevron toggle.
 * @param {string} key - Section key for collapse state
 * @param {string} title - Section title
 * @param {string} contentHtml - Inner HTML content
 * @param {Object} [options] - Options
 * @param {number} [options.count] - Count badge in title
 * @param {string} [options.className] - Extra CSS class
 * @param {string} [options.headerExtra] - Extra HTML in the header row (e.g. buttons)
 * @returns {string} HTML string
 */
function renderCollapsibleSection(key, title, contentHtml, options = {}) {
    const collapsed = isSectionCollapsed(key);
    const chevron = collapsed ? '&#9656;' : '&#9662;';
    const countBadge = options.count != null ? ` (${options.count})` : '';
    const headerExtra = options.headerExtra || '';
    return `
        <div class="cal-panel__section ${options.className || ''}">
            <div class="cal-panel__collapsible-header">
                <h3 class="cal-panel__title cal-panel__title--collapsible" data-collapse-key="${key}">
                    <span class="cal-panel__chevron">${chevron}</span>
                    ${title}${countBadge}
                </h3>
                ${headerExtra}
            </div>
            ${collapsed ? '' : `<div class="cal-panel__section-body">${contentHtml}</div>`}
        </div>
    `;
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initializes the calibration panel.
 * @param {HTMLElement} container - The panel container element
 * @param {Object} options - Callbacks
 * @param {Function} options.onSave - Called when user clicks Save
 * @param {Function} options.onDiscard - Called when user clicks Discard
 * @param {Function} options.onMeshRotationPreview - Called with degrees for live viewer preview
 * @param {Function} options.onNavigateToPhoto - Called with photoId to navigate
 * @param {Function} [options.onNearbyPreviewToggle] - Called with boolean when nearby preview toggled
 * @param {Function} [options.onNearbySelect] - Called with nearby photo data when clicked for preview
 */
export function initPanel(container, options = {}) {
    panelEl = container;
    onSaveCallback = options.onSave || null;
    onDiscardCallback = options.onDiscard || null;
    onMeshRotationPreview = options.onMeshRotationPreview || null;
    onMeshRotationXPreview = options.onMeshRotationXPreview || null;
    onMeshRotationZPreview = options.onMeshRotationZPreview || null;
    onNavigateToPhoto = options.onNavigateToPhoto || null;
    onMarkReviewedCallback = options.onMarkReviewed || null;
    onNextPhotoCallback = options.onNextPhoto || null;
    onPrevPhotoCallback = options.onPrevPhoto || null;
    onBackToProjectsCallback = options.onBackToProjects || null;
    onSphericalGridToggleCallback = options.onSphericalGridToggle || null;
    onAddTargetCallback = options.onAddTarget || null;
    onDeleteTargetCallback = options.onDeleteTarget || null;
    onNearbyPreviewToggleCallback = options.onNearbyPreviewToggle || null;
    onNearbySelectCallback = options.onNearbySelect || null;
    onDeletePhotoCallback = options.onDeletePhoto || null;

    // Initialize collapsed state from localStorage
    initCollapsedState();

    // Listen to state changes
    onChange(renderPanel);

    // Initial render
    renderPanel(state);
}

// ============================================================================
// RENDER
// ============================================================================

/**
 * Calcula uma assinatura da ESTRUTURA do painel (presenca, ordem e rotulos dos
 * elementos + secoes colapsadas). Dois renders com a mesma assinatura possuem
 * DOM identico salvo por estados puramente presentacionais (classes de selecao,
 * valores de slider, badges), que podem ser atualizados em lugar sem reconstruir
 * o DOM nem re-anexar listeners. Qualquer mudanca estrutural altera a assinatura
 * e forca o rebuild completo (caminho seguro por padrao).
 * @param {Object} s - Estado atual
 * @param {Array} targets - Targets da foto atual
 * @param {Object|undefined} selectedTarget - Target selecionado (se houver)
 * @returns {string}
 */
function buildStructureSignature(s, targets, selectedTarget) {
    const hasProject = s.projectPhotos.length > 0;
    // Identidade/ordem/rotulos dos targets (texto que aparece no item, exceto
    // classes de selecao/oculto e badges de override, tratados como pontuais).
    const targetsSig = targets
        .map(t => `${t.id}|${t.display_name || ''}|${t.next ? 1 : 0}|${t.distance != null ? t.distance.toFixed(1) : ''}|${t.is_original === false ? 1 : 0}`)
        .join(',');
    // Identidade/ordem dos itens da lista de fotos (rotulo + sequencia).
    const photosSig = s.projectPhotos
        .map(p => `${p.id}|${p.displayName}|${p.sequenceNumber}`)
        .join(',');
    // Identidade/ordem das fotos proximas.
    const nearbySig = (s.nearbyPhotos || [])
        .map(p => `${p.id}|${p.displayName || ''}|${p.distance != null ? p.distance.toFixed(1) : ''}`)
        .join(',');
    // Secoes colapsadas afetam quais corpos existem no DOM.
    const collapsedSig = ['sliders', 'batch', 'targets', 'nearby']
        .map(k => `${k}:${isSectionCollapsed(k) ? 1 : 0}`)
        .join(',');
    return [
        hasProject ? 1 : 0,
        s.currentPhotoId || '',
        // Badge "REVISADA" + rotulo/classe do botao de revisao dependem disto.
        s.calibrationReviewed ? 1 : 0,
        // Identidade das acoes do target selecionado: o rotulo Ocultar/Mostrar
        // depende do estado hidden, e a presenca de "Remover Conexao" depende de
        // is_original === false.
        selectedTarget ? selectedTarget.id : '',
        selectedTarget ? (isTargetHidden(selectedTarget.id) ? 1 : 0) : 0,
        selectedTarget ? (selectedTarget.is_original === false ? 1 : 0) : 0,
        nearbyPreviewEnabled ? 1 : 0,
        previewingNearbyId || '',
        collapsedSig,
        targetsSig,
        photosSig,
        nearbySig,
    ].join('||');
}

/**
 * Aplica atualizacoes pontuais (sem reconstruir o DOM) quando a estrutura do
 * painel nao mudou desde o ultimo render completo. Atualiza: selecao/oculto de
 * targets e respectivos badges, foto atual/revisada na lista, valores dos
 * sliders + textos de delta, contadores de progresso, badge de revisada e
 * estado disabled de Salvar/Descartar.
 * @param {Object} s - Estado atual
 * @param {Array} targets - Targets da foto atual
 * @param {boolean} dirty - Se ha alteracoes nao salvas
 */
function applyTargetedUpdates(s, targets, dirty) {
    // --- Sliders + deltas (mudam no release/change) ---
    const setSlider = (sliderId, inputId, value, decimals) => {
        if (value == null) return;
        const slider = document.getElementById(sliderId);
        if (slider && document.activeElement !== slider) slider.value = value;
        const input = document.getElementById(inputId);
        if (input && document.activeElement !== input) input.value = value.toFixed(decimals);
    };
    setSlider('mesh-rot-slider', 'mesh-rot-input', s.editedMeshRotationY, 1);
    setSlider('mesh-rotx-slider', 'mesh-rotx-input', s.editedMeshRotationX, 1);
    setSlider('mesh-rotz-slider', 'mesh-rotz-input', s.editedMeshRotationZ, 1);

    // Por ID, e nao por posicao na lista de .cal-panel__delta: o indice
    // posicional quebrou em silencio quando os sliders de altura e escala saíram
    // do meio, escrevendo o delta do pitch no slot do roll.
    const setDelta = (id, edited, original, unit) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = getDeltaText(edited, original, unit);
    };
    setDelta('delta-mesh-rot-y', s.editedMeshRotationY, s.originalMeshRotationY);
    setDelta('delta-mesh-rot-x', s.editedMeshRotationX, s.originalMeshRotationX);
    setDelta('delta-mesh-rot-z', s.editedMeshRotationZ, s.originalMeshRotationZ);

    // --- Botoes de batch (rotulos refletem valores atuais) ---
    const setText = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = text;
    };
    setText('btn-batch-mesh', `rotation_y &rarr; ${(s.editedMeshRotationY ?? 180).toFixed(1)}&deg;`);
    setText('btn-batch-rotx', `rotation_x &rarr; ${(s.editedMeshRotationX ?? 0).toFixed(1)}&deg;`);
    setText('btn-batch-rotz', `rotation_z &rarr; ${(s.editedMeshRotationZ ?? 0).toFixed(1)}&deg;`);

    // --- Salvar/Descartar (estado disabled) ---
    const saveBtn = document.getElementById('btn-save');
    if (saveBtn) {
        saveBtn.disabled = !dirty || isSaving;
        saveBtn.textContent = isSaving ? 'Salvando...' : 'Salvar';
    }
    const discardBtn = document.getElementById('btn-discard');
    if (discardBtn) discardBtn.disabled = !dirty || isSaving;

    // --- Contadores de progresso / revisao ---
    const reviewed = s.reviewStats?.reviewed ?? 0;
    const total = s.reviewStats?.total ?? 0;
    const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;
    const counter = panelEl.querySelector('.cal-panel__review-counter');
    if (counter) counter.textContent = `${reviewed}/${total} revisadas (${pct}%)`;
    const fill = panelEl.querySelector('.cal-panel__progress-fill');
    if (fill) fill.style.width = `${pct}%`;

    // --- Lista de targets: selecao, oculto e badges de override ---
    panelEl.querySelectorAll('[data-target-id]').forEach(item => {
        const target = targets.find(t => t.id === item.dataset.targetId);
        if (!target) return;
        const isSelected = target.id === s.selectedTargetId;
        const hidden = isTargetHidden(target.id);
        item.classList.toggle('cal-panel__target-item--selected', isSelected);
        item.classList.toggle('cal-panel__target-item--hidden', hidden);

        const info = item.querySelector('.cal-panel__target-info');
        if (info) {
            const displayName = target.display_name || target.id.slice(0, 8);
            const nextBadge = target.next ? '<span class="cal-panel__next-badge">next</span>' : '';
            info.innerHTML = `
                <span class="cal-panel__target-name">${displayName}</span>
                ${nextBadge}
                ${hidden ? '<span class="cal-panel__hidden-badge">oculto</span>' : ''}
            `;
        }
    });

    // --- Lista de fotos: foto atual / revisada ---
    panelEl.querySelectorAll('[data-photo-nav-id]').forEach(item => {
        const photo = s.projectPhotos.find(p => p.id === item.dataset.photoNavId);
        if (!photo) return;
        item.classList.toggle('cal-panel__photo-item--current', photo.id === s.currentPhotoId);
        item.classList.toggle('cal-panel__photo-item--reviewed', !!photo.reviewed);
        const status = item.querySelector('.cal-panel__photo-status');
        if (status) status.innerHTML = photo.reviewed ? '&#10003;' : '&#9675;';
    });
}

function renderPanel(s) {
    if (!panelEl) return;

    const dirty = isDirty();
    const meta = s.currentMetadata;

    if (!meta) {
        panelEl.innerHTML = `
            <div class="cal-panel__empty">
                <p>Nenhuma foto carregada</p>
                <p class="cal-panel__hint">Use ?photo=UUID na URL ou selecione um projeto</p>
            </div>
        `;
        lastStructureSignature = null;
        return;
    }

    const camera = meta.camera || {};
    const targets = meta.targets || [];
    const selectedTarget = targets.find(t => t.id === s.selectedTargetId);

    // Caminho rapido: se a estrutura nao mudou desde o ultimo render completo,
    // atualiza apenas o que e presentacional, preservando o DOM e os listeners.
    const signature = buildStructureSignature(s, targets, selectedTarget);
    if (signature === lastStructureSignature) {
        applyTargetedUpdates(s, targets, dirty);
        return;
    }
    lastStructureSignature = signature;

    // Preserve scroll position across re-renders
    const scrollTop = panelEl.scrollTop;

    const hasProject = s.projectPhotos.length > 0;
    const photoIdx = getCurrentPhotoIndex();
    const totalPhotos = s.projectPhotos.length;
    const reviewed = s.reviewStats?.reviewed ?? 0;
    const total = s.reviewStats?.total ?? 0;
    const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;

    panelEl.innerHTML = `
        ${hasProject ? `
        <div class="cal-panel__review-nav">
            <button id="btn-back-projects" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost" title="Voltar aos projetos">
                &larr; Projetos
            </button>
            <div class="cal-panel__review-progress">
                <span class="cal-panel__review-counter">${reviewed}/${total} revisadas (${pct}%)</span>
                <div class="cal-panel__progress-bar">
                    <div class="cal-panel__progress-fill" style="width: ${pct}%"></div>
                </div>
            </div>
        </div>
        <div class="cal-panel__photo-nav">
            <button id="btn-prev-photo" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost" title="Foto anterior [Q]">&larr;</button>
            <span class="cal-panel__photo-counter">${photoIdx} / ${totalPhotos}</span>
            <button id="btn-next-photo" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost" title="Proxima foto">&rarr;</button>
        </div>
        ` : ''}

        <div class="cal-panel__section">
            <h3 class="cal-panel__title">
                Foto: ${camera.display_name || 'Sem nome'}
                ${s.calibrationReviewed ? '<span class="cal-panel__reviewed-badge">REVISADA</span>' : ''}
                <button id="btn-open-json" class="cal-panel__btn cal-panel__btn--icon" title="Abrir JSON da foto">{ }</button>
                <button id="btn-delete-photo" class="cal-panel__btn cal-panel__btn--icon cal-panel__btn--danger" title="Excluir foto">&times;</button>
            </h3>
        </div>

        <div class="cal-panel__section cal-panel__section--grid">
            <label class="cal-panel__grid-toggle">
                <input type="checkbox" id="spherical-grid-toggle" />
                <span>Grade esf&eacute;rica [G]</span>
            </label>
        </div>

        <div class="cal-panel__actions">
            <button id="btn-save" class="cal-panel__btn cal-panel__btn--save"
                ${!dirty || isSaving ? 'disabled' : ''}>
                ${isSaving ? 'Salvando...' : 'Salvar'}
            </button>
            <button id="btn-discard" class="cal-panel__btn cal-panel__btn--discard"
                ${!dirty || isSaving ? 'disabled' : ''}>
                Descartar
            </button>
        </div>

        ${hasProject ? `
        <div class="cal-panel__review-actions">
            <button id="btn-toggle-reviewed" class="cal-panel__btn ${s.calibrationReviewed ? 'cal-panel__btn--ghost' : 'cal-panel__btn--reviewed'}">
                ${s.calibrationReviewed ? 'Desmarcar revisao' : 'Marcar revisada'}
            </button>
            <button id="btn-review-next" class="cal-panel__btn cal-panel__btn--review-next" title="Salvar, marcar revisada e ir para proxima [E]">
                Revisada &rarr; Proxima
            </button>
        </div>
        ` : ''}


        ${renderSlidersSection(s)}

        ${hasProject ? renderBatchSection(s) : ''}

        ${renderTargetsSection(targets, selectedTarget, s)}

        ${renderNearbyPhotos(s)}

        ${hasProject ? renderPhotoList(s) : ''}
    `;

    attachEvents();

    // Restore scroll position after DOM rebuild
    panelEl.scrollTop = scrollTop;
}

// ============================================================================
// SECTION RENDERERS
// ============================================================================

function renderSlidersSection(s) {
    // Restaram apenas as rotacoes da malha, que sao calibracao da IMAGEM.
    // camera_height, distance_scale e marker_scale saíram porque o marcador
    // deixou de depender de qualquer medida: ele e posicionado de forma
    // relativa, e posicao errada se corrige movendo a FOTO.
    const content = `
        <div class="cal-panel__slider-section">
            <h4 class="cal-panel__subtitle">mesh_rotation_y</h4>
            <div class="cal-panel__slider-group">
                <input type="range" id="mesh-rot-slider" class="cal-panel__slider"
                    min="0" max="360" step="0.1"
                    value="${s.editedMeshRotationY ?? 180}" />
                <input type="number" id="mesh-rot-input" class="cal-panel__input cal-panel__input--narrow"
                    min="0" max="360" step="0.1"
                    value="${(s.editedMeshRotationY ?? 180).toFixed(1)}" />
            </div>
            <div class="cal-panel__delta" id="delta-mesh-rot-y">
                ${getDeltaText(s.editedMeshRotationY, s.originalMeshRotationY)}
            </div>
            <button id="mesh-rot-reset" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                Resetar
            </button>
        </div>

        <div class="cal-panel__slider-section">
            <h4 class="cal-panel__subtitle">mesh_rotation_x (pitch)</h4>
            <div class="cal-panel__slider-group">
                <input type="range" id="mesh-rotx-slider" class="cal-panel__slider"
                    min="-30" max="30" step="0.1"
                    value="${s.editedMeshRotationX ?? 0}" />
                <input type="number" id="mesh-rotx-input" class="cal-panel__input cal-panel__input--narrow"
                    min="-30" max="30" step="0.1"
                    value="${(s.editedMeshRotationX ?? 0).toFixed(1)}" />
            </div>
            <div class="cal-panel__delta" id="delta-mesh-rot-x">
                ${getDeltaText(s.editedMeshRotationX, s.originalMeshRotationX)}
            </div>
            <button id="mesh-rotx-reset" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                Resetar
            </button>
        </div>

        <div class="cal-panel__slider-section">
            <h4 class="cal-panel__subtitle">mesh_rotation_z (roll)</h4>
            <div class="cal-panel__slider-group">
                <input type="range" id="mesh-rotz-slider" class="cal-panel__slider"
                    min="-30" max="30" step="0.1"
                    value="${s.editedMeshRotationZ ?? 0}" />
                <input type="number" id="mesh-rotz-input" class="cal-panel__input cal-panel__input--narrow"
                    min="-30" max="30" step="0.1"
                    value="${(s.editedMeshRotationZ ?? 0).toFixed(1)}" />
            </div>
            <div class="cal-panel__delta" id="delta-mesh-rot-z">
                ${getDeltaText(s.editedMeshRotationZ, s.originalMeshRotationZ)}
            </div>
            <button id="mesh-rotz-reset" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                Resetar
            </button>
        </div>

    `;

    return renderCollapsibleSection('sliders', 'Parametros de Calibração', content);
}

function renderBatchSection(s) {
    const content = `
        <p class="cal-panel__hint" style="margin-bottom: 8px">
            Atualiza todas as fotos do projeto com os valores atuais.
        </p>
        <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button id="btn-batch-mesh" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                rotation_y &rarr; ${(s.editedMeshRotationY ?? 180).toFixed(1)}&deg;
            </button>
            <button id="btn-batch-rotx" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                rotation_x &rarr; ${(s.editedMeshRotationX ?? 0).toFixed(1)}&deg;
            </button>
            <button id="btn-batch-rotz" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                rotation_z &rarr; ${(s.editedMeshRotationZ ?? 0).toFixed(1)}&deg;
            </button>
            <button id="btn-batch-all" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                Todos
            </button>
        </div>
        <div style="margin-top: 8px;">
            <button id="btn-reset-reviewed" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost" style="color: #e74c3c; border-color: #e74c3c;">
                Resetar Revisoes
            </button>
        </div>
    `;

    return renderCollapsibleSection('batch', 'Aplicar ao Projeto', content);
}

function renderTargetsSection(targets, selectedTarget, s) {
    const content = `
        <div class="cal-panel__target-list" id="target-list">
            ${targets.map(t => renderTargetItem(t, s)).join('')}
        </div>
        ${selectedTarget ? renderTargetActions(selectedTarget) : ''}
    `;

    return renderCollapsibleSection('targets', 'Targets', content, { count: targets.length });
}

/**
 * Acoes do alvo selecionado.
 *
 * Estes tres botoes moravam dentro do editor de override e quase foram perdidos
 * junto com ele. Ocultar e remover conexao sao a UNICA propriedade que sobrou do
 * icone: acrescentar e tirar alvo por causa de parede. Nada aqui move marcador.
 *
 * @param {Object} target - Alvo selecionado
 * @returns {string} HTML das acoes
 */
function renderTargetActions(target) {
    const hidden = isTargetHidden(target.id);
    const isManual = target.is_original === false;

    return `
        <div class="cal-panel__target-actions">
            <button id="btn-toggle-hidden" class="cal-panel__btn cal-panel__btn--small ${hidden ? 'cal-panel__btn--hidden-active' : 'cal-panel__btn--ghost'}">
                ${hidden ? 'Mostrar Target' : 'Ocultar Target'}
            </button>
            ${isManual ? `
                <button id="btn-delete-target" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--danger">
                    Remover Conexao
                </button>
            ` : ''}
            <button id="btn-deselect-target" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                Fechar
            </button>
        </div>
    `;
}

function renderTargetItem(target, s) {
    const isSelected = target.id === s.selectedTargetId;
    const hidden = isTargetHidden(target.id);

    const hiddenBadge = hidden ? '<span class="cal-panel__hidden-badge">oculto</span>' : '';

    const displayName = target.display_name || target.id.slice(0, 8);
    const distText = target.distance != null ? `${target.distance.toFixed(1)}m` : '';
    const nextBadge = target.next ? '<span class="cal-panel__next-badge">next</span>' : '';

    return `
        <div class="cal-panel__target-item ${isSelected ? 'cal-panel__target-item--selected' : ''} ${hidden ? 'cal-panel__target-item--hidden' : ''}"
             data-target-id="${target.id}">
            <div class="cal-panel__target-info">
                <span class="cal-panel__target-name">${displayName}</span>
                ${nextBadge}
                ${hiddenBadge}
            </div>
            <span class="cal-panel__target-dist">${distText}</span>
        </div>
    `;
}

function renderPhotoList(s) {
    const photos = s.projectPhotos;
    if (!photos.length) return '';

    return `
        <div class="cal-panel__section">
            <h3 class="cal-panel__title">Fotos do Projeto</h3>
            <div class="cal-panel__photo-list" id="photo-list">
                ${photos.map(p => {
                    const isCurrent = p.id === s.currentPhotoId;
                    return `
                    <div class="cal-panel__photo-item ${isCurrent ? 'cal-panel__photo-item--current' : ''} ${p.reviewed ? 'cal-panel__photo-item--reviewed' : ''}"
                         data-photo-nav-id="${p.id}">
                        <span class="cal-panel__photo-status">${p.reviewed ? '&#10003;' : '&#9675;'}</span>
                        <span class="cal-panel__photo-name">${p.displayName}</span>
                        <span class="cal-panel__photo-seq">#${p.sequenceNumber}</span>
                    </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
}

function renderNearbyPhotos(s) {
    const nearby = s.nearbyPhotos;
    if (!nearby || !nearby.length) return '';

    const previewToggleBtn = `
        <button id="btn-nearby-preview-toggle" class="cal-panel__btn cal-panel__btn--small ${nearbyPreviewEnabled ? 'cal-panel__btn--active' : 'cal-panel__btn--ghost'}">
            Preview
        </button>
    `;

    const content = `
        <p class="cal-panel__hint">Fotos nao conectadas dentro do raio de busca.</p>
        <div class="cal-panel__nearby-list" id="nearby-list">
            ${nearby.map(p => `
                <div class="cal-panel__nearby-item ${previewingNearbyId === p.id ? 'cal-panel__nearby-item--previewing' : ''}" data-nearby-id="${p.id}">
                    <div class="cal-panel__nearby-info">
                        <span class="cal-panel__nearby-name">${p.displayName || p.id.slice(0, 8)}</span>
                        <span class="cal-panel__nearby-dist">${p.distance.toFixed(1)}m</span>
                    </div>
                    <button class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost cal-panel__nearby-add" data-add-target-id="${p.id}">
                        Adicionar
                    </button>
                </div>
            `).join('')}
        </div>
    `;

    return renderCollapsibleSection('nearby', 'Fotos Proximas', content, {
        count: nearby.length,
        headerExtra: previewToggleBtn,
    });
}

function getDeltaText(edited, original, unit = '\u00b0') {
    if (edited === null || original === null) return '';
    const delta = edited - original;
    if (Math.abs(delta) < 0.05) return '<span class="cal-panel__delta--zero">sem alteracao</span>';
    const sign = delta > 0 ? '+' : '';
    const unitHtml = unit === '\u00b0' ? '&deg;' : unit;
    return `<span class="cal-panel__delta--changed">${sign}${delta.toFixed(1)}${unitHtml}</span>`;
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

function attachEvents() {
    // Collapsible section toggles
    panelEl.querySelectorAll('[data-collapse-key]').forEach(el => {
        el.addEventListener('click', () => {
            toggleSection(el.dataset.collapseKey);
            renderPanel(state);
        });
    });

    // Grid toggle checkboxes
    const sphericalGridToggle = document.getElementById('spherical-grid-toggle');
    if (sphericalGridToggle) {
        sphericalGridToggle.checked = sphericalGridVisible;
        sphericalGridToggle.addEventListener('change', (e) => {
            sphericalGridVisible = e.target.checked;
            if (onSphericalGridToggleCallback) onSphericalGridToggleCallback(sphericalGridVisible);
        });
    }

    // mesh_rotation_y slider
    const meshSlider = document.getElementById('mesh-rot-slider');
    const meshInput = document.getElementById('mesh-rot-input');

    if (meshSlider) {
        // Use silent=true during drag to avoid full panel re-render (which kills the slider)
        meshSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            setMeshRotationY(val, true);
            if (onMeshRotationPreview) onMeshRotationPreview(val);
            if (meshInput) meshInput.value = val.toFixed(1);
        });
        // Notify on release so the rest of the UI updates
        meshSlider.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            setMeshRotationY(val);
            if (onMeshRotationPreview) onMeshRotationPreview(val);
        });
    }

    if (meshInput) {
        meshInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 180;
            val = Math.max(0, Math.min(360, val));
            setMeshRotationY(val);
            if (onMeshRotationPreview) onMeshRotationPreview(val);
        });
    }

    // Reset mesh_rotation_y
    document.getElementById('mesh-rot-reset')?.addEventListener('click', () => {
        setMeshRotationY(state.originalMeshRotationY);
        if (onMeshRotationPreview) onMeshRotationPreview(state.originalMeshRotationY);
    });

    // camera_height, distance_scale e marker_scale saíram por inteiro: nenhum
    // deles influencia o marcador, que agora e posicionado de forma relativa.


    // mesh_rotation_x slider
    const meshXSlider = document.getElementById('mesh-rotx-slider');
    const meshXInput = document.getElementById('mesh-rotx-input');

    if (meshXSlider) {
        meshXSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            setMeshRotationX(val, true);
            if (onMeshRotationXPreview) onMeshRotationXPreview(val);
            if (meshXInput) meshXInput.value = val.toFixed(1);
        });
        meshXSlider.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            setMeshRotationX(val);
            if (onMeshRotationXPreview) onMeshRotationXPreview(val);
        });
    }

    if (meshXInput) {
        meshXInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 0;
            val = Math.max(-30, Math.min(30, val));
            setMeshRotationX(val);
            if (onMeshRotationXPreview) onMeshRotationXPreview(val);
        });
    }

    document.getElementById('mesh-rotx-reset')?.addEventListener('click', () => {
        setMeshRotationX(state.originalMeshRotationX);
        if (onMeshRotationXPreview) onMeshRotationXPreview(state.originalMeshRotationX);
    });

    // mesh_rotation_z slider
    const meshZSlider = document.getElementById('mesh-rotz-slider');
    const meshZInput = document.getElementById('mesh-rotz-input');

    if (meshZSlider) {
        meshZSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            setMeshRotationZ(val, true);
            if (onMeshRotationZPreview) onMeshRotationZPreview(val);
            if (meshZInput) meshZInput.value = val.toFixed(1);
        });
        meshZSlider.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            setMeshRotationZ(val);
            if (onMeshRotationZPreview) onMeshRotationZPreview(val);
        });
    }

    if (meshZInput) {
        meshZInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 0;
            val = Math.max(-30, Math.min(30, val));
            setMeshRotationZ(val);
            if (onMeshRotationZPreview) onMeshRotationZPreview(val);
        });
    }

    document.getElementById('mesh-rotz-reset')?.addEventListener('click', () => {
        setMeshRotationZ(state.originalMeshRotationZ);
        if (onMeshRotationZPreview) onMeshRotationZPreview(state.originalMeshRotationZ);
    });



    // Batch update buttons
    document.getElementById('btn-batch-mesh')?.addEventListener('click', () => {
        handleBatchUpdate({ mesh_rotation_y: state.editedMeshRotationY });
    });
    document.getElementById('btn-batch-rotx')?.addEventListener('click', () => {
        handleBatchUpdate({ mesh_rotation_x: state.editedMeshRotationX });
    });
    document.getElementById('btn-batch-rotz')?.addEventListener('click', () => {
        handleBatchUpdate({ mesh_rotation_z: state.editedMeshRotationZ });
    });
    document.getElementById('btn-batch-all')?.addEventListener('click', () => {
        handleBatchUpdate({
            mesh_rotation_y: state.editedMeshRotationY,
            mesh_rotation_x: state.editedMeshRotationX,
            mesh_rotation_z: state.editedMeshRotationZ,
        });
    });
    document.getElementById('btn-reset-reviewed')?.addEventListener('click', () => {
        handleResetReviewed();
    });

    // Target list clicks
    document.getElementById('target-list')?.addEventListener('click', (e) => {
        const item = e.target.closest('[data-target-id]');
        if (item) {
            const targetId = item.dataset.targetId;
            if (targetId === state.selectedTargetId) {
                deselectTarget();
            } else {
                selectTarget(targetId);
            }
        }
    });

    // O editor de override saiu por inteiro (sliders de rumo, distancia e
    // altura, definir-com-clique e limpar). O icone nao e mais calibravel:
    // posicao errada se corrige movendo a FOTO, nao empurrando o marcador.

    // Deselect target
    document.getElementById('btn-deselect-target')?.addEventListener('click', () => {
        deselectTarget();
    });

    // Toggle hidden
    document.getElementById('btn-toggle-hidden')?.addEventListener('click', () => {
        if (state.selectedTargetId) {
            const currentlyHidden = isTargetHidden(state.selectedTargetId);
            setTargetHidden(state.selectedTargetId, !currentlyHidden);
        }
    });

    // Delete manual target
    document.getElementById('btn-delete-target')?.addEventListener('click', () => {
        if (state.selectedTargetId && onDeleteTargetCallback) {
            onDeleteTargetCallback(state.selectedTargetId);
        }
    });

    // Nearby preview toggle
    document.getElementById('btn-nearby-preview-toggle')?.addEventListener('click', (e) => {
        e.stopPropagation(); // Don't trigger collapse
        nearbyPreviewEnabled = !nearbyPreviewEnabled;
        if (!nearbyPreviewEnabled) {
            previewingNearbyId = null;
        }
        if (onNearbyPreviewToggleCallback) onNearbyPreviewToggleCallback(nearbyPreviewEnabled);
        renderPanel(state);
    });

    // Nearby photos - click for preview or add target
    document.getElementById('nearby-list')?.addEventListener('click', (e) => {
        // Check if add button was clicked
        const btn = e.target.closest('[data-add-target-id]');
        if (btn && onAddTargetCallback) {
            onAddTargetCallback(btn.dataset.addTargetId);
            return;
        }

        // Check if item was clicked (for preview)
        const item = e.target.closest('[data-nearby-id]');
        if (item && nearbyPreviewEnabled && onNearbySelectCallback) {
            const nearbyId = item.dataset.nearbyId;
            const nearbyPhoto = state.nearbyPhotos.find(p => p.id === nearbyId);
            if (nearbyPhoto) {
                previewingNearbyId = nearbyId;
                onNearbySelectCallback(nearbyPhoto);
                renderPanel(state);
            }
        }
    });

    // Save
    document.getElementById('btn-save')?.addEventListener('click', async () => {
        if (onSaveCallback && !isSaving) {
            isSaving = true;
            renderPanel(state);
            try {
                await onSaveCallback();
            } finally {
                isSaving = false;
                renderPanel(state);
            }
        }
    });

    // Discard
    document.getElementById('btn-discard')?.addEventListener('click', () => {
        if (onDiscardCallback) {
            onDiscardCallback();
        }
    });

    // Review workflow buttons
    document.getElementById('btn-toggle-reviewed')?.addEventListener('click', () => {
        if (onMarkReviewedCallback) {
            onMarkReviewedCallback(!state.calibrationReviewed);
        }
    });

    document.getElementById('btn-review-next')?.addEventListener('click', async () => {
        if (onSaveCallback && isDirty()) {
            await onSaveCallback();
        }
        if (onMarkReviewedCallback) {
            await onMarkReviewedCallback(true);
        }
        if (onNextPhotoCallback) {
            onNextPhotoCallback();
        }
    });

    document.getElementById('btn-next-photo')?.addEventListener('click', () => {
        if (onNextPhotoCallback) onNextPhotoCallback();
    });

    document.getElementById('btn-prev-photo')?.addEventListener('click', () => {
        if (onPrevPhotoCallback) onPrevPhotoCallback();
    });

    document.getElementById('btn-back-projects')?.addEventListener('click', () => {
        if (onBackToProjectsCallback) onBackToProjectsCallback();
    });

    // Open photo JSON in new tab
    document.getElementById('btn-open-json')?.addEventListener('click', () => {
        if (state.currentPhotoId) {
            window.open(`/api/v1/photos/${state.currentPhotoId}?include_hidden=true`, '_blank');
        }
    });

    // Delete photo
    document.getElementById('btn-delete-photo')?.addEventListener('click', () => {
        if (onDeletePhotoCallback && state.currentPhotoId) {
            onDeletePhotoCallback(state.currentPhotoId);
        }
    });

    // Photo list navigation
    document.getElementById('photo-list')?.addEventListener('click', (e) => {
        const item = e.target.closest('[data-photo-nav-id]');
        if (item && onNavigateToPhoto) {
            onNavigateToPhoto(item.dataset.photoNavId);
        }
    });

    // Scroll current photo into view in the photo list — somente quando a foto
    // atual realmente muda, evitando leitura/escrita de layout a cada re-render.
    if (state.currentPhotoId !== lastScrolledPhotoId) {
        const currentPhotoItem = document.querySelector('.cal-panel__photo-item--current');
        if (currentPhotoItem) {
            currentPhotoItem.scrollIntoView({ block: 'nearest' });
        }
        lastScrolledPhotoId = state.currentPhotoId;
    }
}

// ============================================================================
// BATCH UPDATE
// ============================================================================

async function handleBatchUpdate(values) {
    const slug = state.currentProjectSlug;
    if (!slug) {
        showToast('Projeto nao carregado', 'error');
        return;
    }

    const fields = [];
    if (values.mesh_rotation_y !== undefined) fields.push(`rotation_y=${values.mesh_rotation_y.toFixed(1)}`);
    if (values.mesh_rotation_x !== undefined) fields.push(`rotation_x=${values.mesh_rotation_x.toFixed(1)}`);
    if (values.mesh_rotation_z !== undefined) fields.push(`rotation_z=${values.mesh_rotation_z.toFixed(1)}`);
    const desc = fields.join(', ');

    // Confirm with user
    const confirmed = window.confirm(
        `Aplicar ${desc} a TODAS as fotos do projeto "${slug}"?\n\nEsta acao nao pode ser desfeita.`
    );
    if (!confirmed) return;

    try {
        const result = await batchUpdateProject(slug, values);
        const counts = [];
        for (const [key, info] of Object.entries(result.updated || {})) {
            counts.push(`${key}: ${info.photosUpdated} fotos`);
        }
        showToast(`Batch atualizado: ${counts.join(', ')}`, 'success');
    } catch (err) {
        console.error('Batch update failed:', err);
        showToast(`Erro no batch: ${err.message}`, 'error');
    }
}

async function handleResetReviewed() {
    const slug = state.currentProjectSlug;
    if (!slug) {
        showToast('Projeto nao carregado', 'error');
        return;
    }

    const confirmed = window.confirm(
        `Resetar TODAS as revisoes do projeto "${slug}"?\n\nTodas as fotos serao marcadas como nao revisadas.`
    );
    if (!confirmed) return;

    try {
        const result = await resetProjectReviewed(slug);
        resetAllReviewedState();
        showToast(`${result.photosReset} fotos resetadas`, 'success');
    } catch (err) {
        console.error('Reset reviewed failed:', err);
        showToast(`Erro ao resetar: ${err.message}`, 'error');
    }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Updates the spherical grid toggle state (called from keyboard shortcut).
 * @param {boolean} visible - Whether the spherical grid is visible
 */
export function setSphericalGridToggleState(visible) {
    sphericalGridVisible = visible;
    const el = document.getElementById('spherical-grid-toggle');
    if (el) el.checked = visible;
}

/**
 * Returns the current nearby preview state.
 * @returns {{ enabled: boolean, previewingId: string|null }}
 */
export function getNearbyPreviewState() {
    return { enabled: nearbyPreviewEnabled, previewingId: previewingNearbyId };
}

/**
 * Clears the nearby preview selection (e.g. when preview is closed).
 */
export function clearNearbyPreview() {
    previewingNearbyId = null;
}

/**
 * Shows a toast notification.
 * @param {string} message - Message to show
 * @param {'success'|'error'|'info'} [type='info'] - Toast type
 */
export function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `cal-toast cal-toast--${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
        toast.classList.add('cal-toast--visible');
    });

    // Remove after 3 seconds
    setTimeout(() => {
        toast.classList.remove('cal-toast--visible');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}
