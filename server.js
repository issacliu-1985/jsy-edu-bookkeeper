/**
* JSY Edu AI Bookkeeper — Telegram Bot
* Built by Oktos
*
* Stack: Node.js + Express + Telegram Bot API + Anthropic Claude API
* Hosting: Railway
*/

import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { GoogleAuth, JWT } from 'google-auth-library';

const app = express();
app.use(express.json());

// ── ENV VARS (set in Railway dashboard) ──────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'jsy-oktos-secret';
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || '184S1ULV5T7gGILScV6Oxj7jkq57YHnNI'; // /JSY Edu/2026

const SHEETS = {
  transactions: '1DYU46nQbz0vULEHbZcP28sgChDK8Vq1dIjFApa9_638',
  studentPayments: '1rrZafFLLeK6q9VdsXP6wLoOONA87y_OVCvsHv1b9hW0',
  invoiceLog: '1Z0mWNjyVBxfjGhCFFYYcJ7xhedO7AOqnxJXgDs6Zajs',
  plSummary: '1U0Koh8geeMQ4QUqP96Ih_gy6aOK2qwKoFzun2WyWdaM',
};

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── CONVERSATION MEMORY (per chat_id, in-memory) ─────────────────────────────
// For production, replace with Redis or a DB
const sessions = {};

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = { messages: [], lastActive: Date.now() };
  }
  sessions[chatId].lastActive = Date.now();
  return sessions[chatId];
}

// Prune sessions older than 24 hours
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const [id, s] of Object.entries(sessions)) {
    if (s.lastActive < cutoff) delete sessions[id];
  }
}, 60 * 60 * 1000);

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the bookkeeper for JSY Edu, a Singapore childcare and enrichment centre. You work through Telegram. You were built by Oktos.

Your personality: you sound like a real, experienced bookkeeper — professional, direct, and human. You're not a chatbot. You don't give canned responses. You don't start every message the same way. You engage with what the person actually said, ask follow-up questions when something is unclear, and flag things that look off. Match the tone and length of the conversation — a quick question gets a quick answer, a complex one gets a proper explanation.

Never use markdown formatting (no bold, no headers, no asterisks). Use plain text and line breaks only. This is Telegram.

BUSINESS CONTEXT:
- JSY Edu — childcare/enrichment centre at MMCC, Singapore
- Not GST-registered. New ownership from January 2026.
- Financial year: January to December. Base currency: SGD.

FIXED COSTS: Rent $10,146/month, Staffing ~$8,500–$10,000/month. Key staff: Vivian Chan.
REVENUE MODEL: ~$750/student/month. ~27 students. Effective ~$620–700 after discounts.

AUDITED FINANCIALS (FY2025, ended 31 Jan 2025):
Revenue: $45,013 | Cost of Sales: $(106,558) | Gross Loss: $(61,545)
Admin Expenses: $(216,199) incl. dep ROU $(109,353), dep P&E $(17,859), dep franchise $(17,280), lease interest $(14,230)
Total Loss: $(277,744) — previous owners, not a benchmark for new ownership
Cash: $34,765 | Total Assets: $466,247 | Equity: $184,280

DEPRECIATION (monthly): ROU $9,112.77 + P&E $1,488.26 + Franchise $1,440.00 = $12,041.03/month
ASSET POLICY: Any new asset purchase → expense immediately to P&L. No depreciation schedules.

STUDENTS: Brenda Yu, Tan Soo Suan Elyssa, Lim Chungyi, Toh Kai Fu Isaiah, Toh Kai Long Zechariah, Lim Jing Han Louis, Ng Yong Jia Lucas, Aiden Wong Hong Yu, Antoine Xie, Chen LinJiuHe, Chua Zhan He Nathan, Elliot John Lee, Hebe Milo Pierre Jean Claude, Kathleen Aurelia Putera, Leonard Hansidi, Lucas Lau Jun Yan, Matthias Lau Jia Xun, Natasha Kiara Liu Wen Hui, Pradiksha D/O Praveen, Rendla Nihaan Neshmen, Seah Si Yi Lauren, Tan Hong Kai Isaac, Tan Yue Ning Natalie, Teo Yan Wei Gavriel, Yap Zi Yu Jaelyn, Carla Ong Xinle, Zachary Peh

If a student name is ambiguous, ask before proceeding. Never assume.

