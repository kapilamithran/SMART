// Exports. includeImages=true  → JSON/PDF embed the saved scan image; CSV ships as a ZIP with
// images/ and a HYPERLINK cell per image at the end of each row. includeImages=false → no images at all.
import { PART_A, PART_B } from './template.js';

const BASE = new URL('../', import.meta.url).href;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
const safe = s => String(s).replace(/[^\w.-]+/g, '_');

export function recordRow(r) {
  const F = r.fields, v = k => (F[k].value ?? '');
  const S = r.summary || {};
  const excluded = PART_B.filter(k => F[k].excluded).join(' ');
  const flags = Object.keys(F).flatMap(k => (F[k].flags || []).filter(f => f.level === 'red').map(f => `${k}: ${f.msg}`));
  const edited = Object.keys(F).filter(k => F[k].edited).map(k => `${k}: ${r.ocrSnapshot?.[k]?.raw ?? ''}→${F[k].text}`);
  return {
    register: S.register, ...Object.fromEntries(PART_A.map(k => [k, v(k)])), ...Object.fromEntries(PART_B.map(k => [k, v(k)])),
    excluded_alternatives: excluded,
    partA_calculated: S.calcA, partA_written: v('totalA'),
    partB_calculated: S.calcB, partB_written: v('totalB'),
    total_calculated: S.calcTotal, grand_total: v('grand'), co_total: v('coTotal'),
    grand_read: r.ocrSnapshot?.grand?.raw ?? '', co_read: r.ocrSnapshot?.coTotal?.raw ?? '',
    totals_rule: r.audit?.totalsRule ? `filled ${r.audit.totalsRule.expected} (${r.audit.totalsRule.matched} = A+B)` : '',
    red_flags: flags.length, flag_details: flags.join(' | '), reviewer_edits: edited.join(' | '),
    saved_at: r.savedAt || r.createdAt,
  };
}

