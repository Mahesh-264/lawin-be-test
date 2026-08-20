const noticeService = require("../services/noticeService");

const getNoticeError = (error) => {
  const status = Number(error?.status || error?.statusCode || error?.code);
  const message = String(error?.message || "");

  if (error?.code === "GROQ_TIMEOUT" || /timed out/i.test(message)) {
    return { status: 504, message: "Notice generation timed out. Please try again." };
  }
  if (status === 429 || /rate limit|resource exhausted/i.test(message)) {
    return { status: 429, message: "Notice generation is temporarily rate limited. Please try again shortly." };
  }
  if (/network|fetch failed|econnreset|enotfound/i.test(message)) {
    return { status: 503, message: "Unable to reach the AI service. Please check your connection and try again." };
  }

  return { status: 502, message: "Unable to generate the notice draft at the moment. Please try again." };
};

exports.generateNoticeDraft = async (req, res) => {
  const documentType = String(req.body?.documentType || "").trim();
  const basicInformation = String(req.body?.details || req.body?.basicInformation || "").trim();

  if (!documentType) {
    return res.status(400).json({ message: "Document type is required" });
  }
  if (!basicInformation) {
    return res.status(400).json({ message: "Basic information is required" });
  }

  try {
    const draft = await noticeService.generateNoticeDraft({
      documentType,
      basicInformation,
      lawyer: req.user,
    });

    return res.json({ documentType, draft });
  } catch (error) {
    console.error("[Notice] generation failed:", error?.message || error);
    const noticeError = getNoticeError(error);
    return res.status(noticeError.status).json({ message: noticeError.message });
  }
};

exports.editNoticeDraft = async (req, res) => {
  const documentType = String(req.body?.documentType || "").trim();
  const currentDraft = String(req.body?.currentDraft || "").trim();
  const editInstruction = String(req.body?.editInstruction || "").trim();

  if (!currentDraft || !editInstruction) {
    return res.status(400).json({ message: "Current draft and edit instruction are required" });
  }

  try {
    const draft = await noticeService.editNoticeDraft({ documentType, currentDraft, editInstruction });
    return res.json({ documentType, draft });
  } catch (error) {
    console.error("[Notice] edit failed:", error?.message || error);
    const noticeError = getNoticeError(error);
    return res.status(noticeError.status).json({ message: noticeError.message });
  }
};
