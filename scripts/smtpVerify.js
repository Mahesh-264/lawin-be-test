const path = require('path');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const getErrorDetails = (error) => ({
  name: error.name,
  message: error.message,
  code: error.code,
  responseCode: error.responseCode,
  command: error.command,
  response: error.response,
});

const runVerify = async (label, config) => {
  console.log(`[smtp-verify] ${label} config`, {
    host: config.host,
    service: config.service,
    port: config.port,
    secure: config.secure,
    user: config.auth?.user,
    passwordExists: Boolean(config.auth?.pass),
    passwordLength: String(config.auth?.pass || '').length,
  });

  try {
    await nodemailer.createTransport(config).verify();
    console.log(`[smtp-verify] ${label} succeeded`);
  } catch (error) {
    console.log(`[smtp-verify] ${label} failed`, getErrorDetails(error));
  }
};

const user = process.env.SMTP_USER || process.env.EMAIL_USER;
const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
const port = Number(process.env.SMTP_PORT || 587);

(async () => {
  await runVerify('host-port', {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await runVerify('gmail-service', {
    service: 'gmail',
    auth: { user, pass },
  });
})();