function csvCell(x) { const s = String(x ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

export async function exportJSON(batch, records, images, includeImages) {
  const out = { app: 'SMART — Scan, Mark, Audit, Review & Total', batch: { name: batch.name, id: batch.id, finishedAt: batch.finishedAt },
    exportedAt: new Date().toISOString(), includeImages, recordCount: records.length, records: [] };
  for (const r of records) {
    const rec = { ...recordRow(r), audit: { ocr: r.ocrSnapshot, totalsRule: r.audit?.totalsRule || null, fields: Object.fromEntries(Object.entries(r.fields).map(([k, f]) => [k, { text: f.text, value: f.value ?? null, edited: !!f.edited, flags: f.flags }])) } };
    if (includeImages) {
      const img = images.get(r.id);
      rec.image = img ? { mime: img.type || 'image/jpeg', base64: await blobToB64(img) } : null;
      if (!img) rec.image_note = 'No saved image for this record (saved before image saving was on, or image saving was switched off).';
    }
    out.records.push(rec);
  }
  return new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' });
}

export async function exportCSV(batch, records, images, includeImages) {
  const rows = records.map(recordRow), cols = Object.keys(rows[0] || recordRow({ fields: Object.fromEntries([...PART_A, ...PART_B, 'totalA', 'totalB', 'grand', 'coTotal'].map(k => [k, {}])) }));
  const header = [...cols]; if (includeImages) header.push('image');
  const lines = [header.join(',')];
  const zipFiles = [];
  records.forEach((r, i) => {
    const cells = cols.map(c => csvCell(rows[i][c]));
    if (includeImages) {
      const img = images.get(r.id);
      if (img) {
        const name = `images/${safe(rows[i].register || 'unknown')}_${r.id.slice(0, 8)}.jpg`;
        zipFiles.push([name, img]);
        cells.push(csvCell(`=HYPERLINK("${name}","${name.slice(7)}")`));
      } else cells.push('no saved image');
    }
    lines.push(cells.join(','));
  });
  const csv = '\ufeff' + lines.join('\r\n');
  if (!includeImages) return { blob: new Blob([csv], { type: 'text/csv' }), ext: 'csv' };
  if (!globalThis.JSZip) await loadScript(BASE + 'vendor/jszip/jszip.min.js');
  const zip = new JSZip();
  zip.file(`${safe(batch.name)}.csv`, csv);
  zip.file('README.txt', 'Extract this ZIP, then open the CSV. The last column links to each row\'s scan image in the images/ folder.\nRows showing "no saved image" were saved without an image and cannot supply one.');
  for (const [n, b] of zipFiles) zip.file(n, b);
  return { blob: await zip.generateAsync({ type: 'blob' }), ext: 'zip' };
}

export async function exportPDF(batch, records, images, includeImages) {
  if (!globalThis.jspdf) await loadScript(BASE + 'vendor/jspdf/jspdf.umd.min.js');
  const doc = new jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = 297, M = 8;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13);
  doc.text(`Batch: ${batch.name}`, M, 12);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
  doc.text(`${records.length} records · exported ${new Date().toLocaleString()} · images ${includeImages ? 'included' : 'not included'}`, M, 17);
  const cols = ['Register', ...PART_A.map(k => k.slice(1)), ...PART_B, 'A calc', 'A wr', 'B calc', 'B wr', 'Grand', 'CO', 'Flags'];
  const widths = [26, ...PART_A.map(() => 6.2), ...PART_B.map(() => 7.4), 10, 10, 10, 10, 11, 10, 14];
  let y = 24;
  const head = () => { doc.setFillColor(30, 33, 38); doc.setTextColor(255); doc.rect(M, y - 4, W - 2 * M, 6, 'F'); let x = M + 1; cols.forEach((c, i) => { doc.text(String(c), x, y); x += widths[i]; }); doc.setTextColor(0); y += 6; };
  head();
  for (const r of records) {
    if (y > 200) { doc.addPage(); y = 14; head(); }
    const row = recordRow(r), F = r.fields;
    const vals = [row.register, ...PART_A.map(k => row[k]), ...PART_B.map(k => F[k].excluded ? `(${row[k]})` : row[k]), row.partA_calculated, row.partA_written, row.partB_calculated, row.partB_written, row.grand_total, row.co_total, row.red_flags];
    let x = M + 1;
    vals.forEach((v, i) => {
      const k = i >= 1 && i <= 20 ? [...PART_A, ...PART_B][i - 1] : null;
      if (k && (F[k].flags || []).some(f => f.level === 'red')) { doc.setDrawColor(220, 20, 30); doc.rect(x - 0.8, y - 3.6, widths[i] - 0.6, 4.8); }
      doc.text(String(v ?? ''), x, y); x += widths[i];
    });
    doc.setDrawColor(210); doc.line(M, y + 1.6, W - M, y + 1.6); y += 5.6;
  }
  doc.setFontSize(7); doc.text('( ) = excluded alternative (both a and b answered). Red boxes = flagged fields.', M, Math.min(y + 4, 205));
  // per-record pages
  const noImg = [];
  for (const r of records) {
    doc.addPage(); const row = recordRow(r);
    doc.setFontSize(12); doc.setFont('helvetica', 'bold'); doc.text(`Register ${row.register}`, M, 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8);
    const lines = [`Part A: calculated ${row.partA_calculated}, written ${row.partA_written}   Part B: calculated ${row.partB_calculated}, written ${row.partB_written}`,
      `Grand total ${row.grand_total} (read "${row.grand_read}")   CO total ${row.co_total} (read "${row.co_read}")   ${row.totals_rule}`,
      row.flag_details ? `Flags: ${row.flag_details}` : 'No red flags', row.reviewer_edits ? `Reviewer edits: ${row.reviewer_edits}` : ''];
    const wrapped = doc.splitTextToSize(lines.filter(Boolean).join('\n'), W - 2 * M); doc.text(wrapped, M, 18);
    const top = 20 + wrapped.length * 3.4;
    if (includeImages) {
      const img = images.get(r.id);
      if (img) {
        const url = await blobToDataURL(img), dim = await imgSize(url);
        const maxW = W - 2 * M, maxH = 205 - top, s = Math.min(maxW / dim.w, maxH / dim.h);
        doc.addImage(url, 'JPEG', M, top, dim.w * s, dim.h * s);
      } else { noImg.push(row.register); doc.text('No saved image for this record — older records saved without images cannot supply one.', M, top + 4); }
    }
  }
  return new Blob([doc.output('arraybuffer')], { type: 'application/pdf' });
}

export function download(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
function blobToDataURL(b) { return new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); }); }
async function blobToB64(b) { return (await blobToDataURL(b)).split(',')[1]; }
function imgSize(url) { return new Promise(r => { const i = new Image(); i.onload = () => r({ w: i.naturalWidth, h: i.naturalHeight }); i.src = url; }); }
