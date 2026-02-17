/**
 * @fileoverview Calibration sidebar panel for the Street View 360 calibration interface.
 * Provides controls for mesh_rotation_y, target overrides, and save/discard actions.
 */

import {
    state, onChange, isDirty,
    setMeshRotationY, setCameraHeight,
    setMeshRotationX, setMeshRotationZ, setDistanceScale, setMarkerScale,
    setTargetOverride, setTargetOverrideHeight, clearTargetOverrideEdit,
    selectTarget, deselectTarget, setSetFromClickMode,
    setTargetHidden, isTargetHidden,
    getCurrentPhotoIndex, resetAllReviewedState,
} from './state.js';
import { batchUpdateProject, resetProjectReviewed } from './api.js';

// ============================================================================
// MODULE STATE
// ============================================================================

let panelEl = null;
let isSaving = false;
let gridVisible = false;

// Collapsible section state (persisted in localStorage)
const collapsedSections = new Map();
const COLLAPSED_STORAGE_KEY = 'cal-panel-collapsed';

// Nearby preview mode
let nearbyPreviewEnabled = false;
let previewingNearbyId = null;

// Callbacks set by app.js
let onSaveCallback = null;
let onDiscardCallback = null;
let onMeshRotationPreview = null;
let onCameraHeightPreview = null;
let onMeshRotationXPreview = null;
let onMeshRotationZPreview = null;
let onDistanceScalePreview = null;
let onMarkerScalePreview = null;
let onNavigateToPhoto = null;
let onMarkReviewedCallback = null;
let onNextPhotoCallback = null;
let onPrevPhotoCallback = null;
let onBackToProjectsCallback = null;
let onGridToggleCallback = null;
let onAddTargetCallback = null;
let onDeleteTargetCallback = null;
let onNearbyPreviewToggleCallback = null;
let onNearbySelectCallback = null;

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
    onCameraHeightPreview = options.onCameraHeightPreview || null;
    onMeshRotationXPreview = options.onMeshRotationXPreview || null;
    onMeshRotationZPreview = options.onMeshRotationZPreview || null;
    onDistanceScalePreview = options.onDistanceScalePreview || null;
    onMarkerScalePreview = options.onMarkerScalePreview || null;
    onNavigateToPhoto = options.onNavigateToPhoto || null;
    onMarkReviewedCallback = options.onMarkReviewed || null;
    onNextPhotoCallback = options.onNextPhoto || null;
    onPrevPhotoCallback = options.onPrevPhoto || null;
    onBackToProjectsCallback = options.onBackToProjects || null;
    onGridToggleCallback = options.onGridToggle || null;
    onAddTargetCallback = options.onAddTarget || null;
    onDeleteTargetCallback = options.onDeleteTarget || null;
    onNearbyPreviewToggleCallback = options.onNearbyPreviewToggle || null;
    onNearbySelectCallback = options.onNearbySelect || null;

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

