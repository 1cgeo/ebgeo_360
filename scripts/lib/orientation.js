/**
 * @module scripts/lib/orientation
 * @description Converts a panorama pose expressed as a quaternion into the
 * Euler angles the 360 viewer applies to the panorama sphere.
 *
 * Why this exists: scanners, SLAM rigs and SfM reconstructions all emit the pose
 * of each panorama as a position plus a quaternion. Our archive instead stores
 * three Euler angles that an operator tuned by hand, one photo at a time. This
 * module is the bridge, so a capture that already knows where it was pointing
 * does not have to be re-calibrated by hand.
 *
 * CONVENTIONS, read before trusting the output:
 *
 * - The viewer rotates the sphere with Three.js Euler order 'ZXY', i.e. the
 *   matrix Rz*Rx*Ry (see street_view_viewer.js, `mesh.rotation.order = 'ZXY'`).
 *   The extraction below mirrors Three.js `Euler.setFromRotationMatrix` exactly,
 *   so the angles are consistent with the renderer by construction.
 * - Three.js is Y-up. Survey instruments are almost always Z-up right-handed
 *   (X east, Y north, Z up). The `frame` option performs that basis change; it
 *   defaults to 'z-up' because that is what a scanner emits.
 * - The SIGN and PHASE of the result against a real instrument have NOT been
 *   confirmed against ground truth, because no dataset in our archive carries
 *   quaternions yet. The measured tilt reference in docs/tilt-estimation is in
 *   Euler terms only. Confirm against the first real quaternion dataset before
 *   trusting a batch, and adjust `frame` rather than patching the formulas.
 */

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Normalizes the many shapes a quaternion arrives in.
 * Accepts [w, x, y, z] (the order every scanner CSV in the wild uses),
 * or an object with w/x/y/z or qw/qx/qy/qz keys.
 *
 * @param {number[]|Object} q - Quaternion in any accepted shape
 * @returns {{w: number, x: number, y: number, z: number}|null} Normalized quaternion, or null if unusable
 */
export function parseQuaternion(q) {
  if (!q) return null;

  let w, x, y, z;

  if (Array.isArray(q)) {
    if (q.length !== 4) return null;
    [w, x, y, z] = q;
  } else if (typeof q === 'object') {
    w = q.w ?? q.qw;
    x = q.x ?? q.qx;
    y = q.y ?? q.qy;
    z = q.z ?? q.qz;
  } else {
    return null;
  }

  if (![w, x, y, z].every(v => typeof v === 'number' && Number.isFinite(v))) {
    return null;
  }

  const norm = Math.sqrt(w * w + x * x + y * y + z * z);
  if (norm < 1e-9) return null;

  return { w: w / norm, x: x / norm, y: y / norm, z: z / norm };
}

/**
 * Builds a 3x3 rotation matrix from a unit quaternion.
 * Elements are named as in Three.js: mRC is row R, column C.
 *
 * @param {{w: number, x: number, y: number, z: number}} q - Unit quaternion
 * @returns {number[][]} Row-major 3x3 rotation matrix
 */
function quaternionToMatrix(q) {
  const { w, x, y, z } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  return [
    [1 - (yy + zz), xy - wz, xz + wy],
    [xy + wz, 1 - (xx + zz), yz - wx],
    [xz - wy, yz + wx, 1 - (xx + yy)]
  ];
}

/**
 * Changes basis from a Z-up right-handed survey frame (X east, Y north, Z up)
 * to the Three.js Y-up frame, by conjugating with a -90 degree rotation about X.
 *
 * @param {number[][]} m - Rotation matrix in the Z-up frame
 * @returns {number[][]} Rotation matrix in the Y-up frame
 */
function zUpToYUp(m) {
  // B maps z-up to y-up: (x, y, z) -> (x, z, -y)
  const B = [
    [1, 0, 0],
    [0, 0, 1],
    [0, -1, 0]
  ];
  // B^-1 is B transposed, since B is a rotation
  const Bt = [
    [1, 0, 0],
    [0, 0, -1],
    [0, 1, 0]
  ];
  return multiply(multiply(B, m), Bt);
}

