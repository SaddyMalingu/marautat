const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const sourceArg = process.argv[2] || 'ABOSS_CONTACT_CAPTURE_EDITABLE.xlsx';
const sourcePath = path.isAbsolute(sourceArg) ? sourceArg : path.join(ROOT, sourceArg);
const targetCsv = path.join(ROOT, 'ABOSS_CONTACT_CAPTURE_TEMPLATE.updated.csv');

if (!fs.existsSync(sourcePath)) {
  console.error(`Workbook not found: ${sourcePath}`);
  process.exit(1);
}

const wb = XLSX.readFile(sourcePath, { raw: false, cellDates: false });
const sheetName = wb.Sheets.contacts_editable ? 'contacts_editable' : wb.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });

if (!rows.length) {
  console.error('No rows found in workbook.');
  process.exit(1);
}

const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows));
fs.writeFileSync(targetCsv, csv, 'utf8');

console.log(`Extracted ${rows.length} rows from sheet: ${sheetName}`);
console.log(`Wrote: ${path.basename(targetCsv)}`);