function renderPanel(s) {
    if (!panelEl) return;

    // Preserve scroll position across re-renders
    const scrollTop = panelEl.scrollTop;

    const dirty = isDirty();
    const meta = s.currentMetadata;

    if (!meta) {
        panelEl.innerHTML = `
            <div class="cal-panel__empty">
                <p>Nenhuma foto carregada</p>
                <p class="cal-panel__hint">Use ?photo=UUID na URL ou selecione um projeto</p>
            </div>
        `;
        return;
    }

    const camera = meta.camera || {};
    const targets = meta.targets || [];
    const selectedTarget = targets.find(t => t.id === s.selectedTargetId);

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
            <button id="btn-prev-photo" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost" title="Foto anterior [P]">&larr;</button>
            <span class="cal-panel__photo-counter">${photoIdx} / ${totalPhotos}</span>
            <button id="btn-next-photo" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost" title="Proxima foto [N]">&rarr;</button>
        </div>
        ` : ''}

        <div class="cal-panel__section">
            <h3 class="cal-panel__title">Foto: ${camera.display_name || 'Sem nome'} ${s.calibrationReviewed ? '<span class="cal-panel__reviewed-badge">REVISADA</span>' : ''}</h3>
        </div>

        <div class="cal-panel__section cal-panel__section--grid">
            <label class="cal-panel__grid-toggle">
                <input type="checkbox" id="grid-toggle" />
                <span>Mostrar grade de perspectiva [G]</span>
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
            <button id="btn-toggle-reviewed" class="cal-panel__btn ${s.calibrationReviewed ? 'cal-panel__btn--ghost' : 'cal-panel__btn--reviewed'}" title="[R]">
                ${s.calibrationReviewed ? 'Desmarcar revisao' : 'Marcar revisada'}
            </button>
            <button id="btn-review-next" class="cal-panel__btn cal-panel__btn--review-next" title="Marcar revisada e ir para proxima [E]">
                Revisada &rarr; Proxima
            </button>
        </div>
        ` : ''}

        ${renderSlidersSection(s)}

        ${hasProject ? renderBatchSection(s) : ''}

        ${renderTargetsSection(targets, selectedTarget, s)}

        ${selectedTarget ? renderOverrideEditor(selectedTarget, s) : ''}

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
            <div class="cal-panel__delta">
                ${getDeltaText(s.editedMeshRotationY, s.originalMeshRotationY)}
            </div>
            <button id="mesh-rot-reset" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                Resetar
            </button>
        </div>

        <div class="cal-panel__slider-section">
            <h4 class="cal-panel__subtitle">camera_height</h4>
            <div class="cal-panel__slider-group">
                <input type="range" id="cam-height-slider" class="cal-panel__slider"
                    min="0.5" max="10" step="0.1"
                    value="${s.editedCameraHeight ?? 2.5}" />
                <input type="number" id="cam-height-input" class="cal-panel__input cal-panel__input--narrow"
                    min="0.5" max="10" step="0.1"
                    value="${(s.editedCameraHeight ?? 2.5).toFixed(1)}" />
            </div>
            <div class="cal-panel__delta">
                ${getDeltaText(s.editedCameraHeight, s.originalCameraHeight, 'm')}
            </div>
            <button id="cam-height-reset" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
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
            <div class="cal-panel__delta">
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
            <div class="cal-panel__delta">
                ${getDeltaText(s.editedMeshRotationZ, s.originalMeshRotationZ)}
            </div>
            <button id="mesh-rotz-reset" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                Resetar
            </button>
        </div>

        <div class="cal-panel__slider-section">
            <h4 class="cal-panel__subtitle">distance_scale</h4>
            <div class="cal-panel__slider-group">
                <input type="range" id="dist-scale-slider" class="cal-panel__slider"
                    min="0.1" max="5.0" step="0.01"
                    value="${s.editedDistanceScale ?? 1.0}" />
                <input type="number" id="dist-scale-input" class="cal-panel__input cal-panel__input--narrow"
                    min="0.1" max="5.0" step="0.01"
                    value="${(s.editedDistanceScale ?? 1.0).toFixed(2)}" />
            </div>
            <div class="cal-panel__delta">
                ${getDeltaText(s.editedDistanceScale, s.originalDistanceScale, 'x')}
            </div>
            <button id="dist-scale-reset" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                Resetar
            </button>
        </div>

        <div class="cal-panel__slider-section">
            <h4 class="cal-panel__subtitle">marker_scale</h4>
            <div class="cal-panel__slider-group">
                <input type="range" id="marker-scale-slider" class="cal-panel__slider"
                    min="0.1" max="5.0" step="0.01"
                    value="${s.editedMarkerScale ?? 1.0}" />
                <input type="number" id="marker-scale-input" class="cal-panel__input cal-panel__input--narrow"
                    min="0.1" max="5.0" step="0.01"
                    value="${(s.editedMarkerScale ?? 1.0).toFixed(2)}" />
            </div>
            <div class="cal-panel__delta">
                ${getDeltaText(s.editedMarkerScale, s.originalMarkerScale, 'x')}
            </div>
            <button id="marker-scale-reset" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
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
            <button id="btn-batch-height" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                height &rarr; ${(s.editedCameraHeight ?? 2.5).toFixed(1)}m
            </button>
            <button id="btn-batch-rotx" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                rotation_x &rarr; ${(s.editedMeshRotationX ?? 0).toFixed(1)}&deg;
            </button>
            <button id="btn-batch-rotz" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                rotation_z &rarr; ${(s.editedMeshRotationZ ?? 0).toFixed(1)}&deg;
            </button>
            <button id="btn-batch-scale" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                distance_scale &rarr; ${(s.editedDistanceScale ?? 1.0).toFixed(2)}x
            </button>
            <button id="btn-batch-marker-scale" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                marker_scale &rarr; ${(s.editedMarkerScale ?? 1.0).toFixed(2)}x
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
    `;

    return renderCollapsibleSection('targets', 'Targets', content, { count: targets.length });
}

function renderTargetItem(target, s) {
    const isSelected = target.id === s.selectedTargetId;
    const hasOverride = s.editedTargetOverrides.has(target.id);
    const isOriginalOverride = s.originalTargetOverrides.has(target.id);
    const hidden = isTargetHidden(target.id);

    let overrideIndicator = '';
    if (hasOverride) {
        const edited = s.editedTargetOverrides.get(target.id);
        if (edited.bearing === null && edited.distance === null) {
            overrideIndicator = '<span class="cal-panel__override-badge cal-panel__override-badge--cleared">limpo</span>';
        } else {
            overrideIndicator = '<span class="cal-panel__override-badge cal-panel__override-badge--set">override</span>';
        }
    } else if (isOriginalOverride) {
        overrideIndicator = '<span class="cal-panel__override-badge cal-panel__override-badge--original">override</span>';
    }

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
                ${overrideIndicator}
                ${hiddenBadge}
            </div>
            <span class="cal-panel__target-dist">${distText}</span>
        </div>
    `;
}

