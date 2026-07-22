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
  const x = xDeg / RAD_TO_DEG, y = yDeg / RAD_TO_DEG, z = zDeg / RAD_TO_DEG;
  const cx = Math.cos(x), sx = Math.sin(x);
  const cy = Math.cos(y), sy = Math.sin(y);
  const cz = Math.cos(z), sz = Math.sin(z);

  const Rx = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]];
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rz = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]];

  return multiply(multiply(Rz, Rx), Ry);
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
