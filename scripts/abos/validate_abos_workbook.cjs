#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function parseArgs(argv) {
  const args = {
    files: [],
    mapping: path.join(process.cwd(), 'scripts', 'abos', 'abos_sheet_mapping.json'),
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--file' && next) {
      args.files.push(next);
      i += 1;
    } else if (arg === '--mapping' && next) {
      args.mapping = next;
      i += 1;
    }
  }
  return args;
}

function isMeaningfulValue(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).trim();
  if (!s) return false;
  const lower = s.toLowerCase();
  if (['n/a', 'na', 'none', 'null', '-', '--'].includes(lower)) return false;
  return true;
}

function sheetStats(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false, blankrows: false });
  if (!rows.length) {
    return {
      rowCount: 0,
      meaningfulRows: 0,
      ratio: 0,
    };
  }

  let meaningfulRows = 0;
  for (const row of rows) {
    const values = Object.values(row);
    const meaningful = values.filter(isMeaningfulValue);
    if (meaningful.length >= 2) meaningfulRows += 1;
  }

  const ratio = meaningfulRows / rows.length;
  return {
    rowCount: rows.length,
    meaningfulRows,
    ratio: Math.round(ratio * 1000) / 1000,
  };
}

function levelForRatio(ratio, rowCount) {
  if (rowCount === 0) return 'critical';
  if (ratio >= 0.65) return 'healthy';
  if (ratio >= 0.25) return 'warning';
  return 'critical';
}

function runValidation(filePath, mapping) {
  const abs = path.resolve(filePath);
  const workbookName = path.basename(abs);
  const wb = XLSX.readFile(abs, { cellDates: false });

  const workbookMap = mapping.workbookMappings[workbookName] || {};
  const mappedSheets = Object.keys(workbookMap);

  const reportSheets = [];
  let criticalCount = 0;
  let warningCount = 0;
  let healthyCount = 0;

  for (const sheetName of mappedSheets) {
    if (!wb.SheetNames.includes(sheetName)) {
      reportSheets.push({
        sheet: sheetName,
        status: 'critical',
        reason: 'Mapped sheet missing in workbook',
        rowCount: 0,
        meaningfulRows: 0,
        ratio: 0,
      });
      criticalCount += 1;
      continue;
    }

    const stats = sheetStats(wb.Sheets[sheetName]);
    const status = levelForRatio(stats.ratio, stats.rowCount);
    if (status === 'critical') criticalCount += 1;
    if (status === 'warning') warningCount += 1;
    if (status === 'healthy') healthyCount += 1;

    reportSheets.push({
      sheet: sheetName,
      status,
      rowCount: stats.rowCount,
      meaningfulRows: stats.meaningfulRows,
      ratio: stats.ratio,
      reason: status === 'healthy'
        ? 'Data quality acceptable'
        : status === 'warning'
          ? 'Sheet has sparse data; improve row completeness'
          : 'Sheet mostly template/header rows; enter operational values',
    });
  }

  const overall = criticalCount > 0 ? 'critical' : warningCount > 0 ? 'warning' : 'healthy';
  return {
    workbook: workbookName,
    mappedSheets: mappedSheets.length,
    summary: {
      status: overall,
      healthy: healthyCount,
      warning: warningCount,
      critical: criticalCount,
    },
    sheets: reportSheets,
    policy: {
      healthy_ratio: '>= 0.65',
      warning_ratio: '>= 0.25 and < 0.65',
      critical_ratio: '< 0.25 or no rows',
    },
  };
}

function printReport(report) {
  console.log(`\nABOS Validation :: ${report.workbook}`);
  console.log(`Status: ${report.summary.status.toUpperCase()} | Sheets mapped: ${report.mappedSheets}`);
  console.log(`Healthy: ${report.summary.healthy} | Warning: ${report.summary.warning} | Critical: ${report.summary.critical}`);
  console.log('---');
  for (const row of report.sheets) {
    console.log(`${row.sheet} -> ${row.status.toUpperCase()} | rows=${row.rowCount} meaningful=${row.meaningfulRows} ratio=${row.ratio} | ${row.reason}`);
  }
  console.log('---');
  if (report.summary.status !== 'healthy') {
    console.log('Discipline actions:');
    console.log('1. Fill at least one descriptive field and one numeric field on each active sheet row.');
    console.log('2. Remove placeholder rows before import.');
    console.log('3. Re-run: npm run abos:validate -- --file <workbook.xlsx>');
  }
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.files.length) {
    throw new Error('Provide at least one --file <path-to-xlsx>');
  }

  const mapping = JSON.parse(fs.readFileSync(args.mapping, 'utf8'));
  let hasCritical = false;

  for (const filePath of args.files) {
    const report = runValidation(filePath, mapping);
    printReport(report);
    if (report.summary.status === 'critical') hasCritical = true;
  }

  if (hasCritical) {
    process.exitCode = 2;
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
