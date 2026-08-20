let nodemailer;

try {
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const isSmtpDebugEnabled = () => process.env.SMTP_DEBUG === 'true' || process.env.NODE_ENV !== 'production';

const getSecretDiagnostics = (value) => {
  const raw = String(value ?? '');

  return {
    exists: raw.length > 0,
    length: raw.length,
    trimmedLength: raw.trim().length,
    hasLeadingWhitespace: /^\s/.test(raw),
    hasTrailingWhitespace: /\s$/.test(raw),
    containsWhitespace: /\s/.test(raw),
    containsNewline: /[\r\n]/.test(raw),
    startsWithQuote: /^['"]/.test(raw),
    endsWithQuote: /['"]$/.test(raw),
  };
};

const getSmtpDiagnostics = (transportConfig) => ({
  cwd: process.cwd(),
  nodeEnv: process.env.NODE_ENV || '',
  host: transportConfig?.host || '',
  service: transportConfig?.service || '',
  port: transportConfig?.port || '',
  secure: Boolean(transportConfig?.secure),
  user: transportConfig?.auth?.user || '',
  password: getSecretDiagnostics(transportConfig?.auth?.pass),
  envPresence: {
    SMTP_HOST: Boolean(process.env.SMTP_HOST),
    SMTP_PORT: Boolean(process.env.SMTP_PORT),
    SMTP_USER: Boolean(process.env.SMTP_USER),
    SMTP_PASS: Boolean(process.env.SMTP_PASS),
    EMAIL_USER: Boolean(process.env.EMAIL_USER),
    EMAIL_PASS: Boolean(process.env.EMAIL_PASS),
  },
  envLengths: {
    SMTP_USER: String(process.env.SMTP_USER || '').length,
    SMTP_PASS: String(process.env.SMTP_PASS || '').length,
    EMAIL_USER: String(process.env.EMAIL_USER || '').length,
    EMAIL_PASS: String(process.env.EMAIL_PASS || '').length,
  },
});

const getNodemailerErrorDetails = (error) => ({
  name: error.name,
  message: error.message,
  code: error.code,
  responseCode: error.responseCode,
  command: error.command,
  response: error.response,
});

const logSmtpDebug = (label, details) => {
  if (!isSmtpDebugEnabled()) return;
  console.log(`[smtp] ${label}:`, details);
};

const getTransportConfig = () => {
  const host = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const port = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 587);
  const user = process.env.SMTP_USER || process.env.EMAIL_USER;
  const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;
  const service = process.env.SMTP_SERVICE || process.env.EMAIL_SERVICE;

  if ((!host && !service) || !user || !pass) return null;

  if (service) {
    return {
      service,
      auth: { user, pass },
    };
  }

  return {
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  };
};

const buildOtpEmail = ({ otp, firstName, purpose = 'verify your email' }) => ({
  subject: 'Your Verdits verification code',
  html: `
    <div style="margin:0;padding:0;background:#f3f8fb;font-family:Arial,sans-serif;color:#062552;">
      <div style="max-width:560px;margin:0 auto;padding:32px 18px;">
        <div style="background:#ffffff;border:1px solid #d7e9ef;border-radius:18px;padding:28px;box-shadow:0 18px 45px rgba(6,37,82,0.08);">
          <h1 style="margin:0 0 12px;font-size:24px;color:#062552;">Verdits verification</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#5f7488;">
            Hi ${escapeHtml(firstName || 'there')}, use this code to ${escapeHtml(purpose)}. It expires in 5 minutes.
          </p>
          <div style="letter-spacing:8px;font-size:34px;font-weight:800;color:#15a276;background:#f7fbfc;border:1px solid #d7e9ef;border-radius:14px;padding:18px;text-align:center;">
            ${escapeHtml(otp)}
          </div>
          <p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#5f7488;">
            If you did not request this, you can safely ignore this email.
          </p>
        </div>
      </div>
    </div>
  `,
});

const sendOtpEmail = async ({ to, otp, firstName, purpose }) => {
  const transportConfig = getTransportConfig();
  const isProduction = process.env.NODE_ENV === 'production';

  logSmtpDebug('configuration', getSmtpDiagnostics(transportConfig));

  if (!transportConfig || !nodemailer) {
    if (isProduction) {
      throw new Error('SMTP configuration is required to send verification emails');
    }
    console.log(`Email OTP for ${to}: ${otp}`);
    return;
  }

  const transporter = nodemailer.createTransport(transportConfig);
  const from = process.env.EMAIL_FROM || process.env.SMTP_FROM || transportConfig.auth.user;
  const email = buildOtpEmail({ otp, firstName, purpose });

  try {
    try {
      await transporter.verify();
      logSmtpDebug('verify succeeded', {
        user: transportConfig.auth.user,
        host: transportConfig.host || transportConfig.service,
      });
    } catch (error) {
      logSmtpDebug('verify failed', getNodemailerErrorDetails(error));
      throw error;
    }

    await transporter.sendMail({
      from,
      to,
      subject: email.subject,
      html: email.html,
    });
    logSmtpDebug('sendMail succeeded', { to, from });
  } catch (error) {
    if (isProduction) {
      throw error;
    }

    console.warn(`Email delivery failed for ${to}: ${error.message}`);
    console.warn('[smtp] nodemailer error:', getNodemailerErrorDetails(error));
    console.log(`Email OTP for ${to}: ${otp}`);
  }
};

module.exports = { sendOtpEmail };
