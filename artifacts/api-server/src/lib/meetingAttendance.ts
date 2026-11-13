type Invitee = { email: string; names?: string[] };

function words(value: string): string[] {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function speakerName(value: string): string | undefined {
  const name = value.trim().replace(/\s+[-–—]\s+.*$|\s*\([^)]*\)\s*.*$/, "").trim();
  const parts = words(name);
  if (parts.length < 2 || parts.length > 6 || !/^[\p{L} .’'\-]+$/u.test(name) ||
    /^(?:unknown|speaker|participant|unidentified|phone|meeting|room)\b/i.test(name)) return;
  return name;
}

export function transcriptSpeakers(transcript: string): string[] {
  const speakers = new Map<string, string>();
  for (const cue of transcript.split(/\r?\n\s*\r?\n/)) {
    // Read speaker labels only inside timed cues. Names mentioned in prose
    // and untimed staff or dictation notes do not establish attendance.
    const time = cue.match(/^\s*(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->[^\r\n]*\r?\n([^\r\n]+)/m);
    if (!time) continue;
    const label = time[1].match(/^\s*<v\s+([^>]+)>\s*\S/i)?.[1] ??
      time[1].match(/^\s*([^:]{3,100}):\s*\S/)?.[1];
    const name = label && speakerName(label);
    if (name) speakers.set(words(name).join(" "), name);
  }
  return [...speakers.values()];
}

function matchScore(name: string, invitee: Invitee): number {
  const parts = words(name);
  const given = parts[0];
  const family = parts.at(-1)!;
  const names = (invitee.names ?? []).map(words).filter((parts) => parts.length >= 2);
  if (names.some((candidate) => candidate.join(" ") === parts.join(" "))) return 4;
  if (names.some((candidate) => candidate.at(-1) === family &&
    candidate[0].startsWith(given) && given.length >= 3)) return 3;
  const local = invitee.email.split("@")[0];
  const localWords = words(local);
  if (localWords.length === 2 && localWords[1] === family &&
    (localWords[0] === given || (given.length >= 3 && localWords[0].startsWith(given)))) return 2;
  const joined = localWords.join("");
  return joined === given + family || joined === given[0] + family ? 1 : 0;
}

export function matchTranscriptAttendance(speakers: string[], invitees: Invitee[]) {
  speakers = [...new Map(speakers.map((name) => [words(name).join(" "), name])).values()];
  const matches = speakers.map((name) => {
    const scored = invitees.map((invitee) => ({ email: invitee.email, score: matchScore(name, invitee) }))
      .sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    return best?.score && best.score !== second?.score ? best : null;
  });
  return speakers.map((name, index) => {
    const match = matches[index];
    const competing = match && matches.some((other, i) => i !== index &&
      other?.email === match.email && other.score >= match.score);
    return { name, email: match && !competing ? match.email : null };
  });
}
