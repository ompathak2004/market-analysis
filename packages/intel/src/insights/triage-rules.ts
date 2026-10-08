const MATERIAL_EVENT = new RegExp(
  [
    "merger",
    "amalgamation",
    "demerger",
    "scheme of arrangement",
    "acquisition",
    "acquire",
    "takeover",
    "open offer",
    "slump sale",
    "divest",
    "disinvest",
    "sale of (?:stake|business|undertaking|shares)",
    "transfer of (?:business|undertaking)",
    "joint venture",
    "delisting",
    "buy-?back",
    "rights issue",
    "preferential (?:issue|allotment)",
    "qualified institutions? placement|\\bqip\\b",
    "fund ?raising|raising of funds",
    "bonus",
    "sub-?division|stock split|split of shares",
    "reduction of (?:share )?capital",
    "material related party",
    "insolvency|\\bnclt\\b|\\bibc\\b|winding up|default",
    "fraud|forensic|search and seizure|raid",
    "resignation|cessation",
    "order (?:win|received|worth)|award of (?:contract|order)|letter of award",
  ].join("|"),
  "i",
);

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
    "voting results|scrutinizer",
    "annual secretarial compliance",
    "disclosure of related party transactions for the (?:half|six months)",
  ].join("|"),
  "i",
);

function isMaterialAnnouncement(subject: string, details?: string | null): boolean {
  return MATERIAL_EVENT.test(subject) || (!!details && MATERIAL_EVENT.test(details.slice(0, 600)));
}

export function isRoutineAnnouncement(subject: string, details?: string | null): boolean {
  if (isMaterialAnnouncement(subject, details)) return false;
  if (ROUTINE_SUBJECT.test(subject)) return true;
  return (
    subject.trim().toLowerCase() === "general updates" &&
    !!details &&
    ROUTINE_SUBJECT.test(details.slice(0, 300))
  );
}
