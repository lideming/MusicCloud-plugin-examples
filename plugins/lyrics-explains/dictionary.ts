const JMDICT_URL =
  "https://cdn.jsdelivr.net/gh/lideming/MusicCloud-plugin-examples@master/plugins/lyrics-explains/data/jmdict-eng-common.json";
const KUROMOJI_SCRIPT_URL =
  "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js";
const KUROMOJI_DICTIONARY_URL =
  "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";

const MAX_SCAN_LENGTH = 18;
const MAX_DICTIONARY_REFERENCES = 60;
const MAX_REFERENCE_CHARACTERS = 10000;

type CompactForm = [text: string, common: 0 | 1];
type CompactSense = [partOfSpeech: string[], glosses: string[]];
type CompactEntry = [
  id: string,
  kanji: CompactForm[],
  kana: CompactForm[],
  senses: CompactSense[],
];

interface CompactDictionaryData {
  format: number;
  source: {
    dictionaryDate: string;
    attribution: string;
    license: string;
  };
  partOfSpeech: Record<string, string>;
  lookup: Record<string, number[]>;
  entries: CompactEntry[];
}

interface KuromojiToken {
  surface_form: string;
  basic_form?: string;
  reading?: string;
  pos?: string;
  pos_detail_1?: string;
}

interface Candidate {
  entryIndex: number;
  score: number;
  lines: Set<number>;
  matches: Set<string>;
}

function toHiragana(text: string): string {
  return text.replace(/[ァ-ヶ]/g, character =>
    String.fromCharCode(character.charCodeAt(0) - 0x60),
  );
}

function normalizeLookupText(text: string): string {
  return toHiragana(text.normalize("NFKC")).toLowerCase();
}

