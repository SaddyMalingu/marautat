#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { createClient } = require('@supabase/supabase-js');

function parseArgs(argv) {
  const out = {
    files: [],
    mapping: path.join(process.cwd(), 'scripts', 'abos', 'abos_sheet_mapping.json'),
    importedBy: process.env.USER || 'abos-importer',
    dryRun: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--file' && next) {
      out.files.push(next);
      i += 1;
    } else if (arg === '--mapping' && next) {
      out.mapping = next;
      i += 1;
    } else if (arg === '--imported-by' && next) {
      out.importedBy = next;
      i += 1;
    } else if (arg === '--dry-run') {
      out.dryRun = true;
    }
  }

  return out;
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return process.env[name];
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

function toDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function normalizeRows(sheet) {
  return XLSX.utils.sheet_to_json(sheet, {
    defval: null,
    raw: false,
    blankrows: false,
  });
}

function normalizeRowsAoA(sheet) {
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false,
  });
}

function firstNonEmpty(value) {
  return String(value || '').trim();
}

function cleanMoney(value) {
  const n = toNumber(value);
  return n === null ? 0 : n;
}

function extractTrailRecords(rowsAoA, workbookName, sheetName, tenantPhone) {
  const records = [];
  let totalMoneyIn = null;
  let totalMoneyOut = null;
  let netProfit = null;
  const priorityGoals = [];

  for (const row of rowsAoA) {
    const timeSlot = firstNonEmpty(row[0]);
    const energy = firstNonEmpty(row[1]);
    const category = firstNonEmpty(row[2]);
    const resourceUsed = firstNonEmpty(row[3]);
    const output = firstNonEmpty(row[4]);
    const moneyIn = toNumber(row[5]);
    const moneyOut = toNumber(row[6]);
    const marker = firstNonEmpty(row[7]).toLowerCase();
    const goalText = firstNonEmpty(row[8]);
    const goalCategory = firstNonEmpty(row[9]);

    if (/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/.test(timeSlot)) {
      const outputText = [energy, output].filter(Boolean).join(' | ') || energy || output || 'Founder activity block';
      const moneyInVal = moneyIn === null ? 0 : moneyIn;
      const moneyOutVal = moneyOut === null ? 0 : moneyOut;
      records.push({
        source_workbook: workbookName,
        source_sheet: sheetName,
        activity_slot: timeSlot,
        activity_name: energy || 'Founder block',
        activity_category: category || goalCategory || 'general',
        resource_used: resourceUsed || null,
        output_text: outputText,
        money_in_kes: moneyInVal,
        money_out_kes: moneyOutVal,
        net_kes: moneyInVal - moneyOutVal,
        priority_goal: goalText || null,
        alignment_group: goalCategory || category || null,
        tenant_phone: tenantPhone,
        metadata: { raw_row: row },
      });
    }

    if (marker.includes('total money in') && toNumber(row[7]) !== null) {
      totalMoneyIn = toNumber(row[7]);
    }
    if (marker.includes('total money out') && toNumber(row[7]) !== null) {
      totalMoneyOut = toNumber(row[7]);
    }
    if (marker.includes('net profit') && toNumber(row[7]) !== null) {
      netProfit = toNumber(row[7]);
    }

    if (goalText) {
      priorityGoals.push({ goal: goalText, category: goalCategory || null });
    }
  }

  return {
    activities: records,
    kpis: [
      {
        source_workbook: workbookName,
        source_sheet: sheetName,
        metric_name: 'founder_total_money_in_kes',
        metric_value: totalMoneyIn,
        metric_unit: 'KES',
        period_label: sheetName,
        tenant_phone: tenantPhone,
        metadata: { priority_goals: priorityGoals.slice(0, 12) },
      },
      {
        source_workbook: workbookName,
        source_sheet: sheetName,
        metric_name: 'founder_total_money_out_kes',
        metric_value: totalMoneyOut,
        metric_unit: 'KES',
        period_label: sheetName,
        tenant_phone: tenantPhone,
        metadata: { priority_goals: priorityGoals.slice(0, 12) },
      },
      {
        source_workbook: workbookName,
        source_sheet: sheetName,
        metric_name: 'founder_net_profit_kes',
        metric_value: netProfit,
        metric_unit: 'KES',
        period_label: sheetName,
        tenant_phone: tenantPhone,
        metadata: { priority_goals: priorityGoals.slice(0, 12) },
      },
    ].filter((item) => item.metric_value !== null),
  };
}

