/**
 * @module tests/unit/orientation.test
 * @description Unit tests for scripts/lib/orientation.js — pure math, no DB needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseQuaternion,
  quaternionToMeshRotation,
  quaternionToHeading,
  resolveMeshRotation,
  eulerZXYToMatrix,
  matrixToQuaternion,
} from '../../scripts/lib/orientation.js';

/** Asserts two angles in degrees are equal modulo 360, within a tolerance. */
function assertAngleClose(actual, expected, tolerance = 1e-6) {
  // Signed shortest angular difference, in (-180, 180]
  const diff = ((((actual - expected) % 360) + 540) % 360) - 180;
  assert.ok(
    Math.abs(diff) < tolerance,
    `expected ${actual} to equal ${expected} (mod 360), differed by ${diff}`
  );
}

describe('parseQuaternion', () => {
  it('accepts the [w, x, y, z] array order used by scanner CSVs', () => {
    const q = parseQuaternion([1, 0, 0, 0]);
    assert.deepEqual(q, { w: 1, x: 0, y: 0, z: 0 });
  });

  it('accepts w/x/y/z objects', () => {
    assert.deepEqual(parseQuaternion({ w: 1, x: 0, y: 0, z: 0 }), { w: 1, x: 0, y: 0, z: 0 });
  });

  it('accepts the qw/qx/qy/qz spelling from CSV headers', () => {
    assert.deepEqual(parseQuaternion({ qw: 1, qx: 0, qy: 0, qz: 0 }), { w: 1, x: 0, y: 0, z: 0 });
  });

  it('normalizes a non-unit quaternion', () => {
    const q = parseQuaternion([2, 0, 0, 0]);
    assert.equal(q.w, 1);
  });

  it('rejects unusable input instead of guessing', () => {
    assert.equal(parseQuaternion(null), null);
    assert.equal(parseQuaternion([1, 0, 0]), null);
    assert.equal(parseQuaternion([0, 0, 0, 0]), null);
    assert.equal(parseQuaternion({ w: 1, x: 0, y: 0 }), null);
    assert.equal(parseQuaternion({ w: 'a', x: 0, y: 0, z: 0 }), null);
    assert.equal(parseQuaternion([1, 0, 0, NaN]), null);
  });
});