function containsKanji(text: string): boolean {
  return /[々〆ヶ一-龯]/.test(text);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

class RuntimeDictionary {
  constructor(readonly data: CompactDictionaryData) {}

  private isCommonForm(entryIndex: number, form: string): boolean {
    const normalized = normalizeLookupText(form);
    const entry = this.data.entries[entryIndex];
    return [...entry[1], ...entry[2]].some(
      ([entryForm, common]) =>
        common === 1 && normalizeLookupText(entryForm) === normalized,
    );
  }

  private matchesReading(entryIndex: number, reading: string): boolean {
    const normalized = normalizeLookupText(reading);
    return this.data.entries[entryIndex][2].some(
      ([entryReading]) => normalizeLookupText(entryReading) === normalized,
    );
  }

  private matchesPartOfSpeech(entryIndex: number, token: KuromojiToken): boolean {
    if (!token.pos) return true;
    const dictionaryPos = new Set(
      this.data.entries[entryIndex][3].flatMap(([partOfSpeech]) => partOfSpeech),
    );
    const has = (...values: string[]) => values.some(value => dictionaryPos.has(value));
    const hasPrefix = (...prefixes: string[]) =>
      [...dictionaryPos].some(value => prefixes.some(prefix => value.startsWith(prefix)));

    if (token.pos === "動詞") return hasPrefix("v") || has("vs", "vk", "vz");
    if (token.pos === "形容詞") return hasPrefix("adj-i", "adj-ix");
    if (token.pos === "形状詞" || token.pos_detail_1 === "形容動詞語幹") {
      return has("adj-na", "adj-t", "adj-nari");
    }
    if (token.pos === "副詞") return hasPrefix("adv");
    if (token.pos === "助詞") return has("prt");
    if (token.pos === "助動詞") return hasPrefix("aux") || has("cop");
    if (token.pos === "接続詞") return has("conj");
    if (token.pos === "連体詞") return has("adj-pn");
    if (token.pos === "感動詞") return has("int");
    if (token.pos === "接頭詞") return has("pref", "n-pref");
    if (token.pos === "名詞") {
      if (token.pos_detail_1 === "接尾") return has("suf", "n-suf");
      return hasPrefix("n") || has("vs", "pron", "num", "ctr");
    }
    return true;
  }

  private addCandidate(
    candidates: Map<number, Candidate>,
    entryIndex: number,
    score: number,
    line: number,
    matchedForm: string,
    lookupForm: string,
  ) {
    const commonBonus = this.isCommonForm(entryIndex, lookupForm) ? 12 : 0;
    let candidate = candidates.get(entryIndex);
    if (!candidate) {
      candidate = {
        entryIndex,
        score: score + commonBonus,
        lines: new Set(),
        matches: new Set(),
      };
      candidates.set(entryIndex, candidate);
    } else {
      candidate.score = Math.max(candidate.score, score + commonBonus);
    }
    candidate.lines.add(line);
    if (matchedForm) candidate.matches.add(matchedForm);
  }

  private addExactMatches(
    candidates: Map<number, Candidate>,
    lookupForm: string | undefined,
    matchedForm: string,
    score: number,
    line: number,
    token?: KuromojiToken,
    matchReading = false,
  ): number {
    if (!lookupForm || lookupForm === "*") return 0;
    const normalized = normalizeLookupText(lookupForm);
    let entries = this.data.lookup[normalized];
    if (!entries) return 0;
    if (matchReading && token?.reading) {
      const readingMatches = entries.filter(entryIndex =>
        this.matchesReading(entryIndex, token.reading!),
      );
      if (readingMatches.length) entries = readingMatches;
    }
    if (token?.pos) {
      const posMatches = entries.filter(entryIndex =>
        this.matchesPartOfSpeech(entryIndex, token),
      );
      if (posMatches.length) entries = posMatches;
    }
    entries = [...entries].sort(
      (left, right) =>
        Number(this.isCommonForm(right, lookupForm)) -
        Number(this.isCommonForm(left, lookupForm)),
    );
    for (const entryIndex of entries.slice(0, 12)) {
      this.addCandidate(
        candidates,
        entryIndex,
        score,
        line,
        matchedForm,
        lookupForm,
      );
    }
    return Math.min(entries.length, 12);
  }

  findCandidates(
    lines: string[],
    tokenizedLines: KuromojiToken[][] | null,
  ): Candidate[] {
    const candidates = new Map<number, Candidate>();

    lines.forEach((lineText, lineNumber) => {
      const normalizedLine = normalizeLookupText(lineText);
      for (let start = 0; start < normalizedLine.length; start++) {
        const limit = Math.min(normalizedLine.length, start + MAX_SCAN_LENGTH);
        for (let end = start; end < limit; end++) {
          const matchedForm = normalizedLine.slice(start, end + 1);
          const matchedEntries = this.data.lookup[matchedForm];
          if (!matchedEntries) continue;
          const length = end - start + 1;
          if (length === 1 && !containsKanji(matchedForm)) continue;
          const score = 25 + length * 6 + (containsKanji(matchedForm) ? 8 : 0);
          // Kuromoji handles short words with reading/POS disambiguation. Keep the
          // raw substring pass for longer compounds that the tokenizer may have split.
          if (tokenizedLines && score < 45) continue;
          for (const entryIndex of matchedEntries.slice(0, 12)) {
            this.addCandidate(
              candidates,
              entryIndex,
              score,
              lineNumber,
              matchedForm,
              matchedForm,
            );
          }
        }
      }

      const tokens = tokenizedLines?.[lineNumber];
      if (tokens) {
        for (const token of tokens) {
          const surface = token.surface_form;
          let directMatches = this.addExactMatches(
            candidates,
            surface,
            surface,
            90,
            lineNumber,
            token,
            true,
          );
          if (token.basic_form && token.basic_form !== surface) {
            directMatches += this.addExactMatches(
              candidates,
              token.basic_form,
              surface,
              115,
              lineNumber,
              token,
            );
          }
          if (!directMatches && token.reading) {
            this.addExactMatches(
              candidates,
              token.reading,
              surface,
              65,
              lineNumber,
              token,
              true,
            );
          }
        }
      }
    });

    return [...candidates.values()]
      .map(candidate => ({
        ...candidate,
        score: candidate.score + Math.min(candidate.lines.size, 6) * 3,
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, MAX_DICTIONARY_REFERENCES);
  }

  formatCandidate(candidate: Candidate): string {
    const entry = this.data.entries[candidate.entryIndex];
    const preferredKanji = entry[1].find(([, common]) => common)?.[0] || entry[1][0]?.[0];
    const preferredKana = entry[2].find(([, common]) => common)?.[0] || entry[2][0]?.[0];
    const headword = preferredKanji || preferredKana || "";

    const meanings: string[] = [];
    const partOfSpeech = new Set<string>();
    for (const [pos, glosses] of entry[3]) {
      pos.forEach(value => partOfSpeech.add(value));
      for (const gloss of glosses) {
        if (!meanings.includes(gloss)) meanings.push(gloss);
        if (meanings.length >= 6) break;
      }
      if (meanings.length >= 6) break;
    }

    const posDescriptions = [...partOfSpeech]
      .slice(0, 3)
      .map(pos => this.data.partOfSpeech[pos] || pos);
    const matchedForms = [...candidate.matches]
      .filter(match => normalizeLookupText(match) !== normalizeLookupText(headword))
      .slice(0, 3);
    const lineNumbers = [...candidate.lines].sort((a, b) => a - b).slice(0, 8);

    const fields = [
      `lines ${lineNumbers.join(",")}`,
      `word=${headword}`,
      preferredKana && preferredKana !== headword ? `reading=${preferredKana}` : "",
      matchedForms.length ? `matched=${matchedForms.join("/")}` : "",
      posDescriptions.length ? `pos=${posDescriptions.join("; ")}` : "",
      `meaning=${meanings.join("; ")}`,
    ].filter(Boolean);
    return `- ${fields.join(" | ")}`;
  }
}

let dictionaryPromise: Promise<RuntimeDictionary> | undefined;

async function loadDictionary(): Promise<RuntimeDictionary> {
  if (!dictionaryPromise) {
    dictionaryPromise = (async () => {
      const response = await withTimeout(
        fetch(JMDICT_URL),
        20000,
        "Timed out while loading JMdict references",
      );
      if (!response.ok) {
        throw new Error(`Dictionary request failed: ${response.status} ${response.statusText}`);
      }
      const data = await response.json() as CompactDictionaryData;
      if (data.format !== 2 || !data.lookup || !Array.isArray(data.entries)) {
        throw new Error("Unsupported lyrics dictionary format");
      }
      return new RuntimeDictionary(data);
    })();
  }
  return dictionaryPromise;
}

interface WorkerRequest {
  id: number;
  lines: string[];
}

interface WorkerResponse {
  id: number;
  tokens?: KuromojiToken[][];
  error?: string;
}

interface PendingWorkerRequest {
  resolve: (tokens: KuromojiToken[][]) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TokenizerWorkerState {
  worker: Worker;
  pending: Map<number, PendingWorkerRequest>;
}

let tokenizerWorkerState: TokenizerWorkerState | undefined;
let tokenizerRequestId = 0;

function tokenizerWorkerSource(): string {
  return `
const KUROMOJI_SCRIPT_URL = ${JSON.stringify(KUROMOJI_SCRIPT_URL)};
const KUROMOJI_DICTIONARY_URL = ${JSON.stringify(KUROMOJI_DICTIONARY_URL)};
const VIRTUAL_DICTIONARY_PATH = "/__lyrics_kuromoji__/";

let tokenizerPromise;

function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      try {
        importScripts(KUROMOJI_SCRIPT_URL);
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...args) {
          if (typeof url === "string") {
            const markerIndex = url.indexOf(VIRTUAL_DICTIONARY_PATH);
            if (markerIndex >= 0) {
              url = KUROMOJI_DICTIONARY_URL +
                url.slice(markerIndex + VIRTUAL_DICTIONARY_PATH.length);
            }
          }
          return originalOpen.call(this, method, url, ...args);
        };
        self.kuromoji.builder({ dicPath: VIRTUAL_DICTIONARY_PATH }).build(
          (error, tokenizer) => error ? reject(error) : resolve(tokenizer),
        );
      } catch (error) {
        reject(error);
      }
    });
  }
  return tokenizerPromise;
}

self.onmessage = async event => {
  const { id, lines } = event.data;
  try {
    const tokenizer = await getTokenizer();
    const tokens = lines.map(line => tokenizer.tokenize(line).map(token => ({
      surface_form: token.surface_form,
      basic_form: token.basic_form,
      reading: token.reading,
      pos: token.pos,
      pos_detail_1: token.pos_detail_1,
    })));
    self.postMessage({ id, tokens });
  } catch (error) {
    self.postMessage({
      id,
      error: error && (error.stack || error.message) || String(error),
    });
  }
};
`;
}

function terminateTokenizerWorker(error: Error) {
  const state = tokenizerWorkerState;
  tokenizerWorkerState = undefined;
  if (!state) return;
  state.worker.terminate();
  for (const request of state.pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  state.pending.clear();
}

function getTokenizerWorker(): TokenizerWorkerState {
  if (tokenizerWorkerState) return tokenizerWorkerState;
  if (typeof Worker === "undefined") {
    throw new Error("Web Workers are not available");
  }

  const blobUrl = URL.createObjectURL(
    new Blob([tokenizerWorkerSource()], { type: "text/javascript" }),
  );
  const worker = new Worker(blobUrl);
  URL.revokeObjectURL(blobUrl);
  const state: TokenizerWorkerState = {
    worker,
    pending: new Map(),
  };
  tokenizerWorkerState = state;

  worker.onmessage = event => {
    const response = event.data as WorkerResponse;
    const request = state.pending.get(response.id);
    if (!request) return;
    state.pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(new Error(response.error));
    else request.resolve(response.tokens || []);
  };
  worker.onerror = event => {
    terminateTokenizerWorker(new Error(event.message || "Kuromoji worker failed"));
  };
  worker.onmessageerror = () => {
    terminateTokenizerWorker(new Error("Failed to read the Kuromoji worker response"));
  };
  return state;
}

function tokenizeLines(lines: string[]): Promise<KuromojiToken[][]> {
  const state = getTokenizerWorker();
  const id = ++tokenizerRequestId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!state.pending.delete(id)) return;
      const error = new Error("Timed out while loading or running Kuromoji");
      reject(error);
      terminateTokenizerWorker(error);
    }, 60000);
    state.pending.set(id, { resolve, reject, timer });
    state.worker.postMessage({ id, lines } satisfies WorkerRequest);
  });
}