/**
 * Multiplies two 3x3 matrices.
 *
 * @param {number[][]} a - Left matrix
 * @param {number[][]} b - Right matrix
 * @returns {number[][]} Product a*b
 */
function multiply(a, b) {
  const out = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
    }
  }
  return out;
}

/**
 * Extracts Euler angles in Three.js 'ZXY' order from a rotation matrix.
 * Mirrors Three.js Euler.setFromRotationMatrix so the angles feed the sphere
 * without any further adjustment.
 *
 * @param {number[][]} m - Row-major 3x3 rotation matrix
 * @returns {{x: number, y: number, z: number}} Euler angles in radians
 */
function matrixToEulerZXY(m) {
  const m11 = m[0][0], m12 = m[0][1];
  const m21 = m[1][0], m22 = m[1][1];
  const m31 = m[2][0], m32 = m[2][1], m33 = m[2][2];

  const x = Math.asin(Math.max(-1, Math.min(1, m32)));

  // Near the gimbal pole the y/z split is undetermined; pin y and fold the
  // whole rotation into z, exactly as Three.js does.
  if (Math.abs(m32) < 0.9999999) {
    return { x, y: Math.atan2(-m31, m33), z: Math.atan2(-m12, m22) };
  }
  return { x, y: 0, z: Math.atan2(m21, m11) };
}

/**
 * Converts a panorama pose quaternion into the viewer's mesh rotation angles.
 *
 * @param {number[]|Object} quaternion - Pose quaternion, [w, x, y, z] or {w,x,y,z}/{qw,...}
 * @param {Object} [options] - Options
 * @param {'z-up'|'y-up'} [options.frame='z-up'] - Source frame of the quaternion
 * @returns {{mesh_rotation_x: number, mesh_rotation_y: number, mesh_rotation_z: number}|null}
 *          Angles in degrees, or null when the quaternion is unusable
 */
export function quaternionToMeshRotation(quaternion, options = {}) {
  const q = parseQuaternion(quaternion);
  if (!q) return null;

  const frame = options.frame ?? 'z-up';
  let m = quaternionToMatrix(q);
  if (frame === 'z-up') {
    m = zUpToYUp(m);
  }

  const euler = matrixToEulerZXY(m);

  return {
    mesh_rotation_x: euler.x * RAD_TO_DEG,
    mesh_rotation_y: euler.y * RAD_TO_DEG,
    mesh_rotation_z: euler.z * RAD_TO_DEG
  };
}

/**
 * Builds a rotation matrix from Euler angles in 'ZXY' order (Rz*Rx*Ry).
 * Exposed for round-trip testing of the extraction above.
 *
 * @param {number} xDeg - Rotation about X (pitch) in degrees
 * @param {number} yDeg - Rotation about Y (yaw) in degrees
 * @param {number} zDeg - Rotation about Z (roll) in degrees
 * @returns {number[][]} Row-major 3x3 rotation matrix
 */
export function eulerZXYToMatrix(xDeg, yDeg, zDeg) {
  const { Rx, Ry, Rz } = axisMatrices(xDeg, yDeg, zDeg);
  return multiply(multiply(Rz, Rx), Ry);
}

/**
 * Builds a rotation matrix from Euler angles in 'YXZ' order (Ry*Rx*Rz).
 * Exposed for testing the YXZ -> ZXY conversion below.
 *
 * @param {number} xDeg - Rotation about X in degrees
 * @param {number} yDeg - Rotation about Y in degrees
 * @param {number} zDeg - Rotation about Z in degrees
 * @returns {number[][]} Row-major 3x3 rotation matrix
 */
export function eulerYXZToMatrix(xDeg, yDeg, zDeg) {
  const { Rx, Ry, Rz } = axisMatrices(xDeg, yDeg, zDeg);
  return multiply(multiply(Ry, Rx), Rz);
}

/**
 * The three per-axis rotation matrices for one angle triple, in radians.
 *
 * @param {number} xDeg - Rotation about X in degrees
 * @param {number} yDeg - Rotation about Y in degrees
 * @param {number} zDeg - Rotation about Z in degrees
 * @returns {{Rx: number[][], Ry: number[][], Rz: number[][]}}
 */
