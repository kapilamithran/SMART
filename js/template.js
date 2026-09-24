// Layout template for the Rajalakshmi Engineering College CAT answer-booklet cover.
// Canonical units: the Part A / Part B marks table is 1200 x 320 units (its outer border).
// All other regions are expressed in the same plane and refined locally at run time.
export const TEMPLATE = {
  name: 'REC-CAT-cover-v1',
  table: { w: 1200, h: 320 },
  // measured column lines: [Part label | QNo/Marks label | 1..10 | Total]
  colLines: [3, 90, 165, 259, 352, 444, 537, 628, 720, 811, 903, 996, 1089, 1197],
  // row lines: top | QNo A | Marks A | QNo B | Marks B
  rowLines: [9, 75, 166, 234, 318],
  register: { win: [1230, -830, 2150, -450], cells: 13, prefix: '2116', aspect: [4.5, 10] },
  co:       { win: [1160, -100, 2140, 300], aspect: [2.2, 4.8] },
  grand:    { win: [790, 300, 1260, 480], aspect: [2.4, 5.4] },
  // fallbacks measured on the reference photo, used only if local refinement fails
  fallback: {
    register: [1318, -700, 2030, -580],
    coTotal:  [1860, 132, 2060, 232],
    grand:    [858, 342, 1194, 424],
  },
  // area that must be inside the camera frame before a capture is allowed
  mustSee: [-20, -720, 2070, 440],
};

export const PART_A = Array.from({ length: 10 }, (_, i) => `Q${i + 1}`);
export const PART_B = [];
for (let q = 11; q <= 15; q++) PART_B.push(`${q}a`, `${q}b`);
export const TOTAL_FIELDS = ['totalA', 'totalB', 'grand', 'coTotal'];
export const FIELD_LABEL = {
  totalA: 'Part A total', totalB: 'Part B total',
  grand: 'Grand total', coTotal: 'CO Total',
};