CHART OF ACCOUNTS: Revenue | Employment Benefits | Transport | Food Costs | Rent | Utilities | IT Services | Marketing | Insurance | Professional Fees | Training | Consultancy | Business Expenses | Cleaning | Printing | Membership | Advertising | Recruitment | Depreciation | Lease Interest | General Expenses

WHAT YOU DO:
- Answer financial questions using actual ledger data when it's provided to you
- Record transactions and confirm with: "Recorded: [desc] — SGD [amount] → [Category]"
- Track student payments, flag unknown names
- Notice anomalies and mention them naturally, like a bookkeeper would
- Refer tax questions to Oktos — that's not your role
- For expenses under $50 with a clear description, classify without asking

IMPORTANT: When financial data is injected into the prompt, use it to give real answers. Don't say you don't have access to data if the data is right there.`;

// ── ANTHROPIC API CALL ────────────────────────────────────────────────────────
async function askClaude(messages, imageBase64 = null, imageMime = null) {
  // If there's an image, attach it to the last user message
  let msgs = [...messages];
  if (imageBase64 && msgs.length > 0) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'user') {
      msgs[msgs.length - 1] = {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 }
          },
          { type: 'text', text: typeof last.content === 'string' ? last.content : 'Please process this file.' }
        ]
      };
    }
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: msgs
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.[0]?.text || 'Sorry, something went wrong.';
}

// ── TELEGRAM HELPERS ──────────────────────────────────────────────────────────
async function sendMessage(chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function sendTyping(chatId) {
  await fetch(`${TELEGRAM_API}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' })
  });
}

async function getFileUrl(fileId) {
  const res = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) return null;
  return `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${data.result.file_path}`;
}

async function downloadFileAsBase64(url) {
  const res = await fetch(url);
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer.toString('base64');
}

// ── GOOGLE DRIVE UPLOAD ───────────────────────────────────────────────────────
async function uploadToDrive(fileName, fileBuffer, mimeType, monthFolderId) {
  try {
    // Use service account auth if available, otherwise skip
    const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!credJson) {
      console.log('No Google service account configured — skipping Drive upload');
      return null;
    }

    const creds = JSON.parse(credJson);
    // Use JWT with domain-wide delegation to impersonate issac@oktos.com.sg
    // (Service Accounts have no storage quota — DWD uploads files as the real user)
    const client = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/drive'],
      subject: 'issac@oktos.com.sg'
    });
    const token = await client.getAccessToken();

    const metadata = {
      name: fileName,
      parents: [monthFolderId]
    };

    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata), { contentType: 'application/json' });
    form.append('file', fileBuffer, { filename: fileName, contentType: mimeType });

    const res = await fetch(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          ...form.getHeaders()
        },
        body: form
      }
    );

    const data = await res.json();
    if (!data.id) {
      console.error('Drive upload failed:', JSON.stringify(data));
      return null;
    }
    return `https://drive.google.com/file/d/${data.id}`;
  } catch (e) {
    console.error('Drive upload error:', e.message);
    return null;
  }
}

// ── GET MONTHLY DRIVE FOLDER ──────────────────────────────────────────────────
function getMonthFolderId(monthFolderMap) {
  const now = new Date();
  const monthNum = String(now.getMonth() + 1).padStart(2, '0');
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const key = `${monthNum} ${monthNames[now.getMonth()]}`;
  return monthFolderMap[key] || DRIVE_FOLDER_ID;
}

// Month folder IDs (from Phase 2 setup)
const MONTH_FOLDERS = {
  '01 January': '1MQkKV-CmZ5ueb0C_2vKV4aolvo0096bo',
  '02 February': '1Tp9zQKmSbBIgfLCK4xHI2_RUkuA7flpB',
  '03 March': '12WSHvsi2HUlwpA4ctG_JN6By66DOgkZ9',
  '04 April': '1ar-49HvFEZlhBuolsggvYP0HiivAi3gF',
  '05 May': '1Uo01nH8UV4qlxR7JYdn5XDGdPA0aQM61',
  '06 June': '1vOHcU-1ggHz5fR1jALHTmSmXX2lU8F68',
  '07 July': '1xTgDEubHfXs9kV3PhQaSBxnPr3DDAMi6',
  '08 August': '17zpmhqdM4iI3Vahpp7wXcnSG4KrKqtds',
  '09 September': '1Q9aKriatlwIO18hOYB0ROKn3at4ggwy8',
  '10 October': '1A41Tbzg0R19lyC58qVZOZgA-if1gNHot',
  '11 November': '1UbtcetORtsMQg3uh8K5d1KPgRDmongTk',
  '12 December': '1NclXTOotetZngqY7TonG-m3Xi02DQkAQ',
};