function axisMatrices(xDeg, yDeg, zDeg) {
  const x = xDeg / RAD_TO_DEG, y = yDeg / RAD_TO_DEG, z = zDeg / RAD_TO_DEG;
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);

  return {
    Rx: [[1, 0, 0], [0, cx, -sx], [0, sx, cx]],
    Ry: [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]],
    Rz: [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]
  };
}

/**
 * Re-expresses one angle triple from Three.js Euler order 'YXZ' into 'ZXY',
 * preserving the ROTATION ITSELF. The two orders compose the same three axis
 * matrices in different sequence (Ry*Rx*Rz against Rz*Rx*Ry), and matrix
 * multiplication does not commute, so copying the numbers across conventions
 * silently applies a different rotation.
 *
 * Where this comes from: the indoor calibration tool that produced the
 * Beira-Rio corrections builds its sphere with `rotation.order = 'YXZ'`, while
 * both viewers here use 'ZXY'. The operator tuned tilt values from -30 to 26
 * degrees against the YXZ sphere. At that magnitude the discrepancy is visible,
 * not a rounding detail.
 *
 * The route is deliberately matrix-based rather than a closed-form angle
 * formula: building the YXZ matrix and re-extracting it as ZXY reuses the same
 * `matrixToEulerZXY` the renderer's convention is defined by, so the two can
 * never drift apart.
 *
 * The Y OUTPUT IS DISCARDED BY THE CALLER when the source Y is the vendor's
 * uncalibrated constant — see migrate.js. Y is returned anyway because the
 * conversion is only meaningful for the full triple.
 *
 * @param {number} xDeg - Rotation about X in degrees, in YXZ order
 * @param {number} yDeg - Rotation about Y in degrees, in YXZ order
 * @param {number} zDeg - Rotation about Z in degrees, in YXZ order
 * @returns {{mesh_rotation_x: number, mesh_rotation_y: number, mesh_rotation_z: number}}
 *          The same rotation, expressed in ZXY order, in degrees
 */
export function eulerYXZToZXY(xDeg, yDeg, zDeg) {
  const euler = matrixToEulerZXY(eulerYXZToMatrix(xDeg, yDeg, zDeg));
  return {
    mesh_rotation_x: euler.x * RAD_TO_DEG,
    mesh_rotation_y: euler.y * RAD_TO_DEG,
    mesh_rotation_z: euler.z * RAD_TO_DEG
  };
}

/**
 * Converts a rotation matrix to a unit quaternion. Exposed for testing.
 *
 * @param {number[][]} m - Row-major 3x3 rotation matrix
 * @returns {{w: number, x: number, y: number, z: number}} Unit quaternion
 */
export function matrixToQuaternion(m) {
  const trace = m[0][0] + m[1][1] + m[2][2];

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    return {
      w: 0.25 / s,
      x: (m[2][1] - m[1][2]) * s,
      y: (m[0][2] - m[2][0]) * s,
      z: (m[1][0] - m[0][1]) * s
    };
  }

  if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = 2.0 * Math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]);
    return {
      w: (m[2][1] - m[1][2]) / s,
      x: 0.25 * s,
      y: (m[0][1] + m[1][0]) / s,
      z: (m[0][2] + m[2][0]) / s
    };
  }

  if (m[1][1] > m[2][2]) {
    const s = 2.0 * Math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]);
    return {
      w: (m[0][2] - m[2][0]) / s,
      x: (m[0][1] + m[1][0]) / s,
      y: 0.25 * s,
      z: (m[1][2] + m[2][1]) / s
    };
  }

  const s = 2.0 * Math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]);
  return {
    w: (m[1][0] - m[0][1]) / s,
    x: (m[0][2] + m[2][0]) / s,
    y: (m[1][2] + m[2][1]) / s,
    z: 0.25 * s
  };
}

