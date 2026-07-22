/**
 * @module tests/unit/calibration-horizon-marker.test
 * @description Espelho deliberado de
 * ebgeo_web/tests/unit/streetview-horizon-marker.test.js.
 *
 * A calibracao existe para ajustar o que o visualizador mostra, entao qualquer
 * divergencia numerica entre os dois deixa a calibracao cega. Se um valor mudar
 * aqui, tem que mudar la, e vice-versa.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreetViewProjector } from '../../public/calibration/js/projector.js';
import { NAV_CONSTANTS } from '../../public/calibration/js/constants.js';
import { layoutDirections, resolveTargetVector, assignHitRadii as navAssignHitRadii } from '../../public/calibration/js/navigator.js';
import { rankOpacity } from '../../public/calibration/js/renderer.js';
import { StreetViewHitTester } from '../../public/calibration/js/hit-tester.js';

// Canvas of a typical desktop viewer, and the default FOV of the 360 camera.
const WIDTH = 1200;
const HEIGHT = 800;
const FOV = 75;

/**
 * Builds a projector looking at a given world bearing, with no pitch.
 * The navigator derives yaw from the world heading as yaw = -heading (radians).
 */
function projectorLookingAt(headingDeg, cameraConfig = {}) {
    const projector = new StreetViewProjector(WIDTH, HEIGHT);
    projector.setCameraConfig({ lon: 0, lat: 0, ...cameraConfig });
    return { projector, yaw: -(headingDeg * Math.PI) / 180 };
}

/** Projetor e camera avulsos: na calibracao o arranjo e funcao de modulo. */
function navigatorStub(cameraConfig = { lon: 0, lat: 0 }) {
    const projector = new StreetViewProjector(WIDTH, HEIGHT);
    projector.setCameraConfig(cameraConfig);
    return {
        projector,
        cameraConfig,
        canvas: { width: WIDTH, height: HEIGHT },
        resolveTargetVector: (t) => resolveTargetVector(t, projector, cameraConfig),
        layoutDirections: (t, fov) => layoutDirections(t, fov, projector, cameraConfig),
        assignHitRadii: (m) => navAssignHitRadii(m, HEIGHT),
    };
}

/** A target as the API delivers it: bearing and distance derived from lat/lon. */
function target(id, bearing, distance, extra = {}) {
    return { id, bearing, distance, ...extra };
}

describe('projectOnHorizon', () => {
    it('places a target straight ahead at the centre of the canvas', () => {
        const { projector, yaw } = projectorLookingAt(0);
        const result = projector.projectOnHorizon(0, yaw, 0, FOV);

        assert.equal(result.visible, true);
        assert.ok(Math.abs((result.screenX) - (WIDTH / 2)) < 1e-6);
        assert.ok(Math.abs((result.screenY) - (HEIGHT / 2)) < 1e-6);
        assert.ok(Math.abs((result.azimuthRelDeg) - (0)) < 1e-6);
    });

    it('puts a target to the right of the view on the right half of the canvas', () => {
        const { projector, yaw } = projectorLookingAt(0);
        const result = projector.projectOnHorizon(20, yaw, 0, FOV);

        assert.equal(result.visible, true);
        assert.ok((result.screenX) > (WIDTH / 2));
        assert.ok(Math.abs((result.azimuthRelDeg) - (20)) < 1e-6);
    });

    it('reports a negative relative azimuth for a target to the left', () => {
        const { projector, yaw } = projectorLookingAt(90);
        const result = projector.projectOnHorizon(70, yaw, 0, FOV);

        assert.ok(Math.abs((result.azimuthRelDeg) - (-20)) < 1e-6);
        assert.ok((result.screenX) < (WIDTH / 2));
    });

    it('wraps the relative azimuth across north instead of reporting 350 degrees', () => {
        const { projector, yaw } = projectorLookingAt(10);
        const result = projector.projectOnHorizon(350, yaw, 0, FOV);

        assert.ok(Math.abs((result.azimuthRelDeg) - (-20)) < 1e-6);
    });

    it('marks a target behind the camera as not visible', () => {
        const { projector, yaw } = projectorLookingAt(0);
        const result = projector.projectOnHorizon(180, yaw, 0, FOV);

        assert.equal(result.visible, false);
        assert.ok(Math.abs((Math.abs(result.azimuthRelDeg)) - (180)) < 1e-6);
    });

    it('follows the horizon when the camera pitches', () => {
        // The band is anchored to the corrected horizon, so tilting the view
        // must carry the icons with it.
        const { projector, yaw } = projectorLookingAt(0);

        const level = projector.projectOnHorizon(0, yaw, 0, FOV);
        const lookingDown = projector.projectOnHorizon(0, yaw, -(20 * Math.PI) / 180, FOV);

        assert.ok((lookingDown.screenY) < (level.screenY));
    });
});

