const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');
const validator = require('validator');
const xss = require('xss');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 4000;
const CONTACT_RECIPIENT = process.env.CONTACT_RECIPIENT || 'office@activcleaning.ro';
const PRIVACY_CONTACT = process.env.PRIVACY_CONTACT || 'privacy@activcleaning.ro';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 10;
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS) || 730;
const GDPR_REQUEST_RETENTION_DAYS = Number(process.env.GDPR_REQUEST_RETENTION_DAYS) || 365;
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || origin === 'null') {
      // Permite accesul din aplicații desktop / file:// în dezvoltare.
      return callback(null, true);
    }
    if (!allowedOrigins.length || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origine neautorizată'));
  }
};

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https://images.unsplash.com", "https://plus.unsplash.com"],
        fontSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameSrc: ["'self'", "https://www.google.com", "https://maps.gstatic.com"],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: []
      }
    },
    crossOriginEmbedderPolicy: false
  })
);
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cors(corsOptions));
app.use(express.static(path.join(__dirname)));

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Prea multe mesaje trimise. Mai încearcă în scurt timp.' }
});
app.use('/api/contact', contactLimiter);

const dataDir = path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new sqlite3.Database(path.join(dataDir, 'contact_messages.db'), (err) => {
  if (err) {
    console.error('Eroare conectare DB', err);
  } else {
    console.log('Conectat la baza de date contact_messages.db');
  }
});

const purgeOldEntries = () =>
  Promise.all([
    new Promise((resolve) => {
      if (!RETENTION_DAYS) return resolve();
      const modifier = `-${RETENTION_DAYS} day`;
      db.run(
        `DELETE FROM contact_messages WHERE created_at <= datetime('now', ?)`,
        [modifier],
        function onResult(err) {
          if (err) {
            console.error('Eroare la ștergerea mesajelor vechi:', err.message);
          } else if (this.changes) {
            console.log(`Mesaje contact șterse pe baza retenției: ${this.changes}`);
          }
          resolve();
        }
      );
    }),
    new Promise((resolve) => {
      if (!GDPR_REQUEST_RETENTION_DAYS) return resolve();
      const modifier = `-${GDPR_REQUEST_RETENTION_DAYS} day`;
      db.run(
        `DELETE FROM gdpr_requests WHERE created_at <= datetime('now', ?)`,
        [modifier],
        function onResult(err) {
          if (err) {
            console.error('Eroare la ștergerea cererilor GDPR vechi:', err.message);
          } else if (this.changes) {
            console.log(`Cererile GDPR șterse pe baza retenției: ${this.changes}`);
          }
          resolve();
        }
      );
    })
  ]);

db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      company TEXT,
      email TEXT NOT NULL,
      phone TEXT,
      message TEXT NOT NULL,
      consent INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      ip_address TEXT
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS gdpr_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      request_type TEXT NOT NULL,
      message TEXT NOT NULL,
      ip_address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  );
  purgeOldEntries();
});

const sanitizePlainText = (value = '') => {
  if (typeof value !== 'string') {
    value = String(value ?? '');
  }
  const trimmed = value.trim();
  const noTags = trimmed.replace(/<[^>]*>?/gm, '');
  const stripped = validator.stripLow(noTags, true);
  return xss(stripped, {
    whiteList: {},
    stripIgnoreTag: true,
    stripIgnoreTagBody: ['script', 'style']
  }).trim();
};

const toNullable = (value) => {
  const cleaned = sanitizePlainText(value);
  return cleaned.length ? cleaned : null;
};

const saveMessage = (payload) =>
  new Promise((resolve, reject) => {
    const stmt = `INSERT INTO contact_messages
      (full_name, company, email, phone, message, consent, ip_address)
      VALUES (?, ?, ?, ?, ?, ?, ?)`;

    db.run(
      stmt,
      [
        payload.fullName,
        payload.company,
        payload.email,
        payload.phone,
        payload.message,
        payload.consent,
        payload.ipAddress
      ],
      function onResult(err) {
        if (err) {
          return reject(err);
        }
        return resolve(this.lastID);
      }
    );
  });

const saveGdprRequest = (payload) =>
  new Promise((resolve, reject) => {
    const stmt = `INSERT INTO gdpr_requests
      (full_name, email, request_type, message, ip_address)
      VALUES (?, ?, ?, ?, ?)`;
    db.run(
      stmt,
      [payload.fullName, payload.email, payload.requestType, payload.message, payload.ipAddress],
      function onResult(err) {
        if (err) {
          return reject(err);
        }
        return resolve(this.lastID);
      }
    );
  });

const emailConfigComplete =
  process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER && process.env.SMTP_PASS;

let transporter = null;
if (emailConfigComplete) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  transporter
    .verify()
    .then(() => console.log('Server SMTP pregătit pentru trimiterea emailurilor.'))
    .catch((error) => {
      console.error('Nu s-a putut verifica transportul SMTP:', error.message);
      transporter = null;
    });
} else {
  console.warn('Config SMTP incomplet - completați variabilele din .env pentru a trimite emailurile.');
}

const sendNotificationEmail = async (payload, recordId) => {
  if (!transporter) {
    throw new Error('Transporter SMTP indisponibil.');
  }

  const lines = [
    'Ai primit un mesaj nou prin formularul de contact:',
    `ID mesaj: ${recordId}`,
    `Nume: ${payload.fullName}`,
    `Companie: ${payload.company || '-'}`,
    `Email: ${payload.email}`,
    `Telefon: ${payload.phone || '-'}`,
    `Consimțământ GDPR: ${payload.consent ? 'DA' : 'NU'}`,
    `IP: ${payload.ipAddress || '-'}\n`,
    'Mesaj:',
    payload.message
  ];

  const mailOptions = {
    from: `"Activ Cleaning Website" <${process.env.SMTP_USER}>`,
    to: CONTACT_RECIPIENT,
    subject: `Mesaj nou de pe site (#${recordId})`,
    text: lines.join('\n')
  };

  if (process.env.CONTACT_CC) {
    mailOptions.cc = process.env.CONTACT_CC;
  }

  if (process.env.CONTACT_BCC) {
    mailOptions.bcc = process.env.CONTACT_BCC;
  }

  return transporter.sendMail(mailOptions);
};