/**
 * Resolves the mesh rotation angles for one photo's camera metadata.
 *
 * Precedence is deliberate and must not change: explicit angles win, so the
 * hand-calibrated archive is never overwritten; a quaternion is used only when
 * no explicit angle was given; otherwise the historical defaults apply.
 *
 * @param {Object} camera - The `camera` block of a photo's metadata JSON
 * @param {Object} [options] - Options forwarded to quaternionToMeshRotation
 * @returns {{mesh_rotation_x: number, mesh_rotation_y: number, mesh_rotation_z: number, source: string}}
 */
export function resolveMeshRotation(camera, options = {}) {
  // Antes do ramo explicito, de proposito: um lote da ferramenta indoor traz
  // mesh_rotation_y E textureRotationX/Z, e o ramo explicito sozinho leria o Y
  // e DESCARTARIA a inclinacao calibrada, sem aviso.
  const fromTexture = textureRotationToMeshRotation(camera);
  if (fromTexture) return fromTexture;

  const hasExplicit =
    camera?.mesh_rotation_y != null ||
    camera?.mesh_rotation_x != null ||
    camera?.mesh_rotation_z != null;

  if (hasExplicit) {
    return {
      mesh_rotation_y: camera.mesh_rotation_y ?? 180,
      mesh_rotation_x: camera.mesh_rotation_x ?? 0,
      mesh_rotation_z: camera.mesh_rotation_z ?? 0,
      source: 'explicit'
    };
  }

  const fromQuaternion = quaternionToMeshRotation(camera?.orientation, options);
  if (fromQuaternion) {
    return { ...fromQuaternion, source: 'quaternion' };
  }

  return { mesh_rotation_y: 180, mesh_rotation_x: 0, mesh_rotation_z: 0, source: 'default' };
}

/**
 * Yaw used when the metadata declares none.
 *
 * Both spheres are built the same way — `SphereGeometry(...).scale(-1,1,1)` —
 * so with no rotation the image centre (U=0.5) lands on -X in world space, and
 * 180 brings it to +X, where the camera looks at lon=0. That is this viewer's
 * historical default (see `applyTexture` in street_view_viewer.js).
 *
 * It is only a FALLBACK. When the metadata carries `mesh_rotation_y`, that
 * value wins — see below for why the levelling cannot decide this.
 */
const NEUTRO_Y_PADRAO = 180;