describe('angularMarkerRadius', () => {
    it('shrinks by a constant fraction for each rank', () => {
        const { projector } = projectorLookingAt(0);

        const first = projector.angularMarkerRadius(0, FOV);
        const second = projector.angularMarkerRadius(1, FOV);

        assert.ok(Math.abs((second / first) - (NAV_CONSTANTS.HORIZON_RANK_DECAY)) < 1e-2);
    });

    it('satisfies the inequality that makes any queue length fit the band', () => {
        // r0 <= (1 - decay) * band. This single relation is what replaces every
        // stacking rule: when it holds, the centre of every icon falls outside
        // the disc in front of it, for any number of icons.
        const band = NAV_CONSTANTS.HORIZON_BASE_DEPRESSION_DEG
            + NAV_CONSTANTS.HORIZON_CEILING_ELEVATION_DEG;
        const limit = (1 - NAV_CONSTANTS.HORIZON_RANK_DECAY) * band;

        assert.ok((NAV_CONSTANTS.HORIZON_ANGULAR_NEAR) <= (limit));
    });

    it('shrinks monotonically down the queue', () => {
        const { projector } = projectorLookingAt(0);
        const radii = [0, 1, 2, 3, 4].map(rank => projector.angularMarkerRadius(rank, FOV));

        for (let i = 1; i < radii.length; i++) {
            assert.ok((radii[i]) <= (radii[i - 1]));
        }
    });

    it('keeps shrinking without a floor, so the gap guarantee never breaks', () => {
        // Flooring the drawn size would break the invariant: the gap keeps
        // shrinking geometrically while a floored radius would not, so deep
        // icons would start covering each other's centres.
        const { projector } = projectorLookingAt(0);

        assert.ok((projector.angularRadiusDeg(6)) < (projector.angularRadiusDeg(5)));
    });

    it('grows when zooming in, so markers stay proportional to the scene', () => {
        const { projector } = projectorLookingAt(0);

        assert.ok((projector.angularMarkerRadius(0, 30)) > (projector.angularMarkerRadius(0, 75)));
    });

    it('does not depend on distance in any way', () => {
        // The whole point of the redesign: the archive's metric fields are not
        // trustworthy, so none of them reaches the drawing.
        const { projector } = projectorLookingAt(0);
        const plain = projector.angularMarkerRadius(1, FOV);

        projector.setCameraConfig({
            lon: 0, lat: 0,
            height: 1.5, distance_scale: 1.59, marker_scale: 0.3,
        });

        assert.ok(Math.abs((projector.angularMarkerRadius(1, FOV)) - (plain)) < 1e-9);
    });
});

describe('resolveTargetVector', () => {
    it('takes bearing and distance straight from the API, which derives them from lat/lon', () => {
        const nav = navigatorStub();
        const vector = nav.resolveTargetVector(target('a', 340.4, 1.79));

        assert.deepEqual(vector, { bearing: 340.4, distance: 1.79 });
    });

    it('ignores the legacy per-target overrides entirely', () => {
        // A real museum target carries override_bearing 347.17 and
        // override_distance 17.32 against a measured 10.21 m. Honouring the
        // override silently reordered the queue.
        const nav = navigatorStub();
        const vector = nav.resolveTargetVector(target('a', 351.47, 10.21, {
            override_bearing: 347.17,
            override_distance: 17.32,
            override_height: 2,
        }));

        assert.deepEqual(vector, { bearing: 351.47, distance: 10.21 });
    });

    it('falls back to geometry for metadata without a precomputed vector', () => {
        // lonLatToMeters is stubbed because it reaches for the Turf global, which
        // only exists in the browser. Ten metres due east of the camera.
        const nav = navigatorStub({ lon: 0, lat: 0 });
        nav.projector.lonLatToMeters = () => ({ x: 10, z: 0 });

        const vector = nav.resolveTargetVector({
            id: 'a', lon: 0.0001, lat: 0, bearing: null, distance: null,
        });

        assert.ok(Math.abs((vector.bearing) - (90)) < 1e-6);
        assert.ok(Math.abs((vector.distance) - (10)) < 1e-6);
    });
});

