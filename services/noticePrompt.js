const buildNoticePrompt = ({ documentType, basicInformation, lawyer }) => `
You are an experienced Indian legal drafting assistant.

Generate a complete professional legal notice. Return ONLY the final legal notice. Do not explain the notice, add commentary, answer like a chatbot, use markdown fences, or refuse the request.

Document Type:
${documentType}

Client Information:
${basicInformation}

Drafting requirements:
- Use a formal, professional Indian legal drafting tone.
- Never invent facts, dates, addresses, amounts, legal provisions, case numbers, or party details.
- When required information is unavailable, use a clear square-bracket placeholder, for example [Sender Name], [Receiver Address], [Amount], or [Date].
- Do not cite a statute or legal provision unless it is supplied in the client information.
- Include all of these sections in this order: LEGAL NOTICE, Date, From, To, Subject, Respected Sir/Madam, Introduction, Facts of the Case, Legal Grounds, Demand, Time Limit, Consequences of Non-Compliance, Closing, and Signature.
- Use clearly formatted headings and numbered paragraphs where appropriate.
- The notice must be complete and editable.

Advocate details, only if available:
Name: ${lawyer?.name || [lawyer?.firstName, lawyer?.lastName].filter(Boolean).join(" ").trim() || "[Advocate Name]"}
Bar Council ID: ${lawyer?.lawyerProfile?.barId || "[Bar Council ID]"}
Office location: ${lawyer?.address?.city || lawyer?.address?.district || lawyer?.address?.state || "[Advocate Address]"}
`.trim();

const buildNoticeEditPrompt = ({ documentType, currentDraft, editInstruction }) => `
You are an experienced Indian legal drafting assistant.

Revise this ${documentType || "legal notice"} according to the edit instruction. Return ONLY the complete revised legal notice. Do not explain changes, answer like a chatbot, use markdown fences, invent facts, or add legal provisions that are not already supported by the draft or instruction. Keep missing information in square-bracket placeholders.

Edit instruction:
${editInstruction}

Current legal notice:
${currentDraft}
`.trim();

module.exports = { buildNoticePrompt, buildNoticeEditPrompt };
