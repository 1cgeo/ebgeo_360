/**
 * @module scripts/lib/floors
 * @description Translates the survey's floor label into the ordered level the
 * viewer stacks, and back into the label the interface prints.
 *
 * The source of truth is the `locate` string the field team writes per photo
 * (`fotos.geojson` calls the same thing `local`, `planta.geojson` calls it
 * `andar`; the three vocabularies are identical, verified across 350 photos,
 * 161 lines and 189 plan features of the Beira-Rio lot).
 *
 * WHY A CLOSED VOCABULARY, and why an unknown value throws: the alternative is
 * to default an unrecognised place to ground level, which puts a photo on the
 * wrong floor without a single line of output. A floor mix-up is invisible in
 * every aggregate — the counts still add up, the map still draws — and only
 * shows as a viewer that walks through a ceiling. Failing the import is the
 * cheap way to find out.
 *
 * Level 0 is the ground: everything outdoors, and every indoor space at grade.
 * Levels rise from 1. Negative levels are accepted for basements but no lot has
 * one yet.
 */

/**
 * Ground-level places, keyed by the exact `locate` string, lowercased and
 * trimmed. The value is the label the interface shows.
 *
 * `campo de futebol` and `área externa` are BOTH level 0 and both connect to
 * `andar 1` in the delivered graph: one is the pitch inside the bowl, the other
 * the apron outside it. They share a level because they share a floor; the
 * label is what tells them apart on screen.
 */
const GROUND_LABELS = new Map([
  ['área externa', 'Externo'],
  ['area externa', 'Externo'],
  ['externo', 'Externo'],
  ['campo de futebol', 'Campo'],
  ['pátio', 'Pátio'],
  ['patio', 'Pátio'],
  ['térreo', 'Térreo'],
  ['terreo', 'Térreo'],
]);

/** Matches `andar 1`, `andar 12`, with any inner spacing. */
const FLOOR_RE = /^andar\s+(\d+)$/;

/**
 * Translates one `locate` value into a level and a label.
 *
 * @param {string} locate - The raw `locate`/`local`/`andar` string
 * @returns {{level: number, label: string}} The ordered level and its label
 * @throws {Error} When the value is not in the known vocabulary
 */
export function parseFloor(locate) {
  if (typeof locate !== 'string' || locate.trim() === '') {
    throw new Error('floor: empty locate');
  }

  const key = locate.trim().toLowerCase();

  const ground = GROUND_LABELS.get(key);
  if (ground) return { level: 0, label: ground };

  const m = FLOOR_RE.exec(key);
  if (m) {
    const level = Number.parseInt(m[1], 10);
    return { level, label: `${level}º andar` };
  }

  throw new Error(
    `floor: unknown locate "${locate}". ` +
    'Extend GROUND_LABELS in scripts/lib/floors.js rather than guessing a level.'
  );
}

/**
 * The label for a level whose own `locate` string is not at hand, used when
 * building the floor list from photos that already carry a level.
 *
 * @param {number} level - The ordered level
 * @returns {string} A printable label
 */
export function defaultFloorLabel(level) {
  if (level === 0) return 'Térreo';
  if (level < 0) return `${-level}º subsolo`;
  return `${level}º andar`;
}
