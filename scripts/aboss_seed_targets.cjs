#!/usr/bin/env node

const fs = require('fs');

const OUT_FILE = process.argv[2] || 'ABOSS_CONTACT_CAPTURE_TEMPLATE.csv';

const targets = [
  ['Naivas Supermarket','https://naivas.online','retail'],
  ['Quickmart','https://quickmart.co.ke','retail'],
  ['Carrefour Kenya','https://www.carrefour.ke','retail'],
  ['Chandarana Foodplus','https://chandaranafoodplus.co.ke','retail'],
  ['Copia Kenya','https://copia.co.ke','retail'],
  ['Jumia Kenya','https://www.jumia.co.ke','retail'],
  ['Kilimall Kenya','https://www.kilimall.co.ke','retail'],
  ['Goodlife Pharmacy','https://goodlife.co.ke','retail'],
  ['Text Book Centre','https://www.textbookcentre.com','retail'],
  ['Hotpoint Appliances','https://hotpoint.co.ke','retail'],

  ['Sarova Hotels','https://www.sarovahotels.com','hospitality'],
  ['Serena Hotels Kenya','https://www.serenahotels.com','hospitality'],
  ['Villa Rosa Kempinski Nairobi','https://www.kempinski.com/en/hotel-villa-rosa','hospitality'],
  ['Tribe Hotel Nairobi','https://www.tribehotel-kenya.com','hospitality'],
  ['Fairmont The Norfolk','https://www.fairmont.com/norfolk-hotel-nairobi','hospitality'],
  ['Eka Hotel Nairobi','https://www.ekahotel.com','hospitality'],
  ['Radisson Blu Nairobi','https://www.radissonhotels.com','hospitality'],
  ['PrideInn Hotels','https://www.prideinn.co.ke','hospitality'],
  ['Best Western Plus Nairobi','https://www.bestwestern.com','hospitality'],
  ['Movenpick Nairobi','https://movenpick.accor.com','hospitality'],

  ['Deloitte Kenya','https://www2.deloitte.com/ke','professional_services'],
  ['PwC Kenya','https://www.pwc.com/ke','professional_services'],
  ['KPMG Kenya','https://kpmg.com/ke','professional_services'],
  ['EY Kenya','https://www.ey.com/en_ke','professional_services'],
  ['Bowmans Kenya','https://www.bowmanslaw.com','professional_services'],
  ['Anjarwalla & Khanna','https://www.africalegalnetwork.com/member/anjarwalla-khanna','professional_services'],
  ['MMC Africa Law','https://mmcafrica.com','professional_services'],
  ['Oraro & Company Advocates','https://www.oraro.co.ke','professional_services'],
  ['Cliffe Dekker Hofmeyr Kenya','https://www.cliffedekkerhofmeyr.com','professional_services'],
  ['Grant Thornton Kenya','https://www.grantthornton.co.ke','professional_services'],

  ['DHL Kenya','https://www.dhl.com/ke-en','logistics'],
  ['FedEx Kenya','https://www.fedex.com/en-ke/home.html','logistics'],
  ['G4S Kenya','https://www.g4s.com/en-ke','logistics'],
  ['Siginon Group','https://www.siginon.com','logistics'],
  ['Sokowatch Twiga Logistics','https://www.twiga.com','logistics'],
  ['Sendy','https://sendyit.com','logistics'],
  ['Wells Fargo Kenya','https://www.wellsfargolimited.com','logistics'],
  ['Mitchelle Cotts Freight','https://www.mitchellecotts.co.ke','logistics'],
  ['Freight in Time Kenya','https://www.freightintime.com','logistics'],
  ['Samskip Kenya','https://www.samskip.com','logistics'],

  ['Cellulant','https://www.cellulant.io','saas'],
  ['Craft Silicon','https://www.craftsilicon.com','saas'],
  ['Kopo Kopo','https://kopokopo.co.ke','saas'],
  ['M-KOPA','https://m-kopa.com','saas'],
  ['Pezesha','https://www.pezesha.com','saas'],
  ['MarketForce RejaReja','https://www.marketforce.io','saas'],
  ['Workpay','https://www.workpay.co.ke','saas'],
  ['CloudFactory Africa Ops','https://www.cloudfactory.com','saas'],
  ['PawaPay','https://www.pawapay.io','saas'],
  ['Bamba','https://getbamba.com','saas'],

  ['Kenya Association of Manufacturers Members','https://kam.co.ke','general_business'],
  ['Kenya National Chamber Directory','https://kenyachamber.or.ke','general_business'],
  ['SME Founders Association Kenya','https://sme-founders.com','general_business'],
  ['KenInvest Company Directories','https://www.invest.go.ke','general_business'],
  ['Nairobi Garage Member Companies','https://nairobigarage.com','general_business'],
  ['iHub Portfolio Companies','https://ihub.co.ke','general_business'],
  ['Moringa Employer Partners','https://moringaschool.com','general_business'],
  ['Nairobi Securities listed firms','https://www.nse.co.ke','general_business'],
  ['Safaricom Spark Venture Partners','https://www.safaricom.co.ke','general_business'],
  ['KEPSA Member Organizations','https://kepsa.or.ke','general_business'],
];

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const header = [
  'organization','website','contact_name','role','email','phone','source_url','industry','intent_signal','priority_score','channel_primary','status','next_action','notes'
];

const rows = targets.map(([organization, website, industry], idx) => {
  const score = idx < 30 ? 82 : 74;
  return {
    organization,
    website,
    contact_name: '',
    role: 'Decision Maker',
    email: '',
    phone: '',
    source_url: website,
    industry,
    intent_signal: `Sector-fit target: ${industry}`,
    priority_score: score,
    channel_primary: 'email',
    status: 'new',
    next_action: 'Find decision-maker email/phone then send first-touch value message',
    notes: '',
  };
});

const lines = [header.join(',')];
for (const row of rows) {
  lines.push(header.map((k) => csvEscape(row[k])).join(','));
}

fs.writeFileSync(OUT_FILE, `${lines.join('\n')}\n`, 'utf8');
console.log(`Seeded ${rows.length} targets into ${OUT_FILE}`);