function buildRecords(rows, mode, workbookName, sheetName, tenantPhone, statementType) {
  if (mode === 'kpi') {
    const dashboardKpiPatterns = [
      'KPI',
      'Metric',
      'Total Prospects',
      'Qualified Leads',
      'Pipeline Value',
      'Proposal Count',
      'Revenue',
      'Partner Revenue',
      'Runway (Months)',
      'Forecast Revenue',
      'Outstanding Receivables',
    ];

    const records = rows
      .map((row) => {
        const rowMetricName =
          row.Metric ||
          row.KPI ||
          row.Objective ||
          row['Key Result'] ||
          row.Month ||
          row.Product ||
          row.Department ||
          row.Period ||
          row.Agent ||
          row.Partner ||
          row.Country ||
          null;

        const rowMetricValue =
          row.Value ||
          row.Current ||
          row['Progress %'] ||
          row.Target ||
          row.ARR ||
          row.MRR ||
          row.Balance ||
          row.Variance ||
          row['Runway Months'] ||
          row.Impact ||
          null;

        if (!rowMetricName && !rowMetricValue) return null;

        if (dashboardKpiPatterns.includes(String(rowMetricName).trim()) && (rowMetricValue === null || rowMetricValue === '')) {
          return null;
        }

        const entries = Object.entries(row).filter(([k, v]) => k && v !== null && v !== '');
        if (entries.length < 2) return null;
        const metricName = rowMetricName || entries[0][0];
        const metricValue = rowMetricValue !== null && rowMetricValue !== '' ? rowMetricValue : entries[0][1];
        return {
          source_workbook: workbookName,
          source_sheet: sheetName,
          metric_name: String(metricName).trim(),
          metric_value: toNumber(metricValue),
          metric_unit: String(metricName).toLowerCase().includes('%') ? 'percent' : null,
          period_label: row.Quarter || row.Month || row.Period || null,
          tenant_phone: tenantPhone,
          metadata: { raw_row: row },
        };
      })
      .filter((item) => item && (item.metric_value !== null || item.metric_name));

    return records;
  }

  if (mode === 'pipeline') {
    return rows
      .map((row) => ({
      source_workbook: workbookName,
      source_sheet: sheetName,
      external_id: row.ID || row.Id || row.id || row['Lead ID'] || row['Opportunity ID'] || null,
      lead_name: row['Lead Name'] || row.Lead || row.Name || row.Contact || row['Contact Person'] || null,
      company_name: row.Company || row.Organization || row.Customer || row.Client || row['Organization Name'] || null,
      owner_name: row.Owner || row['Sales Owner'] || null,
      stage: row.Stage || row.Status || null,
      status: row.Status || null,
      amount: toNumber(
        row.Amount ||
        row.Value ||
        row['Deal Value'] ||
        row['Estimated Value'] ||
        row['Opportunity Value'] ||
        row['Forecast Revenue'] ||
        row['Quote Value'] ||
        row['Contract Value'] ||
        row['Invoice Amount'] ||
        row['Outstanding Amount'] ||
        null
      ),
      currency: row.Currency || 'KES',
      close_date: toDate(row['Close Date'] || row['Expected Close'] || row['Expected Close Date'] || row['Due Date'] || null),
      tenant_phone: tenantPhone,
      metadata: { raw_row: row },
      }))
      .filter((row) => row.external_id || row.company_name || row.lead_name || row.amount !== null);
  }

  if (mode === 'financial') {
    return rows
      .map((row) => {
        const accountName =
          row.Account ||
          row['Line Item'] ||
          row.Metric ||
          row.Category ||
          row.Name ||
          row.Month ||
          row.Customer ||
          row['Invoice No'] ||
          null;

        const amount = toNumber(
          row.Amount ||
          row.Value ||
          row.Total ||
          row.Revenue ||
          row.Profit ||
          row['Net Cash Flow'] ||
          row['Projected Revenue'] ||
          row['Actual Revenue'] ||
          row['Outstanding Amount'] ||
          null
        );
        if (!accountName && amount === null) return null;
        return {
          source_workbook: workbookName,
          source_sheet: sheetName,
          statement_type: statementType || 'financial',
          account_name: accountName || 'Unlabeled',
          amount,
          currency: row.Currency || 'KES',
          period_label: row.Period || row.Month || row.Quarter || row.Year || null,
          tenant_phone: tenantPhone,
          metadata: { raw_row: row },
        };
      })
      .filter(Boolean);
  }

  if (mode === 'risk') {
    return rows
      .map((row) => {
        const riskTitle = row['Risk Title'] || row.Risk || row.Description || null;
        if (!riskTitle) return null;
        return {
          source_workbook: workbookName,
          source_sheet: sheetName,
          risk_id: row['Risk ID'] || row.ID || null,
          risk_title: riskTitle,
          risk_level: row.Level || row['Risk Level'] || null,
          impact: row.Impact || null,
          probability: row.Probability || null,
          mitigation: row.Mitigation || row.Action || null,
          owner_name: row.Owner || null,
          status: row.Status || null,
          due_date: toDate(row['Due Date'] || null),
          tenant_phone: tenantPhone,
          metadata: { raw_row: row },
        };
      })
      .filter(Boolean);
  }

  if (mode === 'founder_trail') {
    const rowsAoA = Array.isArray(rows) ? rows : [];
    return extractTrailRecords(rowsAoA, workbookName, sheetName, tenantPhone);
  }

  return [];
}

