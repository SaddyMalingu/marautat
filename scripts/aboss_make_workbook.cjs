const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = process.cwd();
const SOURCE_CSV = path.join(ROOT, 'ABOSS_CONTACT_CAPTURE_TEMPLATE.csv');
const TARGET_XLSX = path.join(ROOT, 'ABOSS_CONTACT_CAPTURE_EDITABLE.xlsx');

if (!fs.existsSync(SOURCE_CSV)) {
  console.error(`Source CSV not found: ${SOURCE_CSV}`);
  process.exit(1);
}

const csvWb = XLSX.readFile(SOURCE_CSV, { raw: false, cellDates: false });
const sheetName = csvWb.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(csvWb.Sheets[sheetName], { defval: '' });

const editableSheet = XLSX.utils.json_to_sheet(rows);
editableSheet['!cols'] = [
  { wch: 30 }, // organization
  { wch: 40 }, // website
  { wch: 24 }, // contact_name
  { wch: 18 }, // role
  { wch: 32 }, // email
  { wch: 18 }, // phone
  { wch: 40 }, // source_url
  { wch: 20 }, // industry
  { wch: 38 }, // intent_signal
  { wch: 14 }, // priority_score
  { wch: 16 }, // channel_primary
  { wch: 14 }, // status
  { wch: 58 }, // next_action
  { wch: 36 }  // notes
];

const helpRows = [
  { field: 'organization', how_to_edit: 'Keep stable. Used as row identity.' },
  { field: 'contact_name', how_to_edit: 'Fill decision-maker name when found.' },
  { field: 'role', how_to_edit: 'Use title if known (e.g., Marketing Manager).' },
  { field: 'email', how_to_edit: 'Primary outreach email.' },
  { field: 'phone', how_to_edit: 'Use international format if possible.' },
  { field: 'status', how_to_edit: 'Use: new, contacted, replied, meeting_booked, won, lost.' },
  { field: 'next_action', how_to_edit: 'Single clear next step.' },
  { field: 'notes', how_to_edit: 'Short context only.' },
  { field: 'share_back', how_to_edit: 'Send this .xlsx or export sheet to CSV and share file only.' }
];
const helpSheet = XLSX.utils.json_to_sheet(helpRows);
helpSheet['!cols'] = [{ wch: 24 }, { wch: 72 }];

const outWb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(outWb, editableSheet, 'contacts_editable');
XLSX.utils.book_append_sheet(outWb, helpSheet, 'how_to_edit');
XLSX.writeFile(outWb, TARGET_XLSX);

console.log(`Created editable workbook: ${path.basename(TARGET_XLSX)}`);
console.log('Sheet to edit: contacts_editable');