describe('elevationDeg', () => {
    it('puts the first icon below the corrected horizon', () => {
        const { projector } = projectorLookingAt(0);
        assert.ok(Math.abs((projector.elevationDeg(0)) - (-NAV_CONSTANTS.HORIZON_BASE_DEPRESSION_DEG)) < 1e-6);
    });

    it('climbs towards the ceiling but never crosses it, however long the queue', () => {
        const { projector } = projectorLookingAt(0);
        const ceiling = NAV_CONSTANTS.HORIZON_CEILING_ELEVATION_DEG;

        // Never ABOVE the ceiling. At very deep ranks the decay underflows to
        // zero and the elevation lands exactly on it, which is the limit itself.
        for (const rank of [1, 2, 5, 20, 200]) {
            assert.ok((projector.elevationDeg(rank)) <= (ceiling));
        }
        assert.ok((projector.elevationDeg(3)) < (ceiling));
        assert.ok(Math.abs((projector.elevationDeg(200)) - (ceiling)) < 1e-3);
    });

    it('rises monotonically', () => {
        const { projector } = projectorLookingAt(0);
        const alturas = [0, 1, 2, 3, 4].map(r => projector.elevationDeg(r));

        for (let i = 1; i < alturas.length; i++) {
            assert.ok((alturas[i]) > (alturas[i - 1]));
        }
    });
});

