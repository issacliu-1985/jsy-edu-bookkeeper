**
 * JSY Edu AI Bookkeeper — Telegram Bot
 * Built by Oktos
 *
 * Stack: Node.js + Express + Telegram Bot API + Anthropic Claude API
 * Hosting: Railway
 */
 
import express from 'express';
import fetch from 'node-fetch';
import FormData from 'form-data';
import { GoogleAuth } from 'google-auth-library';
 
const app = express();
app.use(express.json());
 
// ── ENV VARS (set in Railway dashboard) ──────────────────────────────────────
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY    = process.env.ANTHROPIC_API_KEY;
const WEBHOOK_SECRET   = process.env.WEBHOOK_SECRET || 'jsy-oktos-secret';
const DRIVE_FOLDER_ID  = process.env.DRIVE_FOLDER_ID || '184S1ULV5T7gGILScV6Oxj7jkq57YHnNI'; // /JSY Edu/2026
 
const SHEETS = {
  transactions:    '1DYU46nQbz0vULEHbZcP28sgChDK8Vq1dIjFApa9_638',
  studentPayments: '1rrZafFLLeK6q9VdsXP6wLoOONA87y_OVCvsHv1b9hW0',
  invoiceLog:      '1Z0mWNjyVBxfjGhCFFYYcJ7xhedO7AOqnxJXgDs6Zajs',
  plSummary:       '1U0Koh8geeMQ4QUqP96Ih_gy6aOK2qwKoFzun2WyWdaM',
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
const SYSTEM_PROMPT = `You are an AI bookkeeper built by Oktos for JSY Edu, a Singapore-based childcare and enrichment centre. You are running inside a Telegram bot — keep all responses SHORT and conversational. No long paragraphs. Use plain text only — no markdown headers, no bullet points with asterisks. Use simple line breaks instead.
 
KEY BUSINESS CONTEXT:
- Business: JSY Edu — childcare/enrichment centre, MMCC, Singapore
- Not GST-registered. New ownership from January 2026.
- Financial year: January to December. Base currency: SGD.
 
FIXED COSTS: Rent $10,146/month (MMCC), Staffing ~$8,500–$10,000/month. Key staff: Vivian Chan.
REVENUE MODEL: ~$750/student/month. ~27 students. Effective ~$620–700 after discounts.
 
AUDITED FINANCIALS (FY2025, ended 31 Jan 2025):
Revenue: $45,013 | Cost of Sales: $(106,558) | Gross Loss: $(61,545)
Admin Expenses: $(216,199) incl. dep ROU $(109,353), dep P&E $(17,859), dep franchise $(17,280), lease interest $(14,230)
Total Loss: $(277,744) — PREVIOUS OWNERS, not new owner benchmark
Cash: $34,765 | Total Assets: $466,247 | Equity: $184,280
 
DEPRECIATION (monthly): ROU $9,112.77 + P&E $1,488.26 + Franchise $1,440.00 = $12,041.03/month
ASSET POLICY: Any new asset purchase → expense immediately to P&L. No depreciation schedules.
 
STUDENTS: Brenda Yu, Tan Soo Suan Elyssa, Lim Chungyi, Toh Kai Fu Isaiah, Toh Kai Long Zechariah, Lim Jing Han Louis, Ng Yong Jia Lucas, Aiden Wong Hong Yu, Antoine Xie, Chen LinJiuHe, Chua Zhan He Nathan, Elliot John Lee, Hebe Milo Pierre Jean Claude, Kathleen Aurelia Putera, Leonard Hansidi, Lucas Lau Jun Yan, Matthias Lau Jia Xun, Natasha Kiara Liu Wen Hui, Pradiksha D/O Praveen, Rendla Nihaan Neshmen, Seah Si Yi Lauren, Tan Hong Kai Isaac, Tan Yue Ning Natalie, Teo Yan Wei Gavriel, Yap Zi Yu Jaelyn, Carla Ong Xinle, Zachary Peh
 
STUDENT DISAMBIGUATION: If a name is ambiguous or partial, always ask which student before proceeding. Never assume.
 
CHART OF ACCOUNTS: Revenue | Employment Benefits | Transport | Food Costs | Rent | Utilities | IT Services | Marketing | Insurance | Professional Fees | Training | Consultancy | Business Expenses | Cleaning | Printing | Membership | Advertising | Recruitment | Depreciation | Lease Interest | General Expenses
 
YOUR ROLE:
1. Answer financial questions — lead with Revenue, Expenses, Net Profit
2. Record transactions — confirm: "Recorded: [desc] — SGD [amount] → [Category]"
3. Track student payments — flag unknown names
4. Flag anomalies — flag unusual spend simply
5. Handle file uploads — when a file or photo is received, confirm it has been saved to Google Drive and ask what they want to do with it
6. Refer to Oktos for tax advice
 
RULES:
- NEVER estimate when you don't have exact data. Say so and ask for the data.
- NEVER give tax advice — refer to Oktos.
- ASSET POLICY: New purchases → expense immediately, no depreciation.
- For immaterial expenses (under $50) with clear description — silently classify to correct account.
- If question seems out of the ordinary, answer then gently ask "Is everything okay?"
- When confirming a transaction, always use the word "Recorded" so the system can detect it.
- Keep responses under 5 sentences unless more detail is specifically asked for.
- This is Telegram — be concise. No markdown formatting.`;
 
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
  const buffer = await res.buffer();
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
    const auth = new GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/drive.file']
    });
    const client = await auth.getClient();
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
    return data.id ? `https://drive.google.com/file/d/${data.id}` : null;
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
  '01 January':   '1MQkKV-CmZ5ueb0C_2vKV4aolvo0096bo',
  '02 February':  '1Tp9zQKmSbBIgfLCK4xHI2_RUkuA7flpB',
  '03 March':     '12WSHvsi2HUlwpA4ctG_JN6By66DOgkZ9',
  '04 April':     '1ar-49HvFEZlhBuolsggvYP0HiivAi3gF',
  '05 May':       '1Uo01nH8UV4qlxR7JYdn5XDGdPA0aQM61',
  '06 June':      '1vOHcU-1ggHz5fR1jALHTmSmXX2lU8F68',
  '07 July':      '1xTgDEubHfXs9kV3PhQaSBxnPr3DDAMi6',
  '08 August':    '17zpmhqdM4iI3Vahpp7wXcnSG4KrKqtds',
  '09 September': '1Q9aKriatlwIO18hOYB0ROKn3at4ggwy8',
  '10 October':   '1A41Tbzg0R19lyC58qVZOZgA-if1gNHot',
  '11 November':  '1UbtcetORtsMQg3uh8K5d1KPgRDmongTk',
  '12 December':  '1NclXTOotetZngqY7TonG-m3Xi02DQkAQ',
};
 
