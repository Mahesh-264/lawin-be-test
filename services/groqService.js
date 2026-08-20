const Groq = require("groq-sdk");

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const AI_TIMEOUT_MS = Number(process.env.GROQ_TIMEOUT_MS || 15000);

let groqClient;

const getGroqClient = () => {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is missing");
  }

  if (!groqClient) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }

  return groqClient;
};

const withTimeout = (promise, ms, label) => {
  let timeoutId;

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.code = "GROQ_TIMEOUT";
      reject(error);
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
};

const generateGroqText = async ({ prompt, temperature = 0.2, responseMimeType }) => {
  const request = {
    model: GROQ_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature,
  };

  if (responseMimeType === "application/json") {
    request.response_format = { type: "json_object" };
  }

  const completion = await withTimeout(
    getGroqClient().chat.completions.create(request),
    AI_TIMEOUT_MS,
    "Groq request"
  );

  const text = completion?.choices?.[0]?.message?.content;
  if (typeof text === "string" && text.trim()) return text.trim();

  throw new Error("Groq returned an empty response");
};

module.exports = { generateGroqText };