describe('layoutDirections', () => {
    // The real first photo of the museum: four targets down one corridor.
    const museum = [
        target('0002', 340.39, 1.79),
        target('0003', 339.79, 4.54),
        target('0005', 339.77, 14.43),
        target('0004', 351.47, 10.21),
    ];

    it('ranks a queue by distance, nearest first', () => {
        const nav = navigatorStub();
        const layout = nav.layoutDirections(museum, FOV);

        // 0002, 0003 e 0005 estao a menos de um grau um do outro: sao uma fila,
        // e nela os postos crescem em ordem de distancia. Nao sao inteiros
        // porque cada um carrega tambem seu lugar na ordem de distancia da foto.
        assert.equal(layout.get('0002').rank, 0);
        assert.ok((layout.get('0003').rank) > (1));
        assert.ok((layout.get('0003').rank) < (2));

        // 0004 esta a 11 graus dos outros. Com o balde fixo de 25 graus ele era
        // empilhado e subia; agora e a primeira esfera da propria direcao, que
        // e o que se ve na foto: ele esta ao lado, nao atras.
        assert.ok((layout.get('0004').rank) < (1));
    });

    it('shrinks a lone far target, so distance still reads without a queue', () => {
        // O pedido que motivou o termo de distancia: sem ele, um alvo isolado a
        // 60 m era desenhado exatamente como um alvo isolado a 3 m.
        const nav = navigatorStub();
        const layout = nav.layoutDirections([
            target('perto', 0, 3),
            target('longe', 120, 60),
        ], FOV);

        // Cada um e o primeiro da propria direcao, entao a fila nao os separa.
        assert.ok((layout.get('longe').radius) < (layout.get('perto').radius));
        assert.ok((layout.get('longe').elevationDeg) > (layout.get('perto').elevationDeg));
    });

    it('bounds that nudge to less than one queue position', () => {
        // O termo de distancia e um tempero, nao um segundo criterio: o alvo
        // mais distante da foto nunca encolhe tanto quanto encolheria por estar
        // um posto atras numa fila.
        const nav = navigatorStub();
        const layout = nav.layoutDirections([
            target('perto', 0, 3),
            target('longe', 120, 600),
        ], FOV);

        assert.ok((layout.get('longe').rank) < (1));
        assert.ok(Math.abs((layout.get('longe').rank)
            - (NAV_CONSTANTS.HORIZON_DISTANCE_RANK_WEIGHT)) < 1e-6);
    });

    it('keeps the distance nudge from ever shrinking the gap below one rank', () => {
        // A garantia inteira depende de postos consecutivos diferirem de pelo
        // menos 1. Como a fila e ordenada por distancia, o termo global nunca
        // decresce ao longo dela, entao o passo so aumenta.
        const nav = navigatorStub();
        const fila = Array.from({ length: 12 }, (_, i) => target(`t${i}`, 340, 2 + i * 5));
        const layout = nav.layoutDirections(fila, FOV);

        const postos = [...layout.values()].map(p => p.rank).sort((a, b) => a - b);
        for (let i = 1; i < postos.length; i++) {
            assert.ok((postos[i] - postos[i - 1]) >= (1));
        }
    });

    it('puts the first icon of a direction at the bottom of the band', () => {
        const nav = navigatorStub();
        const layout = nav.layoutDirections(museum, FOV);

        assert.ok(Math.abs((layout.get('0002').elevationDeg) - (-NAV_CONSTANTS.HORIZON_BASE_DEPRESSION_DEG)) < 1e-6);
    });

    it('keeps every centre clear of the disc in front, however long the queue', () => {
        // The property the whole model exists for. Checked on a queue of twelve,
        // to show it does not depend on the count.
        const nav = navigatorStub();
        const fila = Array.from({ length: 12 }, (_, i) => target(`t${i}`, 340, 2 + i * 5));
        const layout = nav.layoutDirections(fila, FOV);
        const focal = nav.projector.focalLength(FOV);
        const px = deg => focal * Math.tan((deg * Math.PI) / 180);

        const queue = [...layout.values()].sort((a, b) => a.rank - b.rank);
        assert.ok((queue.length) > (1));

        for (let i = 1; i < queue.length; i++) {
            const gap = px(queue[i].elevationDeg) - px(queue[i - 1].elevationDeg);
            assert.ok((gap) >= (queue[i - 1].radius));
        }
    });

    it('never lets a queue climb past the ceiling, however long', () => {
        const nav = navigatorStub();
        const fila = Array.from({ length: 30 }, (_, i) => target(`t${i}`, 340, 2 + i * 5));
        const layout = nav.layoutDirections(fila, FOV);

        for (const p of layout.values()) {
            assert.ok((p.elevationDeg) <= (NAV_CONSTANTS.HORIZON_CEILING_ELEVATION_DEG));
        }
    });

    it('does not push a target sideways up: a lone direction stays near the bottom', () => {
        // The complaint that started this: a target 20 degrees off was being
        // stacked and raised as if it were behind the near one. It still rises a
        // little, for being far, but nothing like a whole queue position.
        const nav = navigatorStub();
        const layout = nav.layoutDirections([
            target('frente', 340, 2),
            target('lado', 320, 30),
        ], FOV);

        assert.ok((layout.get('lado').rank) < (1));
        assert.ok((layout.get('lado').elevationDeg) < (0));
        assert.ok((layout.get('lado').elevationDeg) > (-NAV_CONSTANTS.HORIZON_BASE_DEPRESSION_DEG));
    });

    it('separates targets that lie in genuinely different directions', () => {
        const nav = navigatorStub();
        const layout = nav.layoutDirections([
            target('frente', 0, 3),
            target('tras', 180, 4),
        ], FOV);

        // Neither is behind the other, so neither takes a queue position.
        assert.equal(layout.get('frente').rank, 0);
        assert.ok((layout.get('tras').rank) < (1));
        assert.ok(Math.abs((layout.get('frente').elevationDeg) - (-NAV_CONSTANTS.HORIZON_BASE_DEPRESSION_DEG)) < 1e-6);
    });

    it('stacks two targets only when their icons would actually cover each other', () => {
        const nav = navigatorStub();
        const alcance = NAV_CONSTANTS.HORIZON_ANGULAR_NEAR
            * (1 + NAV_CONSTANTS.HORIZON_RANK_DECAY);

        const juntos = nav.layoutDirections([
            target('a', 0, 3),
            target('b', alcance * 0.5, 6),
        ], FOV);
        assert.ok((juntos.get('b').rank) >= (1));

        const separados = nav.layoutDirections([
            target('a', 0, 3),
            target('b', alcance * 2, 6),
        ], FOV);
        assert.ok((separados.get('b').rank) < (1));
    });

    it('handles a direction that straddles north', () => {
        // Tres graus de separacao, um de cada lado do norte: a diferenca
        // circular tem que dar 3, e nao 357.
        const nav = navigatorStub();
        const layout = nav.layoutDirections([
            target('a', 359, 3),
            target('b', 2, 6),
        ], FOV);

        assert.ok((layout.get('b').rank) >= (1));
    });

    it('ends a queue on legibility, not on a chosen maximum', () => {
        const nav = navigatorStub();
        const many = Array.from({ length: 9 }, (_, i) => target(`t${i}`, 10, i + 1));
        const layout = nav.layoutDirections(many, FOV);

        // Whatever is drawn is drawn from the front, and every one drawn is
        // above the legibility threshold. The count is a consequence.
        assert.equal(layout.has('t0'), true);
        for (const p of layout.values()) {
            assert.ok((nav.projector.angularRadiusDeg(p.rank)) >= (NAV_CONSTANTS.HORIZON_MIN_ANGULAR_DRAW));
        }
        assert.ok((layout.size) < (many.length));
    });
});