// ── GOOGLE SHEETS APPEND ──────────────────────────────────────────────────────
async function appendToSheet(sheetId, row) {
  try {
    const credJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!credJson) return;
 
    const creds = JSON.parse(credJson);
    const auth = new GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
 
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Sheet1!A:Z:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: [row] })
      }
    );
  } catch (e) {
    console.error('Sheets append error:', e.message);
  }
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
        userText = msg.caption || 'Please read this receipt. Extract the vendor name, amount, date, and suggest the correct expense category for JSY Edu. Then confirm it as a recorded transaction.';
 
        // Auto-file to Drive
        const now = new Date();
        const monthKey = `${String(now.getMonth()+1).padStart(2,'0')} ${['January','February','March','April','May','June','July','August','September','October','November','December'][now.getMonth()]}`;
        const folderId = MONTH_FOLDERS[monthKey] || DRIVE_FOLDER_ID;
        const fileName = `Receipt_${now.toISOString().split('T')[0]}_${photo.file_id.slice(-6)}.jpg`;
        const buffer = Buffer.from(imageBase64, 'base64');
        const driveUrl = await uploadToDrive(fileName, buffer, 'image/jpeg', folderId);
 
        if (driveUrl) {
          await sendMessage(chatId, `📁 Saved to Google Drive (${monthKey})`);
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
        const buffer = await fetch(fileUrl).then(r => r.buffer());
        const driveUrl = await uploadToDrive(doc.file_name, buffer, doc.mime_type, folderId);
 
        if (driveUrl) {
          await sendMessage(chatId, `📁 "${doc.file_name}" saved to Google Drive (${monthKey})\n\nWhat would you like me to do with this file?`);
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
 
    const reply = await askClaude(session.messages, imageBase64, imageMime);
    session.messages.push({ role: 'assistant', content: reply });
 
    await sendMessage(chatId, reply);
 
    // ── Auto-sync transaction to Sheets if detected ───────────────────────────
    const txn = parseTransactionFromReply(reply);
    if (txn) {
      await appendToSheet(SHEETS.transactions, [
        txn.date, txn.description, txn.category,
        txn.amountIn, txn.amountOut, txn.net,
        txn.month, txn.year, txn.source, txn.notes
      ]);
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
 ls -la