describe('quaternionToMeshRotation', () => {
  it('maps the identity quaternion to no rotation', () => {
    const r = quaternionToMeshRotation([1, 0, 0, 0], { frame: 'y-up' });
    assertAngleClose(r.mesh_rotation_x, 0);
    assertAngleClose(r.mesh_rotation_y, 0);
    assertAngleClose(r.mesh_rotation_z, 0);
  });

  it('returns null for an unusable quaternion rather than a silent zero', () => {
    assert.equal(quaternionToMeshRotation(null), null);
    assert.equal(quaternionToMeshRotation([0, 0, 0, 0]), null);
  });

  it('round-trips Euler -> quaternion -> Euler in the viewer frame', () => {
    // This is the strong test: it validates the ZXY extraction independently of
    // any convention choice, because both ends use the viewer's own order.
    const cases = [
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 90, z: 0 },
      { x: 0, y: 175.6, z: 0 },   // a real museum value
      { x: 9.2, y: 0, z: 1.0 },   // the santa_cruz tilt reference
      { x: 4.2, y: 330, z: 1.3 }, // tilt combined with the project's yaw
      { x: -12, y: -45, z: 7 },
    ];

    for (const c of cases) {
      const q = matrixToQuaternion(eulerZXYToMatrix(c.x, c.y, c.z));
      const r = quaternionToMeshRotation(q, { frame: 'y-up' });

      assertAngleClose(r.mesh_rotation_x, c.x, 1e-6);
      assertAngleClose(r.mesh_rotation_y, c.y, 1e-6);
      assertAngleClose(r.mesh_rotation_z, c.z, 1e-6);
    }
  });

  it('produces a pure yaw for a rotation about the survey up axis', () => {
    // A z-up instrument panning 90 degrees must become yaw only, with the
    // panorama staying level. If the basis change were wrong this leaks into
    // pitch or roll, which is the failure mode worth catching.
    const half = (45 * Math.PI) / 180;
    const q = { w: Math.cos(half), x: 0, y: 0, z: Math.sin(half) };

    const r = quaternionToMeshRotation(q, { frame: 'z-up' });

    assert.ok(Math.abs(r.mesh_rotation_x) < 1e-9, `pitch leaked: ${r.mesh_rotation_x}`);
    assert.ok(Math.abs(r.mesh_rotation_z) < 1e-9, `roll leaked: ${r.mesh_rotation_z}`);
    assert.ok(Math.abs(r.mesh_rotation_y) > 1e-6, 'expected a non-zero yaw');
  });

  it('keeps a level instrument level regardless of how far it panned', () => {
    for (const yawDeg of [0, 30, 90, 175.6, 270, 359]) {
      const half = (yawDeg * Math.PI) / 360;
      const q = { w: Math.cos(half), x: 0, y: 0, z: Math.sin(half) };
      const r = quaternionToMeshRotation(q, { frame: 'z-up' });

      assert.ok(Math.abs(r.mesh_rotation_x) < 1e-9, `pitch leaked at yaw ${yawDeg}`);
      assert.ok(Math.abs(r.mesh_rotation_z) < 1e-9, `roll leaked at yaw ${yawDeg}`);
    }
  });

  it('turns a tilt of the survey frame into a non-zero tilt of the sphere', () => {
    // Tip the instrument about its east axis; the sphere must tilt too.
    const half = (5 * Math.PI) / 360;
    const q = { w: Math.cos(half), x: Math.sin(half), y: 0, z: 0 };

    const r = quaternionToMeshRotation(q, { frame: 'z-up' });
    const tilt = Math.hypot(r.mesh_rotation_x, r.mesh_rotation_z);

    assert.ok(Math.abs(tilt - 5) < 1e-6, `expected a 5 degree tilt, got ${tilt}`);
  });
});

describe('quaternionToHeading', () => {
  it('normalizes into [0, 360)', () => {
    const q = matrixToQuaternion(eulerZXYToMatrix(0, -45, 0));
    const heading = quaternionToHeading(q, { frame: 'y-up' });

    assert.ok(heading >= 0 && heading < 360, `heading out of range: ${heading}`);
    assertAngleClose(heading, 315);
  });

  it('returns null when there is no usable pose', () => {
    assert.equal(quaternionToHeading(undefined), null);
  });
});

describe('resolveMeshRotation', () => {
  it('lets explicit angles win, so the hand-calibrated archive is never overwritten', () => {
    const camera = {
      mesh_rotation_y: 175.6,
      mesh_rotation_x: -1.3,
      orientation: [1, 0, 0, 0],
    };

    const r = resolveMeshRotation(camera);

    assert.equal(r.source, 'explicit');
    assert.equal(r.mesh_rotation_y, 175.6);
    assert.equal(r.mesh_rotation_x, -1.3);
    assert.equal(r.mesh_rotation_z, 0);
  });

  it('uses the quaternion when no angle was given', () => {
    const q = matrixToQuaternion(eulerZXYToMatrix(0, 90, 0));
    const r = resolveMeshRotation({ orientation: q }, { frame: 'y-up' });

    assert.equal(r.source, 'quaternion');
    assertAngleClose(r.mesh_rotation_y, 90);
  });

  it('falls back to the historical defaults when there is neither', () => {
    const r = resolveMeshRotation({ lat: -30, lon: -51 });

    assert.equal(r.source, 'default');
    assert.equal(r.mesh_rotation_y, 180);
    assert.equal(r.mesh_rotation_x, 0);
    assert.equal(r.mesh_rotation_z, 0);
  });

  it('falls back to the defaults when the quaternion is malformed', () => {
    const r = resolveMeshRotation({ orientation: [0, 0, 0, 0] });

    assert.equal(r.source, 'default');
    assert.equal(r.mesh_rotation_y, 180);
  });

  it('tolerates missing camera metadata', () => {
    const r = resolveMeshRotation(undefined);

    assert.equal(r.source, 'default');
    assert.equal(r.mesh_rotation_y, 180);
  });
});
