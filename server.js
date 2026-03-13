const express = require('express');
const cors = require('cors');
const jsforce = require('jsforce');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ====== Salesforce Login ======
async function loginToSalesforce() {
  const conn = new jsforce.Connection({
    loginUrl: process.env.SF_LOGIN_URL || 'https://orgfarm-05f0452950-dev-ed.develop.my.salesforce.com'
  });
  const username = process.env.SF_USERNAME || 'ernestofs1231@agentforce.com';
  const passwordAndToken = process.env.SF_PASSWORD_TOKEN || '#Neto020991190006nmEDxig3Mau5BG0bY6KoVjDfL';
  await conn.login(username, passwordAndToken);
  return conn;
}

function escapeSOQLString(str) {
  return (str ?? '').toString().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ====== Catalog Cache ======
let catalogCache = null;
let catalogCacheTime = 0;
const CATALOG_TTL = 5 * 60 * 1000;

function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchCSV(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current.trim());
  return result;
}

function parseCatalog(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  const items = [];
  let currentCategory = '';
  for (let i = 0; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (!cols[0]) continue;
    const desc = cols[0].trim();
    const unit = (cols[1] || '').trim().toUpperCase();
    const rawCost = (cols[3] || cols[2] || '').replace(/[$,\s"]/g, '');
    const unitCost = parseFloat(rawCost);
    const validUnits = ['PZA', 'M2', 'JOR', 'SERV', 'LOTE', 'SAL', 'ML', 'KG', 'LT', 'HR', 'GLOBAL'];
    if (!validUnits.includes(unit) && isNaN(unitCost)) {
      if (desc.length > 2 && desc === desc.toUpperCase()) currentCategory = desc;
      continue;
    }
    if (desc && !isNaN(unitCost) && unitCost > 0) {
      items.push({ category: currentCategory, description: desc, unit: unit || 'PZA', unitCost });
    }
  }
  return items;
}

// ====== API: GET /api/condensado ======
app.get('/api/condensado', async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });

  try {
    const conn = await loginToSalesforce();

    // Date range for the month
    const startDate = `${year}-${String(month).padStart(2, '0')}-01T00:00:00Z`;
    const endMonth = month === 12 ? 1 : month + 1;
    const endYear = month === 12 ? year + 1 : year;
    const endDate = `${endYear}-${String(endMonth).padStart(2, '0')}-01T00:00:00Z`;

    // 1. Get all quotes for the month
    const quotesResult = await conn.query(`
      SELECT Id, Name, Status, CreatedDate, Tiendas__c, Account_Name_text__c, Nombre__c
      FROM Quote
      WHERE CreatedDate >= ${startDate} AND CreatedDate < ${endDate}
      ORDER BY Tiendas__c, CreatedDate
    `);

    const quotes = quotesResult.records || [];

    // 2. For each quote, get line items
    const storeMap = {};

    for (const quote of quotes) {
      const storeName = quote.Tiendas__c || quote.Account_Name_text__c || 'Sin Tienda';

      const linesResult = await conn.query(`
        SELECT Id, PricebookEntryId, UnitPrice, Quantity, TotalPrice, Discount,
          Foto_2__c, Sub_ITEM__c, Description, Descripcion_trabajo__c,
          Aprobado__c,
          PricebookEntry.Name, PricebookEntry.Product2.Name
        FROM QuoteLineItem
        WHERE QuoteId = '${escapeSOQLString(quote.Id)}'
      `);

      // DEBUG: log Aprobado__c values
      (linesResult.records || []).forEach(l => {
        console.log(`[Aprobado__c] QuoteLineItem ${l.Id} => ${JSON.stringify(l.Aprobado__c)}`);
      });

      const lineItems = (linesResult.records || []).map(l => ({
        id: l.Id,
        pricebookEntryId: l.PricebookEntryId || null,
        product: (l.PricebookEntry && l.PricebookEntry.Product2 && l.PricebookEntry.Product2.Name)
          || (l.PricebookEntry && l.PricebookEntry.Name) || '—',
        subItem: l.Sub_ITEM__c || '—',
        description: l.Description || '',
        descTrabajo: l.Descripcion_trabajo__c || '',
        foto: l.Foto_2__c || '',
        quantity: Number(l.Quantity || 0),
        unitPrice: Number(l.UnitPrice || 0),
        totalPrice: Number(l.TotalPrice || 0),
        discount: Number(l.Discount || 0),
        aprobado: l.Aprobado__c != null ? l.Aprobado__c : null
      }));

      if (!storeMap[storeName]) {
        storeMap[storeName] = {
          name: storeName,
          quotes: [],
          lineItems: [],
          totalCost: 0,
          firstQuoteId: null,
          firstPricebookEntryId: null
        };
      }

      // Track first quoteId and pricebookEntryId for this store (needed to create additionals)
      if (!storeMap[storeName].firstQuoteId) {
        storeMap[storeName].firstQuoteId = quote.Id;
      }
      if (!storeMap[storeName].firstPricebookEntryId) {
        const firstWithEntry = lineItems.find(l => l.pricebookEntryId);
        if (firstWithEntry) storeMap[storeName].firstPricebookEntryId = firstWithEntry.pricebookEntryId;
      }

      const quoteTotalCost = lineItems.reduce((sum, l) => sum + l.totalPrice, 0);

      storeMap[storeName].quotes.push({
        id: quote.Id,
        name: quote.Name,
        status: quote.Status || 'Draft',
        createdDate: quote.CreatedDate,
        contacto: quote.Nombre__c || '',
        totalCost: quoteTotalCost
      });

      storeMap[storeName].lineItems.push(...lineItems);
      storeMap[storeName].totalCost += quoteTotalCost;
    }

    // Convert to array and compute grand total
    const stores = Object.values(storeMap).sort((a, b) => a.name.localeCompare(b.name));
    const grandTotal = stores.reduce((sum, s) => sum + s.totalCost, 0);

    // Month name in Spanish
    const monthNames = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
      'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

    res.json({
      month: monthNames[month - 1] + ' ' + year,
      year,
      monthNum: month,
      stores,
      grandTotal,
      totalQuotes: quotes.length
    });

  } catch (err) {
    console.error('Error /api/condensado:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ====== API: POST /api/update-prices ======
app.post('/api/update-prices', async (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'updates array required' });
  }

  try {
    const conn = await loginToSalesforce();
    const results = [];

    for (const item of updates) {
      if (!item.id) continue;
      const updateData = { Id: item.id };
      if (item.unitPrice !== undefined) updateData.UnitPrice = Number(item.unitPrice);
      if (item.descripcionTrabajo !== undefined) updateData.Descripcion_trabajo__c = item.descripcionTrabajo;
      const result = await conn.sobject('QuoteLineItem').update(updateData);
      results.push({ id: item.id, success: result.success, errors: result.errors });
    }

    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      return res.status(207).json({ success: false, results, message: `${failed.length} update(s) failed` });
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('Error /api/update-prices:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ====== API: POST /api/additionals/save ======
app.post('/api/additionals/save', async (req, res) => {
  const { additionals } = req.body;
  if (!Array.isArray(additionals) || additionals.length === 0) {
    return res.status(400).json({ error: 'additionals array required' });
  }

  try {
    const conn = await loginToSalesforce();
    const results = [];

    for (const item of additionals) {
      if (!item.quoteId || !item.pricebookEntryId) continue;
      const newRecord = {
        QuoteId: item.quoteId,
        PricebookEntryId: item.pricebookEntryId,
        Quantity: Number(item.qty) || 1,
        UnitPrice: Number(item.unitPrice) || 0,
        Descripcion_trabajo__c: item.concept || '',
        Description: item.unit || '',
        Sub_ITEM__c: 'ADICIONAL'
      };
      const result = await conn.sobject('QuoteLineItem').create(newRecord);
      results.push({ success: result.success, id: result.id, errors: result.errors });
    }

    const failed = results.filter(r => !r.success);
    if (failed.length > 0) {
      const errMsg = failed.map(f => (f.errors || []).map(e => e.message).join(', ')).join('; ');
      return res.status(207).json({ success: false, results, message: `${failed.length} adicional(es) no guardado(s): ${errMsg}` });
    }

    res.json({ success: true, results });
  } catch (err) {
    console.error('Error /api/additionals/save:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ====== API: GET /api/catalog ======
app.get('/api/catalog', async (req, res) => {
  try {
    const now = Date.now();
    if (catalogCache && (now - catalogCacheTime) < CATALOG_TTL) {
      return res.json({ items: catalogCache });
    }
    const csvUrl = 'https://docs.google.com/spreadsheets/d/11jc-SlDm3p7gdV5ofIilje6_kMlsbA89xvegjURzuGk/gviz/tq?tqx=out:csv&gid=1138438490';
    const csvText = await fetchCSV(csvUrl);
    const items = parseCatalog(csvText);
    catalogCache = items;
    catalogCacheTime = now;
    res.json({ items });
  } catch (err) {
    console.error('Error /api/catalog:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ====== Start Server ======
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`MonthlyCondensado running on port ${PORT}`);
});
