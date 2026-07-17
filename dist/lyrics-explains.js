(function (mcloud, webfx) {
  'use strict';

  const JMDICT_URL =
    "https://cdn.jsdelivr.net/gh/lideming/MusicCloud-plugin-examples@master/plugins/lyrics-explains/data/jmdict-eng-common.json";
  const KUROMOJI_SCRIPT_URL =
    "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js";
  const KUROMOJI_DICTIONARY_URL =
    "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";

  const MAX_SCAN_LENGTH = 18;
  const MAX_DICTIONARY_REFERENCES = 60;
  const MAX_REFERENCE_CHARACTERS = 10000;









































  function toHiragana(text) {
    return text.replace(/[ァ-ヶ]/g, character =>
      String.fromCharCode(character.charCodeAt(0) - 0x60),
    );
  }

  function normalizeLookupText(text) {
    return toHiragana(text.normalize("NFKC")).toLowerCase();
  }

  function containsKanji(text) {
    return /[々〆ヶ一-龯]/.test(text);
  }

  async function withTimeout(
    promise,
    timeoutMs,
    message,
  ) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  class RuntimeDictionary {
    constructor( data) {this.data = data;}

     isCommonForm(entryIndex, form) {
      const normalized = normalizeLookupText(form);
      const entry = this.data.entries[entryIndex];
      return [...entry[1], ...entry[2]].some(
        ([entryForm, common]) =>
          common === 1 && normalizeLookupText(entryForm) === normalized,
      );
    }

     matchesReading(entryIndex, reading) {
      const normalized = normalizeLookupText(reading);
      return this.data.entries[entryIndex][2].some(
        ([entryReading]) => normalizeLookupText(entryReading) === normalized,
      );
    }

     matchesPartOfSpeech(entryIndex, token) {
      if (!token.pos) return true;
      const dictionaryPos = new Set(
        this.data.entries[entryIndex][3].flatMap(([partOfSpeech]) => partOfSpeech),
      );
      const has = (...values) => values.some(value => dictionaryPos.has(value));
      const hasPrefix = (...prefixes) =>
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

     addCandidate(
      candidates,
      entryIndex,
      score,
      line,
      matchedForm,
      lookupForm,
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

     addExactMatches(
      candidates,
      lookupForm,
      matchedForm,
      score,
      line,
      token,
      matchReading = false,
    ) {
      if (!lookupForm || lookupForm === "*") return 0;
      const normalized = normalizeLookupText(lookupForm);
      let entries = this.data.lookup[normalized];
      if (!entries) return 0;
      if (matchReading && token?.reading) {
        const readingMatches = entries.filter(entryIndex =>
          this.matchesReading(entryIndex, token.reading),
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

    findCandidates(lines, tokenizer) {
      const candidates = new Map();

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
            if (tokenizer && score < 45) continue;
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

        if (tokenizer) {
          for (const token of tokenizer.tokenize(lineText)) {
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

    formatCandidate(candidate) {
      const entry = this.data.entries[candidate.entryIndex];
      const preferredKanji = entry[1].find(([, common]) => common)?.[0] || entry[1][0]?.[0];
      const preferredKana = entry[2].find(([, common]) => common)?.[0] || entry[2][0]?.[0];
      const headword = preferredKanji || preferredKana || "";

      const meanings = [];
      const partOfSpeech = new Set();
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

  let dictionaryPromise;
  let tokenizerPromise;

  async function loadDictionary() {
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
        const data = await response.json() ;
        if (data.format !== 2 || !data.lookup || !Array.isArray(data.entries)) {
          throw new Error("Unsupported lyrics dictionary format");
        }
        return new RuntimeDictionary(data);
      })();
    }
    return dictionaryPromise;
  }

  function loadScript(url) {
    const global = globalThis ;
    if (global.kuromoji) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${url}"]`) ;
      const script = existing || document.createElement("script");
      const onLoad = () => global.kuromoji
        ? resolve()
        : reject(new Error("kuromoji.js did not expose its browser API"));
      const onError = () => reject(new Error("Failed to load kuromoji.js"));
      script.addEventListener("load", onLoad, { once: true });
      script.addEventListener("error", onError, { once: true });
      if (!existing) {
        script.src = url;
        script.async = true;
        document.head.appendChild(script);
      }
    });
  }

  async function loadTokenizer() {
    if (!tokenizerPromise) {
      tokenizerPromise = (async () => {
        await withTimeout(
          loadScript(KUROMOJI_SCRIPT_URL),
          20000,
          "Timed out while loading kuromoji.js",
        );
        const kuromoji = (globalThis ).kuromoji;
        return await withTimeout(
          new Promise((resolve, reject) => {
            kuromoji.builder({ dicPath: KUROMOJI_DICTIONARY_URL }).build(
              (error, tokenizer) => {
                if (error) reject(error);
                else resolve(tokenizer);
              },
            );
          }),
          60000,
          "Timed out while loading the kuromoji dictionary",
        );
      })();
    }
    return tokenizerPromise;
  }

  async function buildDictionaryReferences(lines) {
    if (!lines.some(line => /[々〆ヶぁ-んァ-ヶ一-龯]/.test(line))) return "";

    let dictionary;
    try {
      dictionary = await loadDictionary();
    } catch (error) {
      console.warn("[Lyrics Explains] Failed to load JMdict references:", error);
      return "";
    }

    let tokenizer = null;
    try {
      tokenizer = await loadTokenizer();
    } catch (error) {
      console.warn("[Lyrics Explains] Failed to load kuromoji; using dictionary scanning only:", error);
    }

    const candidates = dictionary.findCandidates(lines, tokenizer);
    const formatted = [];
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

  // --- Plugin Registration ---
  mcloud.plugins.registerPlugin({
    name: "Lyrics Explains",
    description: "Generates line-by-line explanations with Gemini or OpenAI APIs and local JMdict references.",
    version: "0.3.0",
    website: "",
    settings: () => openSettingsDialog(),
  });

  webfx.i18n.add2dArray([
    ["en", "zh", "ja"],
    ["Generate Lyrics Explanation", "生成歌词解释", "歌詞の解説を生成"],
    ["Generating explanation for \"{0}\"...", "正在为“{0}”生成解释...", "\"{0}\"の解説を生成中..."],
    ["No lyrics found for this track.", "未找到该歌曲的歌词。", "このトラックの歌詞が見つかりません。"],
    ["Explanation generated successfully for \"{0}\".", "已成功为“{0}”生成解释。", "\"{0}\"の解説が正常に生成されました。"],
    ["Error generating explanation:", "生成解释时出错：", "解説の生成中にエラーが発生しました："],
    ["Lyrics Explains Settings", "歌词解释设置", "歌詞解説設定"],
    ["API Provider:", "API 提供商：", "API プロバイダー："],
    ["OpenAI Chat Completions", "OpenAI Chat Completions", "OpenAI Chat Completions"],
    ["API Key:", "API 密钥：", "API キー："],
    ["Enter your API Key", "输入您的 API 密钥", "API キーを入力してください"],
    ["API Base URL or Endpoint (optional):", "API Base URL 或 Endpoint（可选）：", "API ベース URL またはエンドポイント（オプション）："],
    ["Model:", "模型：", "モデル："],
    ["Custom Prompt Addition:", "自定义提示词补充：", "カスタムプロンプト追加："],
    ["Add custom instructions for the AI (optional)", "为 AI 添加自定义指令（可选）", "AI へのカスタム指示を追加（オプション）"],
    ["Settings saved.", "设置已保存。", "設定が保存されました。"],
    ["Failed to parse explanations from the API response.", "未能从 API 响应中解析解释。", "API 応答から解説を解析できませんでした。"],
    ["API Key is not configured for Lyrics Explains plugin.", "尚未配置歌词解释插件的 API 密钥。", "歌詞解説プラグインの API キーが設定されていません。"],
  ]);

  // Define the structure for storing configuration










  const providerDefaults = {
    gemini: {
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-2.5-flash",
    },
    openai: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-luna",
    },
  };

  function normalizeConfig(config) {
    const current = config || {};
    const provider = current.provider === "openai" ? "openai" : "gemini";
    const defaults = providerDefaults[provider];
    return {
      provider,
      apiKey: current.apiKey || "",
      baseUrl: current.baseUrl || defaults.baseUrl,
      model: current.model || defaults.model,
      customPrompt: current.customPrompt || "",
    };
  }

  // Define the structure for storing explanation results





  // --- Configuration Store ---
  const configStore = new mcloud.UserStoreItem({
    key: "plugin-lyrics-explains-config",
    value: {
      provider: "gemini",
      apiKey: "",
      baseUrl: providerDefaults.gemini.baseUrl,
      model: providerDefaults.gemini.model,
      customPrompt: "",
    },
  });

  // --- Explanation Results Store ---
  // We'll use individual UserStoreItems per track for simplicity
  function getExplanationStoreKey(trackId) {
    return `plugin-lyrics-explains-data-${trackId}`;
  }

  // Ensure config is loaded when the plugin initializes
  configStore.fetch();

  // --- AI API Calls ---
  async function readJsonResponse(response) {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { message: text.slice(0, 300) };
    }
  }

  function throwApiError(response, data) {
    const detail = data?.error?.message || data?.message || "Unknown error";
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${detail}`);
  }

  async function callGemini(prompt, config) {
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      console.error("Gemini API Error:", data);
      throwApiError(response, data);
    }

    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const text = parts.map((part) => part?.text || "").join("");
      if (text) return text;
    }
    console.error("Unexpected Gemini API response structure:", data);
    throw new Error("Unexpected response structure from Gemini API.");
  }

  function getOpenAIChatCompletionsUrl(baseUrlOrEndpoint) {
    const fallback = providerDefaults.openai.baseUrl;
    const input = (baseUrlOrEndpoint || fallback).trim();
    try {
      const url = new URL(input);
      let path = url.pathname.replace(/\/+$/, "");
      if (/\/chat\/completions$/i.test(path)) return url.toString();
      if (!path && url.origin === "https://api.openai.com") path = "/v1";
      url.pathname = `${path}/chat/completions`;
      return url.toString();
    } catch {
      const base = input.replace(/\/+$/, "");
      if (/\/chat\/completions(?:\?|$)/i.test(base)) return base;
      return `${base}/chat/completions`;
    }
  }

  async function callOpenAI(prompt, config) {
    const response = await fetch(getOpenAIChatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await readJsonResponse(response);
    if (!response.ok) {
      console.error("OpenAI Chat Completions API Error:", data);
      throwApiError(response, data);
    }

    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content) return content;
    if (Array.isArray(content)) {
      const text = content.map((part) => part?.text || "").join("");
      if (text) return text;
    }
    console.error("Unexpected OpenAI Chat Completions response structure:", data);
    throw new Error("Unexpected response structure from OpenAI Chat Completions API.");
  }

  function ensureApiConfigured(config) {
    if (!config.apiKey) {
      mcloud.Toast.show(webfx.I`API Key is not configured for Lyrics Explains plugin.`, 3000);
      throw new Error("API Key not configured.");
    }
  }

  async function callAI(
    prompt,
    config,
  ) {
    return config.provider === "openai"
      ? callOpenAI(prompt, config)
      : callGemini(prompt, config);
  }

  // --- Prompt Construction ---
  function getUniqueLyricsLines(lyrics) {
    // Split lyrics into lines and add line numbers for the input format
    return [...new Set(
      lyrics.lines
        .map(line => line.spans?.map(x => x.text).join('').trim())
        .filter(line => line),
    )] ;
  }

  function buildPrompt(
    lines,
    customPrompt,
    dictionaryReferences,
  ) {
    const numberedLines = lines
      .map((line, index) => `line ${index}: ${line}`)
      .join('\n');

    const prompt = `
Analyze the lyrics provided below line by line.
For each line, provide:
1.  The original line number.
2.  A translation (Chinese by default, unless specified in User's Additional Instructions) of the line.
3.  An optional array of explanations for key vocabulary or grammar points within that line. For Japanese lyrics, include JLPT level (like [N3], [N4]) and pronunciation (hiragana in parentheses) where applicable. Format each explanation as a string within the array.

Input format will be:
line [number]: [original text]
...

The line number might not be sequential if there are empty or duplicated lines in the lyrics.

Output MUST be a single valid JSON object with a key "data" containing an array of objects. Each object in the array represents a line and must have the following keys: "line" (number), "original" (string), "translation" (string), "explains" (array of strings).

Example Input:
line 0: こんにちは、温かい世界
line 1: 月がきれいですね

Example Output JSON:
{
  "data": [
    {
      "line": 0,
      "translation": "你好，温暖的世界",
      "explains": ["[N5]こんにちは: 你好 (用于白天)","[N3]温かい(あたたかい): 温暖的","[N4]世界(せかい): 世界"]
    },
    {
      "line": 1,
      "translation": "月色真美啊",
      "explains": ["[N5]月(つき): 月亮","[N4]きれい: 美丽的，干净的 (形容动词)","[N5]ですね: (句末助词，表确认或征求同意)"]
    }
  ]
}
User's Additional Instructions:${customPrompt ? `\n${customPrompt}\n` : ' not provided.'}
${dictionaryReferences || ""}
Now analyze these lyrics using the input lines and only the relevant dictionary references above. Ensure the output is a single, valid JSON object starting with { and ending with }:
---
${numberedLines}
---
`;
    return prompt;
  }

  // --- Response Parsing ---










  function parseAIResponse(responseText, lines) {
    const explanations = {};
    let parsedJson;

    try {
      // Attempt to find the JSON block within potential markdown fences
      const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      const jsonString = jsonMatch ? jsonMatch[1] : responseText;
      parsedJson = JSON.parse(jsonString.trim());
      console.info({ parsedJson });

      if (!parsedJson || !Array.isArray(parsedJson.data)) {
        throw new Error("Invalid JSON structure: 'data' array not found.");
      }

    } catch (error) {
      console.error("Failed to parse AI JSON response:", error);
      console.error("Raw response text:", responseText); // Log raw response for debugging
      throw new Error(`Failed to parse JSON response from AI. ${error}`);
    }

    for (const item of parsedJson.data) {
      if (item.line !== undefined && lines[item.line] !== undefined) {
        // Use the original line text as the key for robustness
        const original = lines[item.line];
        explanations[original] = {
          translation: item.translation,
          explanation: Array.isArray(item.explains) ? item.explains.join('\n') : ""
        };
      } else {
        console.warn("Skipping invalid item in parsed JSON data:", item);
      }
    }

    console.info({ explanations });

    return explanations;
  }

  // --- Trigger via Context Menu ---
  webfx.hookFunction(mcloud.trackContextMenuHooks, "onCreated", (next) => (context) => {
    // Call the original hook function first if necessary
    next(context);

    const { menu, selected } = context;

    // Only show for single track selection for simplicity now
    if (selected.length === 1) {
      const track = selected[0];

      menu.add(
        new webfx.MenuItem({
          text: webfx.I`Generate Lyrics Explanation`,
          onActive: async () => {
            const toast = mcloud.Toast.show(webfx.I`Generating explanation for "${track.name}"...`, 0); // Indefinite toast

            try {
              const lyricsText = await track.getLyrics(); // Fetch lyrics
              if (!lyricsText) {
                toast.updateWith({ text: webfx.I`No lyrics found for this track.` });
                toast.show(3000);
                return;
              }
              const parsed = mcloud.Lyrics.parse(lyricsText);

              const config = normalizeConfig(await configStore.get());
              ensureApiConfigured(config);
              const lines = getUniqueLyricsLines(parsed);
              const dictionaryReferences = await buildDictionaryReferences(lines);
              const prompt = buildPrompt(lines, config.customPrompt, dictionaryReferences);
              const aiResponse = await callAI(prompt, config);
              const parsedExplanations = parseAIResponse(aiResponse, lines);

              if (!parsedExplanations || Object.keys(parsedExplanations).length === 0) {
                throw new Error(webfx.I`Failed to parse explanations from the API response.`);
              }

              if (mcloud.nowPlaying.lazyView.computed && mcloud.nowPlaying.lazyView.value.lyricsView) {
                const lyricsView = mcloud.nowPlaying.lazyView.value.lyricsView;
                if (lyricsView.track?.id === track.id) {
                  renderLyricsView(lyricsView, parsedExplanations);
                }
              }

              await mcloud.userStore.set(getExplanationStoreKey(track.id), { value: parsedExplanations }, "json");

              toast.updateWith({ text: webfx.I`Explanation generated successfully for "${track.name}".` });
              toast.show(3000);
            } catch (error) {
              console.error("Error generating lyrics explanation:", error);
              toast.updateWith({ text: `${webfx.I`Error generating explanation:`}\n${error}` });
              toast.show(5000);
            } finally {
              // Clean up loading indicator if used in toast
            }
          },
        }) ,
        0 // Add to the top of the menu
      );
    }
  });


  // --- Display Logic ---
  // We need to access the track ID within LineView, which isn't directly available.
  // Approach: Hook LyricsView.setLyrics, fetch explanations, store them in LyricsView instance,
  // pass them down to LineView via context.

  webfx.hookFunction(mcloud.LyricsView.prototype, "setLyrics", (next) => async function ( lyrics) {
    // Call original function first
    const result = next(lyrics);

    const trackId = this.track?.id; // Assuming LyricsView has a 'track' property

    if (trackId) {
      try {
        const { value: storedData } = await mcloud.userStore.get(getExplanationStoreKey(trackId), "json") ?? { value: null };
        console.info({ storedData });
        if (storedData && Object.keys(storedData).length > 0 && this.track?.id === trackId) {
          renderLyricsView(this, storedData);
        }
      } catch (error) {
        console.error(`Failed to load explanations for track ${trackId}:`, error);
      }
    }


    // Modify the context generation within setLyrics if possible, or hook where context is created/used
    // This part is tricky as the original setLyrics doesn't explicitly pass context down easily.
    // A less ideal but workable approach is to hook LineView's constructor.

    return result;
  });

  async function renderLyricsView(lyricsView, explanations) {
    lyricsView.lines.forEach(line => {
      renderLineView(line, explanations);
    });
  }


  function renderLineView(lineView, explanations) {
    const { line } = lineView;
    try {
      if (explanations && line.spans) {
        // Find the original text for the current line
        const originalText = line.spans.map(s => s.text).join('').trim();
        const explanationData = explanations[originalText];

        lineView.dom.querySelector('.lyrics-explanation')?.remove();
        if (explanationData) {
          const explanationDiv = webfx.buildDOM({
            tag: 'div.lyrics-explanation',
            lang: 'zh',
            text: explanationData.explanation,
            // Optionally add translation here too if needed
          });
          lineView.dom.appendChild(explanationDiv);
        }
      }
    } catch (e) {
      console.error("Error adding explanation to LineView:", e);
    }
  }

  webfx.injectCss(`
  .lyrics-explanation {
    font-size: 0.7em;
    font-family: sans-serif;
    color: var(--color-text-gray);
    white-space: pre-wrap;
    margin: 0.3em auto 0;
    text-align: left;
    max-width: 30em;
  }
`, { tag: 'style#lyrics-explains' });


  // --- Settings Dialog ---
  function openSettingsDialog(ev) {
    const dialog = new webfx.Dialog();
    dialog.title = webfx.I`Lyrics Explains Settings`;
    dialog.width = "500px";

    const providerSelect = new webfx.View({
      tag: "select.input-text",
      style: "width: 100%;",
      child: [
        { tag: "option", value: "gemini", text: "Gemini" },
        { tag: "option", value: "openai", text: webfx.I`OpenAI Chat Completions` },
      ],
    });
    const apiKeyInput = new webfx.InputView({ type: 'password', placeholder: webfx.I`Enter your API Key` });
    const baseUrlInput = new webfx.InputView();
    const modelInput = new webfx.InputView();
    const customPromptInput = new webfx.InputView({ multiline: true, placeholder: webfx.I`Add custom instructions for the AI (optional)` });
    let previousProvider = "gemini";

    const getSelectedProvider = () =>
      providerSelect.dom.value === "openai" ? "openai" : "gemini";

    const updateProviderFields = (provider, replacePreviousDefaults) => {
      const previousDefaults = providerDefaults[previousProvider];
      const defaults = providerDefaults[provider];
      if (replacePreviousDefaults) {
        if (!baseUrlInput.value || baseUrlInput.value === previousDefaults.baseUrl) {
          baseUrlInput.value = defaults.baseUrl;
        }
        if (!modelInput.value || modelInput.value === previousDefaults.model) {
          modelInput.value = defaults.model;
        }
      }
      baseUrlInput.placeholder = `Default: ${defaults.baseUrl}`;
      modelInput.placeholder = `Default: ${defaults.model}`;
      baseUrlInput.updateDom();
      modelInput.updateDom();
      previousProvider = provider;
    };

    providerSelect.dom.addEventListener("change", () => {
      updateProviderFields(getSelectedProvider(), true);
    });

    // Load current values
    configStore.get().then(storedConfig => {
      const config = normalizeConfig(storedConfig);
      providerSelect.dom.value = config.provider;
      apiKeyInput.value = config.apiKey || "";
      baseUrlInput.value = config.baseUrl;
      modelInput.value = config.model;
      customPromptInput.value = config.customPrompt || "";
      previousProvider = config.provider;
      updateProviderFields(config.provider, false);
    });

    dialog.addContent(webfx.I`API Provider:`);
    dialog.addContent(providerSelect);
    dialog.addContent(webfx.I`API Key:`);
    dialog.addContent(apiKeyInput);
    dialog.addContent(webfx.I`API Base URL or Endpoint (optional):`);
    dialog.addContent(baseUrlInput);
    dialog.addContent(webfx.I`Model:`);
    dialog.addContent(modelInput);
    dialog.addContent(webfx.I`Custom Prompt Addition:`);
    dialog.addContent(customPromptInput);

    dialog.addBtn(new webfx.TextBtn({
      text: webfx.I`Save`,
      right: true,
      onActive: async () => {
        const provider = getSelectedProvider();
        const defaults = providerDefaults[provider];
        configStore.value = {
          ...configStore.value,
          provider,
          apiKey: apiKeyInput.value.trim(),
          baseUrl: baseUrlInput.value.trim() || defaults.baseUrl,
          model: modelInput.value.trim() || defaults.model,
          customPrompt: customPromptInput.value.trim(),
        };
        configStore.revision = null;
        await configStore.put();
        mcloud.Toast.show(webfx.I`Settings saved.`, 2000);
        dialog.close();
      }
    }));

    dialog.show(ev);
  }

})(mcloud, mcloud.webfx);
