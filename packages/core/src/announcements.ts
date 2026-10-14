const pattern = (source: string) => new RegExp(source, "i");

export const MATERIAL_EVENT_PATTERNS = {
  restructuring: pattern(
    "merger|amalgamation|demerger|scheme of arrangement|acquisition|acquire|takeover|open offer|slump sale|divest|disinvest|sale of (?:stake|business|undertaking|shares)|transfer of (?:business|undertaking)|joint venture|delisting",
  ),
  capital: pattern(
    "buy-?back|rights issue|preferential (?:issue|allotment)|qualified institutions? placement|\\bqip\\b|fund ?raising|raising of funds|bonus|sub-?division|stock split|split of shares|reduction of (?:share )?capital",
  ),
  materialRpt: pattern("material related party"),
  distress: pattern(
    "insolvency|\\bnclt\\b|\\bibc\\b|winding up|default|fraud|forensic|search and seizure|raid",
  ),
  leadership: pattern("resignation|cessation"),
  orderWin: pattern(
    "order (?:win|received|worth)|award of (?:contract|order)|letter of award|bagging|receiving of orders|receipt of (?:an? |the )?(?:order|contract)|work order",
  ),
} as const;

export const ROUTINE_ANNOUNCEMENT_PATTERNS = {
  tradingWindow: pattern("trading window"),
  lossOfShareCertificate: pattern("loss of share certificate"),
  duplicateShareCertificate: pattern("duplicate share certificate"),
  complianceCertificate: pattern(
    "compliance certificate|certificate under sebi \\(depositories|reg(?:ulation|\\.)?\\s*(?:7\\s*\\(3\\)|40\\s*\\(9\\)|74\\s*\\(5\\))",
  ),
  newspaperPublication: pattern(
    "copy of newspaper publication|newspaper (?:advertisement|publication)",
  ),
  esop: pattern("esop|esos|esps"),
  recordDate: pattern("record date|book closure"),
  iepf: pattern("iepf"),
  investorComplaints: pattern("investor complaints"),
  shareCapitalReconciliation: pattern("reconciliation of share capital"),
  registrar: pattern("change in registrar|registrar and share transfer agent"),
  analystMeet: pattern(
    "intimation of (?:schedule of )?analyst|schedule of analyst|analysts/institutional investor meet",
  ),
  votingResults: pattern("voting results|scrutini[sz]er"),
  secretarialCompliance: pattern("annual secretarial compliance"),
  periodicRpt: pattern("disclosure of related party transactions for the (?:half|six months)"),
} as const;

const MATERIAL_EVENT = new RegExp(
  Object.values(MATERIAL_EVENT_PATTERNS)
    .map((p) => p.source)
    .join("|"),
  "i",
);

const ROUTINE_SUBJECT = new RegExp(
  Object.values(ROUTINE_ANNOUNCEMENT_PATTERNS)
    .map((p) => p.source)
    .join("|"),
  "i",
);

export function isMaterialAnnouncement(subject: string, details?: string | null): boolean {
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
