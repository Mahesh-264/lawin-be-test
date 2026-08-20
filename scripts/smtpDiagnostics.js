const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '..', '.env');
const result = dotenv.config({ path: envPath });
const raw = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

const getRawValue = (name) => {
  const line = raw.split(/\n/).find((entry) => new RegExp(`^${name}\\s*=`).test(entry));
  if (!line) return '';
  return line.slice(line.indexOf('=') + 1).replace(/\r$/, '');
};

const getDiagnostics = (value) => {
  const text = String(value || '');

  return {
    exists: text.length > 0,
    length: text.length,
    trimmedLength: text.trim().length,
    hasLeadingWhitespace: /^\s/.test(text),
    hasTrailingWhitespace: /\s$/.test(text),
    containsWhitespace: /\s/.test(text),
    containsNewline: /[\r\n]/.test(text),
    startsWithQuote: /^['"]/.test(text),
    endsWithQuote: /['"]$/.test(text),
  };
};

console.log({
  cwd: process.cwd(),
  envPath,
  loaded: !result.error,
  error: result.error?.message,
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS_parsed: getDiagnostics(process.env.SMTP_PASS),
  SMTP_PASS_rawLine: getDiagnostics(getRawValue('SMTP_PASS')),
  EMAIL_USER_exists: Boolean(process.env.EMAIL_USER),
  EMAIL_PASS_parsed: getDiagnostics(process.env.EMAIL_PASS),
  EMAIL_PASS_rawLine: getDiagnostics(getRawValue('EMAIL_PASS')),
});