const sendGdprNotification = async (payload, recordId) => {
  if (!transporter) {
    throw new Error('Transporter SMTP indisponibil.');
  }
  const content = [
    'Ai primit o nouă cerere GDPR:',
    `ID cerere: ${recordId}`,
    `Nume: ${payload.fullName}`,
    `Email: ${payload.email}`,
    `Tip solicitare: ${payload.requestType}`,
    `IP: ${payload.ipAddress || '-'}`,
    '',
    'Mesaj:',
    payload.message
  ];

  return transporter.sendMail({
    from: `"Activ Cleaning Website" <${process.env.SMTP_USER}>`,
    to: PRIVACY_CONTACT,
    subject: `Cerere GDPR nouă (#${recordId})`,
    text: content.join('\n')
  });
};

app.post('/api/contact', async (req, res) => {
  try {
    const {
      fullName = '',
      company = '',
      email = '',
      phone = '',
      message = '',
      consent,
      honeypot = ''
    } = req.body || {};

    if (honeypot && honeypot.trim().length) {
      // Honeypot umplut => tratăm ca succes fals pentru boți.
      return res.status(200).json({ message: 'Mesajul a fost trimis.' });
    }

    const errors = {};
    if (!fullName || !fullName.trim()) {
      errors.fullName = 'Numele complet este obligatoriu.';
    }

    if (!email || !validator.isEmail(email.trim())) {
      errors.email = 'Te rugăm să introduci un email valid.';
    }

    if (!message || !message.trim()) {
      errors.message = 'Mesajul este obligatoriu.';
    } else if (message.length > 2000) {
      errors.message = 'Mesajul nu poate depăși 2000 de caractere.';
    }

    const consentValue =
      typeof consent === 'boolean'
        ? consent
        : consent === 'on' || consent === 'true' || consent === '1';

    if (!consentValue) {
      errors.consent = 'Avem nevoie de acordul tău pentru a prelucra datele.';
    }

    if (Object.keys(errors).length) {
      return res.status(400).json({ message: 'Validare eșuată', errors });
    }

    const sanitizedPayload = {
      fullName: sanitizePlainText(fullName),
      company: toNullable(company),
      email: email.trim().toLowerCase(),
      phone: toNullable(phone),
      message: sanitizePlainText(message).slice(0, 2000),
      consent: consentValue ? 1 : 0,
      ipAddress: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
    };

    const recordId = await saveMessage(sanitizedPayload);
    await sendNotificationEmail(sanitizedPayload, recordId);

    return res.status(200).json({
      message: 'Mesaj trimis cu succes. Îți mulțumim!',
      id: recordId
    });
  } catch (error) {
    console.error('Eroare trimitere formular:', error);
    if (error.message.includes('Transporter SMTP indisponibil')) {
      return res
        .status(503)
        .json({ message: 'Mesajul nu a putut fi trimis către emailul companiei. Reîncearcă în scurt timp.' });
    }
    return res.status(500).json({ message: 'Serverul nu a putut procesa cererea.' });
  }
});

app.post('/api/contact/gdpr-request', async (req, res) => {
  try {
    const { fullName = '', email = '', requestType = '', message = '' } = req.body || {};
    const errors = {};
    const allowedTypes = ['export', 'rectification', 'erasure', 'restriction'];

    if (!fullName || !fullName.trim()) {
      errors.fullName = 'Numele complet este obligatoriu.';
    }

    if (!email || !validator.isEmail(email.trim())) {
      errors.email = 'Adresa de email nu este validă.';
    }

    if (!allowedTypes.includes(requestType)) {
      errors.requestType = 'Tipul solicitării nu este suportat.';
    }

    if (!message || !message.trim()) {
      errors.message = 'Descrie solicitarea ta.';
    } else if (message.length > 2000) {
      errors.message = 'Mesajul nu poate depăși 2000 de caractere.';
    }

    if (Object.keys(errors).length) {
      return res.status(400).json({ message: 'Validare eșuată', errors });
    }

    const sanitizedPayload = {
      fullName: sanitizePlainText(fullName),
      email: email.trim().toLowerCase(),
      requestType,
      message: sanitizePlainText(message).slice(0, 2000),
      ipAddress: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
    };

    const recordId = await saveGdprRequest(sanitizedPayload);

    try {
      await sendGdprNotification(sanitizedPayload, recordId);
    } catch (error) {
      console.error('Eroare trimitere mail GDPR:', error.message);
    }

    return res.status(200).json({
      message: 'Cererea a fost înregistrată.',
      id: recordId
    });
  } catch (error) {
    console.error('Eroare cerere GDPR:', error);
    return res.status(500).json({ message: 'Serverul nu a putut procesa cererea GDPR.' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/privacy.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Handler pentru erorile de CORS.
app.use((err, req, res, next) => {
  if (err.message === 'Origine neautorizată') {
    return res.status(403).json({ message: 'Originea cererii nu este permisă.' });
  }
  return next(err);
});

const server = app.listen(PORT, () => {
  console.log(`Serverul rulează pe http://localhost:${PORT}`);
});

const gracefulShutdown = () => {
  console.info('Oprire server...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
