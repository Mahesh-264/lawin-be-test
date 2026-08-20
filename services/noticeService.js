const { generateGroqText } = require("./groqService");
const { buildNoticePrompt, buildNoticeEditPrompt } = require("./noticePrompt");

const generateNoticeDraft = ({ documentType, basicInformation, lawyer }) =>
  generateGroqText({
    prompt: buildNoticePrompt({ documentType, basicInformation, lawyer }),
    temperature: 0.15,
  });

const editNoticeDraft = ({ documentType, currentDraft, editInstruction }) =>
  generateGroqText({
    prompt: buildNoticeEditPrompt({ documentType, currentDraft, editInstruction }),
    temperature: 0.1,
  });

module.exports = { generateNoticeDraft, editNoticeDraft };
