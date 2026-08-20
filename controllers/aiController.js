const User = require("../models/User");
const { generateGroqText } = require("../services/groqService");

const VALID_CATEGORIES = [
  "criminal",
  "property",
  "family",
  "corporate",
  "cyber",
  "employment",
  "other",
];

const FALLBACK_REPLY =
  "I'm having trouble understanding your request right now. Please try again or consult a lawyer directly.";
const NON_LEGAL_REPLY =
  "I can help with questions related to law, including legal sections, Acts, rights, contracts, property, family matters, criminal law, cyber fraud, employment, and court procedures.";

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const AI_MAX_RETRIES = 1;

const CATEGORY_ALIASES = {
  criminal: ["criminal", "crime", "ipc", "bail", "fir"],
  property: ["property", "civil", "land", "tenant", "rent", "real estate"],
  family: ["family", "divorce", "marriage", "custody", "maintenance"],
  corporate: ["corporate", "business", "company", "startup", "contract"],
  cyber: ["cyber", "fraud", "online scam", "digital", "data privacy"],
  employment: ["employment", "labour", "labor", "job", "workplace", "salary"],
  other: ["other"],
};

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeCategory = (category = "") => {
  const normalized = String(category).trim().toLowerCase();

  const mapping = {
    civil: "property",
    labour: "employment",
    labor: "employment",
    "labour law": "employment",
    "labor law": "employment",
    business: "corporate",
    company: "corporate",
    startup: "corporate",
    matrimonial: "family",
    marriage: "family",
    divorce: "family",
    tenancy: "property",
    tenant: "property",
    rent: "property",
    scam: "cyber",
    fraud: "cyber",
  };

  const mapped = mapping[normalized] || normalized;
  return VALID_CATEGORIES.includes(mapped) ? mapped : "other";
};

const isLegalRelatedQuery = (text = "") => {
  const msg = String(text).toLowerCase();

  return /(law|legal|lawyer|advocate|attorney|court|judge|case|petition|notice|agreement|contract|clause|rights|liability|sue|lawsuit|complaint|fir|police|arrest|bail|crime|criminal|theft|assault|cheating|forgery|property|land|tenant|rent|lease|eviction|divorce|marriage|custody|maintenance|alimony|domestic violence|company|business|startup|shareholder|director|compliance|employment|employee|employer|salary|termination|wages|labour|labor|harassment|cyber|fraud|scam|phishing|upi|otp|data privacy|will|inheritance|consumer|trademark|copyright|patent|tax|gst|document|deed|affidavit|notary|legal notice|dispute|settlement|appeal|tribunal|arbitration|mediation|section\s*\d+|section|act\b|code\b|article\s*\d*|constitution|statute|bare act|penal code|procedure code|ipc|bns|bnss|crpc|cpc)/i.test(
    msg
  );
};

const detectCategoryFromText = (text = "") => {
  const msg = String(text).toLowerCase();

  if (
    /(murder|theft|police|arrest|fir|crime|assault|bail|cheating|kidnap|violence|forgery|dowry harassment|domestic violence criminal)/i.test(
      msg
    )
  ) {
    return "criminal";
  }

  if (
    /(land|property|rent|tenant|owner|house|flat|builder|sale deed|partition|encroachment|lease|eviction|mutation|registry|real estate|civil)/i.test(
      msg
    )
  ) {
    return "property";
  }

  if (
    /(divorce|marriage|custody|family|alimony|maintenance|domestic violence|matrimonial|child support|adoption)/i.test(
      msg
    )
  ) {
    return "family";
  }

  if (
    /(company|business|startup|contract|shareholder|director|compliance|incorporation|vendor agreement|llp|mou|board|corporate)/i.test(
      msg
    )
  ) {
    return "corporate";
  }

  if (
    /(hack|hacked|fraud|scam|online|cyber|phishing|otp|identity theft|data breach|social media|upi fraud|digital arrest)/i.test(
      msg
    )
  ) {
    return "cyber";
  }

  if (
    /(job|salary|employee|employer|fired|termination|work|office|wages|pf|gratuity|harassment at work|labour|labor|employment)/i.test(
      msg
    )
  ) {
    return "employment";
  }

  return "other";
};

const extractJsonObject = (value = "") => {
  const trimmed = String(value).trim();

  if (!trimmed) {
    throw new Error("Empty AI response");
  }

  const cleaned = trimmed
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (parseError) {
    const first = cleaned.indexOf("{");
    const last = cleaned.lastIndexOf("}");

    if (first !== -1 && last !== -1 && first < last) {
      return JSON.parse(cleaned.slice(first, last + 1));
    }

    throw new Error(`Invalid JSON from AI: ${cleaned.slice(0, 500)}`);
  }
};

const sanitizeReply = (reply = "") => {
  const text = String(reply).replace(/\s+/g, " ").trim();
  return text || FALLBACK_REPLY;
};