function renderOverrideEditor(target, s) {
    const edited = s.editedTargetOverrides.get(target.id);
    const original = s.originalTargetOverrides.get(target.id);
    const effective = edited || original || { bearing: null, distance: null, height: 0 };

    const hasEffectiveOverride = effective.bearing !== null;
    const hidden = isTargetHidden(target.id);
    const isManual = target.is_original === false;

    // bearing (degrees), distance = ground distance (meters), height = vertical offset (meters)
    const bearingVal = effective.bearing ?? 0;
    const distanceVal = effective.distance ?? 5;
    const heightVal = effective.height ?? 0;

    return `
        <div class="cal-panel__section cal-panel__section--override">
            <h3 class="cal-panel__title">Override: ${target.display_name || target.id.slice(0, 8)}</h3>

            ${hasEffectiveOverride ? `
                <div class="cal-panel__slider-group">
                    <label class="cal-panel__label">Bearing</label>
                    <input type="range" id="override-bearing-slider" class="cal-panel__slider"
                        min="0" max="360" step="0.5"
                        value="${bearingVal}" />
                    <input type="number" id="override-bearing-input" class="cal-panel__input cal-panel__input--narrow"
                        min="0" max="360" step="0.5"
                        value="${bearingVal.toFixed(1)}" />
                </div>

                <div class="cal-panel__slider-group">
                    <label class="cal-panel__label">Dist (m)</label>
                    <input type="range" id="override-distance-slider" class="cal-panel__slider"
                        min="0.5" max="200" step="0.1"
                        value="${distanceVal}" />
                    <input type="number" id="override-distance-input" class="cal-panel__input cal-panel__input--narrow"
                        min="0.5" max="500" step="0.1"
                        value="${distanceVal.toFixed(1)}" />
                </div>

                <div class="cal-panel__slider-group">
                    <label class="cal-panel__label">Altura (m)</label>
                    <input type="range" id="override-height-slider" class="cal-panel__slider"
                        min="-5" max="5" step="0.1"
                        value="${heightVal}" />
                    <input type="number" id="override-height-input" class="cal-panel__input cal-panel__input--narrow"
                        min="-10" max="10" step="0.1"
                        value="${heightVal.toFixed(1)}" />
                </div>
            ` : `
                <p class="cal-panel__hint">Sem override definido. Clique no viewer para posicionar.</p>
            `}

            <div class="cal-panel__override-actions">
                <button id="btn-set-from-click" class="cal-panel__btn cal-panel__btn--small ${s.setFromClickMode ? 'cal-panel__btn--active' : ''}">
                    ${s.setFromClickMode ? 'Clique no viewer...' : 'Definir com Clique'}
                </button>
                ${hasEffectiveOverride ? `
                    <button id="btn-clear-override" class="cal-panel__btn cal-panel__btn--small cal-panel__btn--ghost">
                        Limpar Override
                    </button>
                ` : ''}
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

    // Grid toggle checkbox
    const gridToggle = document.getElementById('grid-toggle');
    if (gridToggle) {
        gridToggle.checked = gridVisible;
        gridToggle.addEventListener('change', (e) => {
            gridVisible = e.target.checked;
            if (onGridToggleCallback) onGridToggleCallback(gridVisible);
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

    // camera_height slider
    const camHeightSlider = document.getElementById('cam-height-slider');
    const camHeightInput = document.getElementById('cam-height-input');

    if (camHeightSlider) {
        camHeightSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            setCameraHeight(val, true);
            if (onCameraHeightPreview) onCameraHeightPreview(val);
            if (camHeightInput) camHeightInput.value = val.toFixed(1);
        });
        camHeightSlider.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            setCameraHeight(val);
            if (onCameraHeightPreview) onCameraHeightPreview(val);
        });
    }

    if (camHeightInput) {
        camHeightInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 2.5;
            val = Math.max(0.5, Math.min(10, val));
            setCameraHeight(val);
            if (onCameraHeightPreview) onCameraHeightPreview(val);
        });
    }

    // Reset camera_height
    document.getElementById('cam-height-reset')?.addEventListener('click', () => {
        setCameraHeight(state.originalCameraHeight);
        if (onCameraHeightPreview) onCameraHeightPreview(state.originalCameraHeight);
    });

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

    // distance_scale slider
    const distScaleSlider = document.getElementById('dist-scale-slider');
    const distScaleInput = document.getElementById('dist-scale-input');

    if (distScaleSlider) {
        distScaleSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            setDistanceScale(val, true);
            if (onDistanceScalePreview) onDistanceScalePreview(val);
            if (distScaleInput) distScaleInput.value = val.toFixed(2);
        });
        distScaleSlider.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            setDistanceScale(val);
            if (onDistanceScalePreview) onDistanceScalePreview(val);
        });
    }

    if (distScaleInput) {
        distScaleInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 1.0;
            val = Math.max(0.1, Math.min(5.0, val));
            setDistanceScale(val);
            if (onDistanceScalePreview) onDistanceScalePreview(val);
        });
    }

    document.getElementById('dist-scale-reset')?.addEventListener('click', () => {
        setDistanceScale(state.originalDistanceScale);
        if (onDistanceScalePreview) onDistanceScalePreview(state.originalDistanceScale);
    });

    // marker_scale slider
    const markerScaleSlider = document.getElementById('marker-scale-slider');
    const markerScaleInput = document.getElementById('marker-scale-input');

    if (markerScaleSlider) {
        markerScaleSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            setMarkerScale(val, true);
            if (onMarkerScalePreview) onMarkerScalePreview(val);
            if (markerScaleInput) markerScaleInput.value = val.toFixed(2);
        });
        markerScaleSlider.addEventListener('change', (e) => {
            const val = parseFloat(e.target.value);
            setMarkerScale(val);
            if (onMarkerScalePreview) onMarkerScalePreview(val);
        });
    }

    if (markerScaleInput) {
        markerScaleInput.addEventListener('change', (e) => {
            let val = parseFloat(e.target.value);
            if (isNaN(val)) val = 1.0;
            val = Math.max(0.1, Math.min(5.0, val));
            setMarkerScale(val);
            if (onMarkerScalePreview) onMarkerScalePreview(val);
        });
    }

    document.getElementById('marker-scale-reset')?.addEventListener('click', () => {
        setMarkerScale(state.originalMarkerScale);
        if (onMarkerScalePreview) onMarkerScalePreview(state.originalMarkerScale);
    });

    // Batch update buttons
    document.getElementById('btn-batch-mesh')?.addEventListener('click', () => {
        handleBatchUpdate({ mesh_rotation_y: state.editedMeshRotationY });
    });
    document.getElementById('btn-batch-height')?.addEventListener('click', () => {
        handleBatchUpdate({ camera_height: state.editedCameraHeight });
    });
    document.getElementById('btn-batch-rotx')?.addEventListener('click', () => {
        handleBatchUpdate({ mesh_rotation_x: state.editedMeshRotationX });
    });
    document.getElementById('btn-batch-rotz')?.addEventListener('click', () => {
        handleBatchUpdate({ mesh_rotation_z: state.editedMeshRotationZ });
    });
    document.getElementById('btn-batch-scale')?.addEventListener('click', () => {
        handleBatchUpdate({ distance_scale: state.editedDistanceScale });
    });
    document.getElementById('btn-batch-marker-scale')?.addEventListener('click', () => {
        handleBatchUpdate({ marker_scale: state.editedMarkerScale });
    });
    document.getElementById('btn-batch-all')?.addEventListener('click', () => {
        handleBatchUpdate({
            mesh_rotation_y: state.editedMeshRotationY,
            camera_height: state.editedCameraHeight,
            mesh_rotation_x: state.editedMeshRotationX,
            mesh_rotation_z: state.editedMeshRotationZ,
            distance_scale: state.editedDistanceScale,
            marker_scale: state.editedMarkerScale,
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

    // Override bearing/distance/height sliders
    const bearingSlider = document.getElementById('override-bearing-slider');
    const bearingInput = document.getElementById('override-bearing-input');
    const distanceSlider = document.getElementById('override-distance-slider');
    const distanceInput = document.getElementById('override-distance-input');
    const heightSlider = document.getElementById('override-height-slider');
    const heightInput = document.getElementById('override-height-input');

    /** Helper to read current height value from slider */
    const getHeightVal = () => parseFloat(heightSlider?.value ?? 0);

    if (bearingSlider) {
        bearingSlider.addEventListener('input', (e) => {
            const bearing = parseFloat(e.target.value);
            if (bearingInput) bearingInput.value = bearing.toFixed(1);
            const distVal = parseFloat(distanceSlider?.value ?? 0);
            setTargetOverride(state.selectedTargetId, bearing, distVal, getHeightVal(), true);
        });
        bearingSlider.addEventListener('change', (e) => {
            const bearing = parseFloat(e.target.value);
            const distVal = parseFloat(distanceSlider?.value ?? 0);
            setTargetOverride(state.selectedTargetId, bearing, distVal, getHeightVal());
        });
    }

    if (bearingInput) {
        bearingInput.addEventListener('change', (e) => {
            let bearing = parseFloat(e.target.value);
            if (isNaN(bearing)) bearing = 0;
            bearing = Math.max(0, Math.min(360, bearing));
            const distVal = parseFloat(distanceSlider?.value ?? 0);
            setTargetOverride(state.selectedTargetId, bearing, distVal, getHeightVal());
        });
    }

    if (distanceSlider) {
        distanceSlider.addEventListener('input', (e) => {
            const distance = parseFloat(e.target.value);
            if (distanceInput) distanceInput.value = distance.toFixed(1);
            const bearingVal = parseFloat(bearingSlider?.value ?? 0);
            setTargetOverride(state.selectedTargetId, bearingVal, distance, getHeightVal(), true);
        });
        distanceSlider.addEventListener('change', (e) => {
            const distance = parseFloat(e.target.value);
            const bearingVal = parseFloat(bearingSlider?.value ?? 0);
            setTargetOverride(state.selectedTargetId, bearingVal, distance, getHeightVal());
        });
    }

    if (distanceInput) {
        distanceInput.addEventListener('change', (e) => {
            let distance = parseFloat(e.target.value);
            if (isNaN(distance)) distance = 5;
            distance = Math.max(0.5, Math.min(500, distance));
            const bearingVal = parseFloat(bearingSlider?.value ?? 0);
            setTargetOverride(state.selectedTargetId, bearingVal, distance, getHeightVal());
        });
    }

    if (heightSlider) {
        heightSlider.addEventListener('input', (e) => {
            const height = parseFloat(e.target.value);
            if (heightInput) heightInput.value = height.toFixed(1);
            setTargetOverrideHeight(state.selectedTargetId, height, true);
        });
        heightSlider.addEventListener('change', (e) => {
            const height = parseFloat(e.target.value);
            setTargetOverrideHeight(state.selectedTargetId, height);
        });
    }

    if (heightInput) {
        heightInput.addEventListener('change', (e) => {
            let height = parseFloat(e.target.value);
            if (isNaN(height)) height = 0;
            height = Math.max(-10, Math.min(10, height));
            setTargetOverrideHeight(state.selectedTargetId, height);
        });
    }

    // Set from click button
    document.getElementById('btn-set-from-click')?.addEventListener('click', () => {
        setSetFromClickMode(!state.setFromClickMode);
    });

    // Clear override
    document.getElementById('btn-clear-override')?.addEventListener('click', () => {
        if (state.selectedTargetId) {
            clearTargetOverrideEdit(state.selectedTargetId);
        }
    });

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

    // Photo list navigation
    document.getElementById('photo-list')?.addEventListener('click', (e) => {
        const item = e.target.closest('[data-photo-nav-id]');
        if (item && onNavigateToPhoto) {
            onNavigateToPhoto(item.dataset.photoNavId);
        }
    });

    // Scroll current photo into view in the photo list
    const currentPhotoItem = document.querySelector('.cal-panel__photo-item--current');
    if (currentPhotoItem) {
        currentPhotoItem.scrollIntoView({ block: 'nearest' });
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
    if (values.camera_height !== undefined) fields.push(`height=${values.camera_height.toFixed(1)}`);
    if (values.mesh_rotation_x !== undefined) fields.push(`rotation_x=${values.mesh_rotation_x.toFixed(1)}`);
    if (values.mesh_rotation_z !== undefined) fields.push(`rotation_z=${values.mesh_rotation_z.toFixed(1)}`);
    if (values.distance_scale !== undefined) fields.push(`dist_scale=${values.distance_scale.toFixed(2)}`);
    if (values.marker_scale !== undefined) fields.push(`marker_scale=${values.marker_scale.toFixed(2)}`);
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
 * Updates the grid toggle state (called from keyboard shortcut).
 * @param {boolean} visible - Whether the grid is visible
 */
export function setGridToggleState(visible) {
    gridVisible = visible;
    const gridToggle = document.getElementById('grid-toggle');
    if (gridToggle) gridToggle.checked = visible;
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
