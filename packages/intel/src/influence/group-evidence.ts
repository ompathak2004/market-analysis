export const GROUP_EVIDENCE_VERSION = 2;

export function groupDisclosure(text: string, name: string): { start: number; end: number } | null {
  const words = name
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const group = `\\b${words.join("\\s+")}\\b`;
  const pattern = new RegExp(
    `(?:part|member)\\s+of\\s+(?:the\\s+)?${group}|(?:a|an)\\s+${group}\\s+company|${group}\\s*[-–:]\\s*promoter\\s+group\\s+entity`,
    "gi",
  );
  for (const match of text.matchAll(pattern)) {
    const start = Math.max(0, match.index - 200);
    const end = Math.min(text.length, match.index + match[0].length + 300);
    const quote = text.slice(start, end);
    if (
      /\b(?:we|our company|the company|your company)\b/i.test(quote) ||
      /promoter\s+group\s+entity/i.test(match[0])
    ) {
      return { start, end };
    }
  }
  return null;
}