const buildPrompt = (message) => `
You are Lawin AI, a legal assistant for an Indian legal platform.

Your job:
1. Answer all questions related to law, including questions about legal sections, Acts, codes, statutes, rights, and court procedures.
2. Give a short, simple, practical answer in plain English.
3. Classify the issue into exactly one category:
criminal, property, family, corporate, cyber, employment, other

Rules:
- If the user asks about anything unrelated to law or legal rights, set "reply" to: "${NON_LEGAL_REPLY}"
- For non-legal questions, set "category" to "other".
- Return ONLY valid JSON.
- Do not use markdown.
- Do not wrap the response in backticks.
- Do not include any text before or after the JSON.
- "reply" must be a concise helpful explanation for a normal user.
- "category" must be exactly one of:
  criminal, property, family, corporate, cyber, employment, other
- If unsure, use "other".

Return exactly this schema:
{"reply":"string","category":"criminal|property|family|corporate|cyber|employment|other"}

User legal question:
${message}
`.trim();

const buildLawyerRegex = (category) => {
  const aliases = CATEGORY_ALIASES[category] || [category];
  return new RegExp(aliases.map(escapeRegex).join("|"), "i");
};

const fetchSuggestedLawyers = async (category) => {
  if (category === "other") {
    return [];
  }

  const regex = buildLawyerRegex(category);

  const lawyers = await User.find({
    role: { $in: ["lawyer", "LAWYER"] },
    "lawyerProfile.specialization": regex,
  })
    .select("firstName lastName lawyerProfile.specialization profileImage")
    .limit(3)
    .lean({ virtuals: true });

  return lawyers.map((lawyer) => ({
    _id: lawyer._id,
    name:
      lawyer.name ||
      [lawyer.firstName, lawyer.lastName].filter(Boolean).join(" ").trim() ||
      "Lawyer",
    specialization: lawyer.lawyerProfile?.specialization || category,
    profileImage: lawyer.profileImage || "",
  }));
};

const callAIOnce = async (message) => {
  const rawText = await generateGroqText({
    prompt: buildPrompt(message),
    temperature: 0.1,
    responseMimeType: "application/json",
  });
  const parsed = extractJsonObject(rawText);

  return {
    rawText,
    parsed,
  };
};

const getAICompletion = async (message) => {
  let lastError;

  for (let attempt = 0; attempt <= AI_MAX_RETRIES; attempt += 1) {
    try {
      console.log(
        `[AI] Groq attempt ${attempt + 1}/${AI_MAX_RETRIES + 1} using model ${GROQ_MODEL}`
      );

      const result = await callAIOnce(message);

      console.log("[AI] Groq raw response:", result.rawText);

      return result.parsed;
    } catch (error) {
      lastError = error;
      console.error(
        `[AI] Groq attempt ${attempt + 1} failed:`,
        error?.message || error
      );

      if (attempt < AI_MAX_RETRIES) {
        await delay(400);
      }
    }
  }

  throw lastError;
};

exports.chatWithAI = async (req, res) => {
  const incomingMessage = String(req.body?.message || "").trim();

  if (!incomingMessage) {
    return res.status(400).json({ message: "Message is required" });
  }

  console.log("[AI] Incoming legal query:", incomingMessage);

  try {
    if (!isLegalRelatedQuery(incomingMessage)) {
      console.log("[AI] Rejected non-legal query");

      return res.status(200).json({
        reply: NON_LEGAL_REPLY,
        category: "other",
        lawyers: [],
      });
    }

    let reply = FALLBACK_REPLY;
    let category = "other";
    let aiUsed = false;

    try {
      const parsed = await getAICompletion(incomingMessage);

      reply = sanitizeReply(parsed?.reply);
      category = normalizeCategory(parsed?.category);
      aiUsed = true;

      if (category === "other") {
        const detected = detectCategoryFromText(incomingMessage);
        if (detected !== "other") {
          console.warn(
            `[AI] AI returned "other". Keyword fallback upgraded category to "${detected}".`
          );
          category = detected;
        }
      }
    } catch (aiError) {
      console.error("[AI] Final Groq failure:", aiError?.message || aiError);
      category = detectCategoryFromText(incomingMessage);
      console.warn(`[AI] Using fallback keyword category: ${category}`);
    }

    const lawyers = await fetchSuggestedLawyers(category);

    console.log("[AI] Final response meta:", {
      aiUsed,
      category,
      lawyersFound: lawyers.length,
    });

    return res.status(200).json({
      reply,
      category,
      lawyers,
    });
  } catch (error) {
    console.error("[AI] chatWithAI controller failure:", error?.stack || error);

    return res.status(200).json({
      reply: FALLBACK_REPLY,
      category: "other",
      lawyers: [],
    });
  }
};