describe('assignHitRadii', () => {
    const assign = markers => navAssignHitRadii(markers, HEIGHT);

    it('gives a small distant marker a target far bigger than its drawing', () => {
        const marker = { radius: 8, screenX: 0, screenY: 0 };
        assign([marker]);

        assert.ok((marker.hitRadius) >= (HEIGHT * NAV_CONSTANTS.HIT_RADIUS_MIN_REL));
        assert.ok((marker.hitRadius) > (marker.radius * 2));
    });

    it('scales the target with the drawing once the drawing is large', () => {
        const marker = { radius: 40, screenX: 0, screenY: 0 };
        assign([marker]);

        assert.ok(Math.abs((marker.hitRadius) - (40 * NAV_CONSTANTS.HIT_RADIUS_MULTIPLIER)) < 1e-6);
    });

    it('keeps the target proportional to the canvas, not to a fixed pixel count', () => {
        const small = { radius: 8, screenX: 0, screenY: 0 };
        const big = { radius: 8, screenX: 0, screenY: 0 };

        navAssignHitRadii([small], 400);
        navAssignHitRadii([big], 1600);

        assert.ok((big.hitRadius) > (small.hitRadius));
    });
});

describe('rankOpacity', () => {
    it('never fades the target a click would take', () => {
        assert.equal(rankOpacity(0, true), 1);
        assert.equal(rankOpacity(9, true), 1);
    });

    it('fades progressively down the queue', () => {
        const alphas = [0, 1, 2, 3].map(r => rankOpacity(r));

        for (let i = 1; i < alphas.length; i++) {
            assert.ok((alphas[i]) < (alphas[i - 1]));
        }
    });

    it('never fades so far that a marker stops looking clickable', () => {
        assert.ok((rankOpacity(50)) >= (NAV_CONSTANTS.HORIZON_RANK_FADE_MIN));
    });
});

describe('every icon of a queue stays clickable', () => {
    // The property the whole layout exists to guarantee, checked end to end on
    // the real first photo of the museum: build the queue, place it on screen,
    // then click the exact centre of each icon and demand that icon back.
    const museum = [
        { id: '0002', bearing: 340.39, distance: 1.787 },
        { id: '0003', bearing: 339.79, distance: 4.538 },
        { id: '0004', bearing: 351.47, distance: 10.209 },
        { id: '0005', bearing: 339.77, distance: 14.432 },
    ];

    function buildMarkers() {
        const nav = navigatorStub({ lon: -51.2354, lat: -30.0318 });
        const layout = nav.layoutDirections(museum, FOV);
        const focal = nav.projector.focalLength(FOV);

        // Uma fila so: o 0004 fica noutra direcao, entao nao entra na coluna.
        const fila = museum.filter(t => layout.get(t.id) && t.id !== '0004');

        const markers = fila.map(t => {
            const placement = layout.get(t.id);
            return {
                id: t.id,
                screenX: WIDTH / 2,
                screenY: HEIGHT / 2 - focal * Math.tan((placement.elevationDeg * Math.PI) / 180),
                radius: placement.radius,
                distance: placement.rank,
                type: 'navigation',
            };
        });

        nav.assignHitRadii(markers);
        return markers;
    }

    it('returns each icon when its own centre is clicked', () => {
        const markers = buildMarkers();
        const hitTester = new StreetViewHitTester();
        hitTester.setMarkers(markers);

        for (const marker of markers) {
            const hit = hitTester.testPoint(marker.screenX, marker.screenY);
            assert.equal(hit?.id, marker.id, `clicando no centro de ${marker.id}`);
        }
    });

    it('leaves no icon fully buried under its neighbour', () => {
        const markers = buildMarkers();

        for (let i = 1; i < markers.length; i++) {
            const gap = Math.abs(markers[i].screenY - markers[i - 1].screenY);
            // Centres must be far enough apart that each circle still shows.
            assert.ok((gap) > (Math.max(markers[i].radius, markers[i - 1].radius)));
        }
    });
});

describe('a suite exercita a funcao de producao, nao uma copia', () => {
  it('assignHitRadii vem do navigator, e nao do arquivo de teste', () => {
    // A versao anterior REIMPLEMENTAVA a formula aqui dentro: ficava verde
    // mesmo que a producao mudasse.
    assert.equal(typeof navAssignHitRadii, 'function');
    assert.equal(navAssignHitRadii.name, 'assignHitRadii');

    const marcador = { radius: 8, screenX: 0, screenY: 0 };
    navAssignHitRadii([marcador], 800);
    assert.ok(marcador.hitRadius > 0);
  });
});
