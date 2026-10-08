const ROUTINE_SUBJECT = new RegExp(
  [
    "trading window",
    "loss of share certificate",
    "duplicate share certificate",
    "compliance certificate",
    "certificate under sebi \\(depositories",
    "regulation 74\\s*\\(5\\)",
    "copy of newspaper publication",
    "newspaper advertisement",
    "esop|esos|esps",
    "record date",
    "book closure",
    "transfer of shares to iepf|iepf",
    "statement of investor complaints|investor complaints",
    "reconciliation of share capital",
    "change in registrar|registrar and share transfer agent",
    "closure of trading window",
    "intimation of (?:schedule of )?analyst|schedule of analyst",
    "analysts/institutional investor meet",
    "shareholders meeting",
    "postal ballot",
    "voting results|scrutinizer",
    "annual secretarial compliance",
    "disclosure of related party transactions",
  ].join("|"),
  "i",
);

export function isRoutineAnnouncement(subject: string, details?: string | null): boolean {
  if (ROUTINE_SUBJECT.test(subject)) return true;
  return (
    subject.trim().toLowerCase() === "general updates" &&
    !!details &&
    ROUTINE_SUBJECT.test(details.slice(0, 300))
  );
}
