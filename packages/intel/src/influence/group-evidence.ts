export const GROUP_EVIDENCE_VERSION = 3;

export function groupDisclosure(text: string, name: string): { start: number; end: number } | null {
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const group = `\\b${words.join("\\s+")}\\b(?!['’]s\\b)`;
  const subject = `(?:we|(?:our|the|your)\\s+company)`;
  const affiliation = `(?:a\\s+)?(?:part|member)\\s+of\\s+(?:the\\s+)?${group}`;
  const pattern = new RegExp(
    [
      `\\b${subject}\\s*,?\\s*(?:is|are|being|remains?)\\s+${affiliation}`,
      `\\bwe(?:\\s*,\\s*at\\s+[^,.;!?]{1,80},)?\\s+feel\\s+proud\\s+to\\s+be\\s+${affiliation}`,
      `${affiliation}\\s*,\\s*${subject}\\b`,
      `\\b(?:as|being)\\s+${affiliation}\\s*,\\s*a\\s+[^.;!?]{1,180},\\s*${subject}\\b`,
      `\\b${subject}\\s+(?:is|are)\\s+(?:a|an)\\s+${group}\\s+company\\b`,
      `${group}\\s*[-–:]\\s*promoter\\s+group\\s+entity\\b`,
    ].join("|"),
    "gi",
  );
  for (const match of text.matchAll(pattern)) {
    const start = Math.max(0, match.index - 200);
    const end = Math.min(text.length, match.index + match[0].length + 300);
    return { start, end };
  }
  return null;
}
