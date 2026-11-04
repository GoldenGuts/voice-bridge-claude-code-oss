// Small text helpers. Everything a tool returns is read aloud, so it must be short and plain.

/** Sessions end each turn with "VOICE: ..."; split that line from the rest of the answer. */
export function extractVoice(result: string): { voice: string; body: string } {
  const lines = result.trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
    const m = lines[i].match(/^\s*\**VOICE:?\**:?\s*(.+)$/i);
    if (m) {
      const body = [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim();
      return { voice: m[1].replace(/\*+$/, "").trim(), body };
    }
  }
  const ask = findAsk(result);
  const head = firstSentences(result, 220);
  return { voice: ask && !head.includes(ask) ? `${head} Needs from you: ${ask}` : head, body: result.trim() };
}

/** The first sentence or two, without markdown, at most `max` characters. */
export function firstSentences(text: string, max = 220): string {
  const plain = speakable(text);
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > max / 3 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + "…";
}

/** Strip what sounds bad when spoken: code blocks, markdown marks, links, long paths. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]{1,40})`/g, "$1")
    .replace(/`[^`]*`/g, " (code) ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/(?:\/[\w.-]+){3,}\/?/g, (p) => p.split("/").filter(Boolean).pop() ?? p)
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*|__|\*|\|/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** A short session title from the task: the first words, cut at a word, no trailing dots. */
export function titleOf(task: string, max = 48): string {
  const plain = speakable(task).split(/(?<=[.!?])\s/)[0].replace(/[.!?,;:]+$/, "");
  if (plain.length <= max) return plain;
  return plain.slice(0, max).replace(/\s+\S*$/, "");
}

// Only headings that put something on the user ("Decision for you"), not ones about Claude ("Decisions I made", "Next steps").
const ASK_HEADING = /^(?:#{1,4}\s*|\*\*)\s*(?:decisions? (?:for you|needed|to make|you need)|needs? from you|what i need(?: from you)?|your (?:call|decision|turn|move)|next steps? for you|open questions?|questions? for you|action items? for you|to do for you)\b[^\n]*$/im;
const ASK_CLOSING = /^(?:tell me|let me know|want me|should i|shall i|do you want|can you|could you|please (?:confirm|choose|pick|decide|approve))\b/i;

/**
 * What a session needs from the user, from its last answer, when it has no wrap_up or VOICE line:
 * a "Decision for you" style section, else its last question near the end, else a closing "Tell me…".
 */
export function findAsk(text: string): string | undefined {
  const heading = text.match(ASK_HEADING);
  if (heading && heading.index !== undefined) {
    // Text on the heading line itself after a bold label ("**Decision for you:** …"), then the section body.
    const inline = heading[0].replace(/^(?:#{1,4}\s*|\*\*)[^:*]*[:*]+\s*\**\s*/, "").trim();
    const rest = text.slice(heading.index + heading[0].length).split(/\n#{1,4}\s/)[0];
    const body = speakable(`${heading[0].startsWith("**") ? inline : ""} ${rest}`);
    if (body) {
      const q = body.split(/(?<=[.!?])\s+/).find((s) => s.endsWith("?"));
      if (q) return firstSentences(q, 160);
      // No question in the section (a list of open items): say what the section is, then its start.
      const label = speakable(heading[0]).replace(/[:*\s]+$/, "").split(":")[0];
      return firstSentences(`${label}: ${body}`, 160);
    }
  }
  const end = speakable(text.slice(-1200));
  const sentences = end.split(/(?<=[.!?])\s+/);
  const question = [...sentences].reverse().find((s) => s.endsWith("?") && s.length > 8);
  if (question) return firstSentences(question, 160);
  const last = sentences[sentences.length - 1] ?? "";
  return ASK_CLOSING.test(last) ? firstSentences(last, 160) : undefined;
}