// ── GOOGLE SHEETS APPEND ──────────────────────────────────────────────────────
async function appendToSheet(sheetId, row) {
  try {
    const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!credJson) { console.log('Sheets: no credentials'); return; }

    const creds = JSON.parse(credJson);
    // Use JWT with domain-wide delegation to impersonate issac@oktos.com.sg
    const client = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      subject: 'issac@oktos.com.sg'
    });
    const token = await client.getAccessToken();

    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:Z:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [row] })
      }
    );
    const result = await res.json();
    if (result.error) {
      console.error('Sheets append failed:', JSON.stringify(result.error));
    } else {
      console.log('Sheets write OK:', row[0], row[1], row[2]);
    }
  } catch (e) {
    console.error('Sheets append error:', e.message);
  }
}

// ── READ SHEET DATA ───────────────────────────────────────────────────────────
async function readSheetData(sheetId) {
  try {
    const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!credJson) return null;
    const creds = JSON.parse(credJson);
    const client = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      subject: 'issac@oktos.com.sg'
    });
    const token = await client.getAccessToken();
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/A:J`,
      { headers: { Authorization: `Bearer ${token.token}` } }
    );
    const data = await res.json();
    if (data.error) { console.error('Sheets read failed:', JSON.stringify(data.error)); return null; }
    return data.values || [];
  } catch (e) {
    console.error('Sheets read error:', e.message);
    return null;
  }
}

// ── DETECT FINANCIAL QUERY ────────────────────────────────────────────────────
function isFinancialQuery(text) {
  const keywords = [
    'expense', 'expenses', 'revenue', 'income', 'profit', 'loss', 'net',
    'summary', 'how much', 'how did', 'total', 'spend', 'spent', 'paid',
    'january', 'february', 'march', 'april', 'may', 'june', 'july',
    'august', 'september', 'october', 'november', 'december',
    'this month', 'last month', 'ytd', 'year to date', 'breakdown',
    'report', 'p&l', 'management accounts', 'cash', 'balance', 'outstanding',
    'category', 'categories', 'food', 'rent', 'salary', 'salaries', 'utilities'
  ];
  return keywords.some(k => text.toLowerCase().includes(k));
}

// ── FORMAT LEDGER AS CONTEXT FOR CLAUDE ───────────────────────────────────────
function formatLedgerContext(rows) {
  if (!rows || rows.length < 2) return 'Ledger is empty — no transactions recorded yet.';
  const data = rows.slice(1); // skip header row

  // Build monthly summary
  const monthly = {};
  for (const row of data) {
    const [date, desc, cat, amtIn, amtOut, net, month, year] = row;
    const key = `${month || '?'} ${year || '?'}`;
    if (!monthly[key]) monthly[key] = { revenue: 0, expenses: 0 };
    monthly[key].revenue += parseFloat(amtIn) || 0;
    monthly[key].expenses += parseFloat(amtOut) || 0;
  }

  let ctx = 'MONTHLY SUMMARY FROM MASTER LEDGER:\n';
  for (const [period, d] of Object.entries(monthly)) {
    const net = d.revenue - d.expenses;
    ctx += `${period}: Revenue $${d.revenue.toFixed(2)}, Expenses $${d.expenses.toFixed(2)}, Net $${net >= 0 ? '+' : ''}${net.toFixed(2)}\n`;
  }

  ctx += '\nALL TRANSACTIONS (Date | Description | Category | Amount In | Amount Out | Net | Month | Year | Source):\n';
  for (const row of data) {
    ctx += row.slice(0, 9).join(' | ') + '\n';
  }

  return ctx;
}

// ── PARSE TRANSACTION FROM CLAUDE REPLY ──────────────────────────────────────
function parseTransactionFromReply(reply) {
  if (!reply.toLowerCase().includes('recorded')) return null;
  const amountMatch = reply.match(/SGD\s*([\d,]+(?:\.\d{2})?)/i);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1].replace(',', ''));
  const catMatch = reply.match(/→\s*([A-Za-z &]+)/);
  const category = catMatch ? catMatch[1].trim() : 'General Expenses';
  const isIncome = reply.toLowerCase().includes('revenue') || reply.toLowerCase().includes('received');
  const today = new Date();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return {
    date: today.toLocaleDateString('en-SG'),
    description: reply.substring(0, 100).replace(/\n/g, ' '),
    category,
    amountIn: isIncome ? amount : '',
    amountOut: isIncome ? '' : amount,
    net: isIncome ? amount : -amount,
    month: months[today.getMonth()],
    year: today.getFullYear(),
    source: 'Telegram',
    notes: ''
  };
}

// ── MAIN WEBHOOK HANDLER ──────────────────────────────────────────────────────
app.post(`/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  res.sendStatus(200); // Always acknowledge Telegram immediately

  const update = req.body;
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat.id;
  const session = getSession(chatId);

  try {
    await sendTyping(chatId);

    let userText = msg.text || '';
    let imageBase64 = null;
    let imageMime = null;
    let fileHandled = false;

    // ── Handle /start command ────────────────────────────────────────────────
    if (userText === '/start') {
      await sendMessage(chatId,
        '👋 Hi! I\'m the JSY Edu AI Bookkeeper, built by Oktos.\n\n' +
        'You can:\n' +
        '• Ask me about your finances\n' +
        '• Record a transaction (e.g. "I received $750 from Brenda Yu")\n' +
        '• Send a photo of a receipt\n' +
        '• Ask for a monthly P&L\n\n' +
        'What would you like to do?'
      );
      return;
    }

    // ── Handle /help command ─────────────────────────────────────────────────
    if (userText === '/help') {
      await sendMessage(chatId,
        'Things you can ask me:\n\n' +
        '"How did we do in March?"\n' +
        '"I paid $94 for Singtel wifi"\n' +
        '"Record $750 from Elyssa for April fee"\n' +
        '"What\'s my net profit this month?"\n' +
        '"Which students haven\'t paid yet?"\n' +
        '"Generate management accounts for March 2025"\n\n' +
        'You can also send me a photo of a receipt and I\'ll categorise it.\n\n' +
        'For accounting help, contact Oktos.'
      );
      return;
    }

    // ── Handle photo (receipt scan) ──────────────────────────────────────────
    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1]; // largest size
      const fileUrl = await getFileUrl(photo.file_id);
      if (fileUrl) {
        imageBase64 = await downloadFileAsBase64(fileUrl);
        imageMime = 'image/jpeg';
        userText = msg.caption || 'Read this receipt carefully. Extract: (1) vendor/store name, (2) total amount paid in SGD, (3) the date if visible. Then classify it under the correct JSY Edu expense category. Valid categories: Employment Benefits, Transport, Food Costs, Rent, Utilities, IT Services, Marketing, Insurance, Professional Fees, Training, Consultancy, Business Expenses, Cleaning, Printing, Membership, Advertising, Recruitment, General Expenses. End your reply with EXACTLY this line (no variations): "Recorded: [vendor name] — SGD [amount] → [Category]"';

        // Auto-file to Drive
        const now = new Date();
        const monthKey = `${String(now.getMonth()+1).padStart(2,'0')} ${['January','February','March','April','May','June','July','August','September','October','November','December'][now.getMonth()]}`;
        const folderId = MONTH_FOLDERS[monthKey] || DRIVE_FOLDER_ID;
        const ts = now.toISOString().slice(0, 19).replace(/[T:]/g, '-');
        const fileName = `Receipt_${ts}.jpg`;
        const buffer = Buffer.from(imageBase64, 'base64');
        const driveUrl = await uploadToDrive(fileName, buffer, 'image/jpeg', folderId);

        if (driveUrl) {
          await sendMessage(chatId, `📁 Receipt saved to Google Drive (${monthKey})\n${driveUrl}`);
        }
        fileHandled = true;
      }
    }

    // ── Handle document upload (PDF, Excel, etc.) ────────────────────────────
    if (msg.document) {
      const doc = msg.document;
      const fileUrl = await getFileUrl(doc.file_id);
      const now = new Date();
      const monthKey = `${String(now.getMonth()+1).padStart(2,'0')} ${['January','February','March','April','May','June','July','August','September','October','November','December'][now.getMonth()]}`;
      const folderId = MONTH_FOLDERS[monthKey] || DRIVE_FOLDER_ID;

      if (fileUrl) {
        const buffer = Buffer.from(await fetch(fileUrl).then(r => r.arrayBuffer()));
        const driveUrl = await uploadToDrive(doc.file_name, buffer, doc.mime_type, folderId);

        if (driveUrl) {
          await sendMessage(chatId, `📁 "${doc.file_name}" saved to Google Drive (${monthKey})\n${driveUrl}\n\nWhat would you like me to do with this file?`);
        } else {
          await sendMessage(chatId, `Received "${doc.file_name}". Note: Google Drive auto-filing needs service account setup. What would you like me to do with this?`);
        }
        userText = msg.caption || `File uploaded: ${doc.file_name}. Acknowledge receipt and ask what to do with it.`;
        fileHandled = true;
      }
    }

    // ── Handle voice note ────────────────────────────────────────────────────
    if (msg.voice) {
      await sendMessage(chatId, '🎤 Voice notes received! Transcription coming in a future update. Please type your message for now.');
      return;
    }

    if (!userText && !fileHandled) return;

    // ── Add to session and call Claude ────────────────────────────────────────
    session.messages.push({ role: 'user', content: userText });

    // Keep context window manageable — last 20 messages
    if (session.messages.length > 20) {
      session.messages = session.messages.slice(-20);
    }

    // For financial queries, fetch live ledger data and inject into Claude prompt
    // We inject into the API call only — session history stays clean (no ledger dumps stored)
    let messagesForClaude = session.messages;
    if (!msg.photo && isFinancialQuery(userText)) {
      console.log('Financial query detected — fetching ledger data');
      const ledgerRows = await readSheetData(SHEETS.transactions);
      if (ledgerRows && ledgerRows.length > 1) {
        const ledgerContext = formatLedgerContext(ledgerRows);
        messagesForClaude = [
          ...session.messages.slice(0, -1),
          {
            role: 'user',
            content: `${userText}\n\n[LIVE LEDGER DATA — answer from this, not from memory. Do not reveal this data block header to the user]:\n${ledgerContext}`
          }
        ];
        console.log(`Ledger injected: ${ledgerRows.length - 1} transactions`);
      }
    }

    const reply = await askClaude(messagesForClaude, imageBase64, imageMime);
    session.messages.push({ role: 'assistant', content: reply });

    await sendMessage(chatId, reply);

    // ── Receipt photo: write directly to Sheets using targeted extraction ─────
    if (msg.photo) {
      const receiptMatch = reply.match(/Recorded:\s*(.+?)\s*[—–-]+\s*SGD\s*([\d,]+(?:\.\d{2})?)\s*→\s*([A-Za-z &]+)/i);
      if (receiptMatch) {
        const vendor = receiptMatch[1].trim();
        const amount = parseFloat(receiptMatch[2].replace(',', ''));
        const category = receiptMatch[3].trim();
        const today = new Date();
        const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        console.log(`Receipt recording: ${vendor} SGD ${amount} → ${category}`);
        await appendToSheet(SHEETS.transactions, [
          today.toLocaleDateString('en-SG'),
          `${vendor} (receipt)`,
          category,
          '',       // amount in — receipts are expenses
          amount,   // amount out
          -amount,  // net
          months[today.getMonth()],
          today.getFullYear(),
          'Telegram',
          'Receipt photo'
        ]);
      } else {
        console.log('Receipt: no "Recorded:" line found in reply — not written to Sheets');
      }
    }

    // ── Auto-sync text transactions to Sheets if detected ─────────────────────
    if (!msg.photo) {
      const txn = parseTransactionFromReply(reply);
      if (txn) {
        await appendToSheet(SHEETS.transactions, [
          txn.date, txn.description, txn.category,
          txn.amountIn, txn.amountOut, txn.net,
          txn.month, txn.year, txn.source, txn.notes
        ]);
      }
    }

  } catch (err) {
    console.error('Handler error:', err);
    await sendMessage(chatId, 'Something went wrong. Please try again.');
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'JSY Edu AI Bookkeeper', built_by: 'Oktos' });
});

// ── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JSY Edu Bookkeeper bot running on port ${PORT}`);
});