export async function buildDictionaryReferences(lines: string[]): Promise<string> {
  if (!lines.some(line => /[々〆ヶぁ-んァ-ヶ一-龯]/.test(line))) return "";

  let dictionary: RuntimeDictionary;
  try {
    dictionary = await loadDictionary();
  } catch (error) {
    console.warn("[Lyrics Explains] Failed to load JMdict references:", error);
    return "";
  }

  let tokenizedLines: KuromojiToken[][] | null = null;
  try {
    tokenizedLines = await tokenizeLines(lines);
  } catch (error) {
    console.warn("[Lyrics Explains] Failed to load kuromoji; using dictionary scanning only:", error);
  }

  const candidates = dictionary.findCandidates(lines, tokenizedLines);
  const formatted: string[] = [];
  let characterCount = 0;
  for (const candidate of candidates) {
    const line = dictionary.formatCandidate(candidate);
    if (characterCount + line.length > MAX_REFERENCE_CHARACTERS) break;
    formatted.push(line);
    characterCount += line.length + 1;
  }
  if (!formatted.length) return "";

  return `
Automatically matched JMdict references are listed below. They are candidates,
not authoritative segmentation: ignore false matches and select meanings by lyric context.
Do not copy a meaning when it conflicts with the line.
${formatted.join("\n")}
`;
}