async function insertInChunks(supabase, table, rows, ingestionId, dryRun) {
  if (!rows.length) return { inserted: 0, failed: 0 };
  if (dryRun) return { inserted: rows.length, failed: 0 };

  let inserted = 0;
  let failed = 0;
  const chunkSize = 250;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize).map((r) => ({ ...r, ingestion_id: ingestionId }));
    const { error } = await supabase.from(table).insert(chunk);
    if (error) {
      failed += chunk.length;
      console.error(`Insert failed for ${table}: ${error.message}`);
    } else {
      inserted += chunk.length;
    }
  }
  return { inserted, failed };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.files.length) {
    throw new Error('Provide at least one --file <path-to-xlsx>');
  }

  const mapping = JSON.parse(fs.readFileSync(args.mapping, 'utf8'));
  const supabase = args.dryRun
    ? null
    : createClient(requireEnv('SB_URL'), requireEnv('SB_SERVICE_ROLE_KEY'));

  for (const filePath of args.files) {
    const abs = path.resolve(filePath);
    const workbookName = path.basename(abs);
    const map = mapping.workbookMappings[workbookName];
    if (!map) {
      console.log(`Skipping ${workbookName}: no mapping configured.`);
      continue;
    }

    const wb = XLSX.readFile(abs, { cellDates: false });

    const ingestionPayload = {
      workbook_name: workbookName,
      workbook_path: abs,
      workbook_version: mapping.version,
      imported_by: args.importedBy,
      status: args.dryRun ? 'dry_run' : 'completed',
      rows_processed: 0,
      rows_failed: 0,
      metadata: {
        sheets: wb.SheetNames,
      },
    };

    let ingestionId = null;
    if (!args.dryRun) {
      const { data, error } = await supabase
        .from('abos_workbook_ingestions')
        .insert(ingestionPayload)
        .select('id')
        .single();
      if (error) throw new Error(`Failed ingestion record for ${workbookName}: ${error.message}`);
      ingestionId = data.id;
    }

    let processed = 0;
    let failed = 0;

    for (const sheetName of Object.keys(map)) {
      if (!wb.SheetNames.includes(sheetName)) continue;
      const conf = map[sheetName];
      if (conf.mode === 'founder_trail') {
        const rowsAoA = normalizeRowsAoA(wb.Sheets[sheetName]);
        const bundle = buildRecords(
          rowsAoA,
          conf.mode,
          workbookName,
          sheetName,
          mapping.defaultTenantPhone,
          conf.statementType
        );

        const trailTable = conf.target.replace('alphadome.', '');
        const trailResult = await insertInChunks(supabase, trailTable, bundle.activities || [], ingestionId, args.dryRun);
        processed += trailResult.inserted;
        failed += trailResult.failed;

        const kpiResult = await insertInChunks(supabase, 'abos_kpi_snapshots', bundle.kpis || [], ingestionId, args.dryRun);
        processed += kpiResult.inserted;
        failed += kpiResult.failed;

        console.log(`${workbookName} :: ${sheetName} -> ${trailTable} inserted=${trailResult.inserted} failed=${trailResult.failed}`);
        console.log(`${workbookName} :: ${sheetName} -> abos_kpi_snapshots inserted=${kpiResult.inserted} failed=${kpiResult.failed}`);
      } else {
        const rows = normalizeRows(wb.Sheets[sheetName]);
        const records = buildRecords(
          rows,
          conf.mode,
          workbookName,
          sheetName,
          mapping.defaultTenantPhone,
          conf.statementType
        );

        const tableName = conf.target.replace('alphadome.', '');
        const result = await insertInChunks(supabase, tableName, records, ingestionId, args.dryRun);
        processed += result.inserted;
        failed += result.failed;

        console.log(`${workbookName} :: ${sheetName} -> ${tableName} inserted=${result.inserted} failed=${result.failed}`);
      }
    }

    if (!args.dryRun && ingestionId) {
      await supabase
        .from('abos_workbook_ingestions')
        .update({ rows_processed: processed, rows_failed: failed })
        .eq('id', ingestionId);
    }

    console.log(`Completed ${workbookName}: processed=${processed}, failed=${failed}, dryRun=${args.dryRun}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