/**
 * Transposes the orientation an operator calibrated in the INDOOR tool, whose
 * metadata names the angles `textureRotationX` / `textureRotation` /
 * `textureRotationZ` and applies them with Three.js Euler order 'YXZ'.
 *
 * THE TWO ANGLE SETS IN THAT METADATA ANSWER DIFFERENT QUESTIONS, and mixing
 * them up is the whole difficulty.
 *
 * - `textureRotationX` / `textureRotationZ` are the OPERATOR'S work, in the
 *   TOOL'S convention. They level the horizon, and nothing else.
 * - `mesh_rotation_y` is the vendor's YAW, already in THIS viewer's convention.
 *   The tool never applies it — it applies `textureRotation`, which is 0 on
 *   every photo — because that field was never for the tool.
 *
 * What the operator did was rotate the sphere until the IMAGE HORIZON fell on
 * the horizontal ring of the tool's reference grid (`createGlobeGrid`, with
 * `equator.rotation.x = PI/2`). That is:
 *
 *     R_tool * n = y          (n = normal of the image horizon)
 *
 * WHICH LEAVES THE YAW UNDETERMINED. Every rotation of the form `Ry(t)*R_tool`
 * levels exactly as well, because only a spin about the vertical fixes the
 * vertical. Levelling is one constraint; yaw is a free parameter it cannot
 * touch. So the yaw HAS to come from outside, and `mesh_rotation_y` is where it
 * comes from.
 *
 * The composition is therefore
 *
 *     R_here = Ry(mesh_rotation_y) * R_tool
 *
 * with the yaw multiplying ON THE LEFT. Multiplying on the right does not
 * preserve the levelling at all: measured on the lot's own values, the horizon
 * comes out 30 degrees off for (15, 1) and 68 degrees off for (26, 23).
 *
 * The implementation is one line, because
 *
 *     Ry(b) * Ry(ty) * Rx(tx) * Rz(tz) = Ry(ty + b) * Rx(tx) * Rz(tz)
 *
 * so the base is added to the tool's own Y BEFORE the change of order.
 *
 * DO NOT EXPECT THE TILT ANGLES TO SURVIVE AS TYPED. The ZXY decomposition
 * splits the same physical rotation differently depending on the yaw: with a
 * base of 60, `(15, 1)` comes out as `x=8,31  y=60,79  z=-12,57`. The numbers
 * moving is not a bug; the horizon staying level is the invariant.
 *
 * THREE TRAPS LIVE HERE, AND ALL THREE ARE SILENT.
 *
 * 1. The tilt is not where `resolveMeshRotation` looks. That lot carries
 *    `mesh_rotation_y` but NO `mesh_rotation_x`/`_z`: the hand tuning sits only
 *    in the `textureRotation*` keys. Reading the explicit block alone imports
 *    the yaw and drops 43 distinct pitch and 43 distinct roll values as zero.
 *
 * 2. The order. That tool composes Ry*Rx*Rz; both viewers here compose
 *    Rz*Rx*Ry. Copying the numbers across applies a different rotation.
 *
 * 3. The Y that the change of order produces IS NOT AN ARTEFACT — it must be
 *    kept. Even with the tool's yaw at 0, re-expressing a pure tilt in ZXY
 *    yields a non-zero y. Dropping it as a leftover throws away part of the
 *    rotation.
 *
 * THE BASE IS TAKEN FROM THE METADATA, BUT DO NOT MISTAKE THAT FOR A
 * CALIBRATION. In the Beira-Rio lot `mesh_rotation_y` is 60 on all 350 photos,
 * and a constant cannot describe a rig that was set down facing a different way
 * at every shot. Checked on the rendered panoramas, 60 lands one photo right
 * and the next one about 220 degrees out.
 *
 * That lot simply does not carry a per-photo yaw. The one control the operator
 * could have used for it, `textureRotation`, is 0 on all 350; `initialYaw` has
 * no relation to the world (circular R of 0,137 against `heading`); `heading`
 * itself is the bearing to the next photo, not a compass reading of the image;
 * and `pro.prj` records only gravity. Reading the field is still right — a lot
 * that DOES measure the yaw will put it here — but for this one every photo
 * needs the yaw set by hand, or the tool's own output files, which record where
 * the operator saw each target in the image.
 *
 * @param {Object} camera - The `camera` block of a photo's metadata JSON
 * @returns {{mesh_rotation_x: number, mesh_rotation_y: number, mesh_rotation_z: number, source: string}|null}
 *          Angles in degrees, or null when this is not an indoor-tool photo
 */
export function textureRotationToMeshRotation(camera) {
  if (camera?.textureRotationX == null && camera?.textureRotationZ == null) {
    return null;
  }

  // A base entra no Y DA FERRAMENTA, antes da troca de ordem. E o que faz o
  // yaw multiplicar pela esquerda sem precisar montar matriz aqui.
  const base = camera.mesh_rotation_y ?? NEUTRO_Y_PADRAO;
  const r = eulerYXZToZXY(
    camera.textureRotationX ?? 0,
    (camera.textureRotation ?? 0) + base,
    camera.textureRotationZ ?? 0
  );

  return {
    mesh_rotation_x: r.mesh_rotation_x,
    mesh_rotation_y: (r.mesh_rotation_y % 360 + 360) % 360,
    mesh_rotation_z: r.mesh_rotation_z,
    source: 'texture-rotation'
  };
}

/**
 * Derives the image heading (azimuth the panorama centre points at) from a pose
 * quaternion, for metadata that carries a pose but no heading. The museum
 * archive, for instance, has heading NULL on every photo.
 *
 * @param {number[]|Object} quaternion - Pose quaternion
 * @param {Object} [options] - Options forwarded to quaternionToMeshRotation
 * @returns {number|null} Heading in degrees [0, 360), or null when unusable
 */
export function quaternionToHeading(quaternion, options = {}) {
  const rotation = quaternionToMeshRotation(quaternion, options);
  if (!rotation) return null;
  return ((rotation.mesh_rotation_y % 360) + 360) % 360;
}
