const express = require('express');
const cors = require('cors');
const jsforce = require('jsforce');
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
        SELECT Id, UnitPrice, Quantity, TotalPrice, Discount,
          Foto_2__c, Sub_ITEM__c, Description, Descripcion_trabajo__c,
          aprobado__c,
          PricebookEntry.Name, PricebookEntry.Product2.Name
        FROM QuoteLineItem
        WHERE QuoteId = '${escapeSOQLString(quote.Id)}'
      `);

      // DEBUG: log aprobado__c values
      (linesResult.records || []).forEach(l => {
        console.log(`[aprobado__c] QuoteLineItem ${l.Id} => ${JSON.stringify(l.aprobado__c)}`);
      });

      const lineItems = (linesResult.records || []).map(l => ({
        id: l.Id,
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
        aprobado: l.aprobado__c != null ? l.aprobado__c : null
      }));

      if (!storeMap[storeName]) {
        storeMap[storeName] = {
          name: storeName,
          quotes: [],
          lineItems: [],
          totalCost: 0
        };
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

// ====== Start Server ======
const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  console.log(`MonthlyCondensado running on port ${PORT}`);
});
