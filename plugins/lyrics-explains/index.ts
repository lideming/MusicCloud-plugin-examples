import {
  plugins,
  Toast,
  trackContextMenuHooks,
  userStore,
  UserStoreItem,
  Lyrics,
  LineView,
  LyricsView,
  nowPlaying,
} from "@yuuza/mcloud";

import {
  MenuItem,
  Dialog,
  InputView,
  TextBtn,
  hookFunction,
  buildDOM,
  I,
  i18n,
  View,
  injectCss,
} from "@yuuza/webfx";
import { buildDictionaryReferences } from "./dictionary";

// --- Plugin Registration ---
plugins.registerPlugin({
  name: "Lyrics Explains",
  description: "Generates line-by-line explanations with Gemini or OpenAI APIs and local JMdict references.",
  version: "0.3.1",
  website: "",
  settings: () => openSettingsDialog(),
});

i18n.add2dArray([
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
type ApiProvider = "gemini" | "openai";

interface LyricsExplainsConfig {
  apiKey: string;
  baseUrl: string;
  customPrompt: string;
  provider?: ApiProvider;
  model?: string;
}

const providerDefaults: Record<ApiProvider, { baseUrl: string; model: string }> = {
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
  },
};

function normalizeConfig(config?: Partial<LyricsExplainsConfig> | null): Required<LyricsExplainsConfig> {
  const current = config || {};
  const provider: ApiProvider = current.provider === "openai" ? "openai" : "gemini";
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
interface LineExplanation {
  translation?: string;
  explanation: string;
}

// --- Configuration Store ---
const configStore = new UserStoreItem<LyricsExplainsConfig>({
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
function getExplanationStoreKey(trackId: number): string {
  return `plugin-lyrics-explains-data-${trackId}`;
}

// Ensure config is loaded when the plugin initializes
configStore.fetch();

// --- AI API Calls ---
async function readJsonResponse(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function throwApiError(response: Response, data: any): never {
  const detail = data?.error?.message || data?.message || "Unknown error";
  throw new Error(`API Error: ${response.status} ${response.statusText} - ${detail}`);
}

async function callGemini(prompt: string, config: Required<LyricsExplainsConfig>): Promise<string> {
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
    const text = parts.map((part: any) => part?.text || "").join("");
    if (text) return text;
  }
  console.error("Unexpected Gemini API response structure:", data);
  throw new Error("Unexpected response structure from Gemini API.");
}

function getOpenAIChatCompletionsUrl(baseUrlOrEndpoint: string): string {
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

async function callOpenAI(prompt: string, config: Required<LyricsExplainsConfig>): Promise<string> {
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
    const text = content.map((part: any) => part?.text || "").join("");
    if (text) return text;
  }
  console.error("Unexpected OpenAI Chat Completions response structure:", data);
  throw new Error("Unexpected response structure from OpenAI Chat Completions API.");
}

function ensureApiConfigured(config: Required<LyricsExplainsConfig>) {
  if (!config.apiKey) {
    Toast.show(I`API Key is not configured for Lyrics Explains plugin.`, 3000);
    throw new Error("API Key not configured.");
  }
}

async function callAI(
  prompt: string,
  config: Required<LyricsExplainsConfig>,
): Promise<string> {
  return config.provider === "openai"
    ? callOpenAI(prompt, config)
    : callGemini(prompt, config);
}

// --- Prompt Construction ---
function getUniqueLyricsLines(lyrics: Lyrics.Lyrics): string[] {
  // Split lyrics into lines and add line numbers for the input format
  return [...new Set(
    lyrics.lines
      .map(line => line.spans?.map(x => x.text).join('').trim())
      .filter(line => line),
  )] as string[];
}

function buildPrompt(
  lines: string[],
  customPrompt?: string,
  dictionaryReferences?: string,
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
interface AIExplanationData {
  line: number;
  translation: string;
  explains: string[];
}

interface AIJsonResponse {
  data: AIExplanationData[];
}

function parseAIResponse(responseText: string, lines: string[]): Record<string, LineExplanation> {
  const explanations: Record<string, LineExplanation> = {};
  let parsedJson: AIJsonResponse;

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
hookFunction(trackContextMenuHooks, "onCreated", (next) => (context) => {
  // Call the original hook function first if necessary
  next(context);

  const { menu, selected } = context;

  // Only show for single track selection for simplicity now
  if (selected.length === 1) {
    const track = selected[0];

    menu.add(
      new MenuItem({
        text: I`Generate Lyrics Explanation`,
        onActive: async () => {
          const toast = Toast.show(I`Generating explanation for "${track.name}"...`, 0); // Indefinite toast

          try {
            const lyricsText = await track.getLyrics(); // Fetch lyrics
            if (!lyricsText) {
              toast.updateWith({ text: I`No lyrics found for this track.` });
              toast.show(3000);
              return;
            }
            const parsed = Lyrics.parse(lyricsText);

            const config = normalizeConfig(await configStore.get());
            ensureApiConfigured(config);
            const lines = getUniqueLyricsLines(parsed);
            const dictionaryReferences = await buildDictionaryReferences(lines);
            const prompt = buildPrompt(lines, config.customPrompt, dictionaryReferences);
            const aiResponse = await callAI(prompt, config);
            const parsedExplanations = parseAIResponse(aiResponse, lines);

            if (!parsedExplanations || Object.keys(parsedExplanations).length === 0) {
              throw new Error(I`Failed to parse explanations from the API response.`);
            }

            if (nowPlaying.lazyView.computed && nowPlaying.lazyView.value.lyricsView) {
              const lyricsView = nowPlaying.lazyView.value.lyricsView
              if (lyricsView.track?.id === track.id) {
                renderLyricsView(lyricsView, parsedExplanations);
              }
            }

            await userStore.set(getExplanationStoreKey(track.id), { value: parsedExplanations }, "json");

            toast.updateWith({ text: I`Explanation generated successfully for "${track.name}".` });
            toast.show(3000);
          } catch (error) {
            console.error("Error generating lyrics explanation:", error);
            toast.updateWith({ text: `${I`Error generating explanation:`}\n${error}` });
            toast.show(5000);
          } finally {
            // Clean up loading indicator if used in toast
          }
        },
      }) as any,
      0 // Add to the top of the menu
    );
  }
});


// --- Display Logic ---
// We need to access the track ID within LineView, which isn't directly available.
// Approach: Hook LyricsView.setLyrics, fetch explanations, store them in LyricsView instance,
// pass them down to LineView via context.

hookFunction(LyricsView.prototype, "setLyrics", (next) => async function (this: LyricsView, lyrics: string | Lyrics.Lyrics) {
  // Call original function first
  const result = next(lyrics);

  const trackId = this.track?.id; // Assuming LyricsView has a 'track' property

  if (trackId) {
    try {
      const { value: storedData } = await userStore.get(getExplanationStoreKey(trackId), "json") ?? { value: null };
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

async function renderLyricsView(lyricsView: LyricsView, explanations: Record<string, LineExplanation>) {
  lyricsView.lines.forEach(line => {
    renderLineView(line, explanations);
  });
}


function renderLineView(lineView: LineView, explanations: Record<string, LineExplanation>) {
  const { line } = lineView;
  try {
    if (explanations && line.spans) {
      // Find the original text for the current line
      const originalText = line.spans.map(s => s.text).join('').trim();
      const explanationData = explanations[originalText];

      lineView.dom.querySelector('.lyrics-explanation')?.remove();
      if (explanationData) {
        const explanationDiv = buildDOM({
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

injectCss(`
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
function openSettingsDialog(ev?: MouseEvent) {
  const dialog = new Dialog();
  dialog.title = I`Lyrics Explains Settings`;
  dialog.width = "500px";

  const providerSelect = new View<HTMLSelectElement>({
    tag: "select.input-text",
    style: "width: 100%;",
    child: [
      { tag: "option", value: "gemini", text: "Gemini" },
      { tag: "option", value: "openai", text: I`OpenAI Chat Completions` },
    ],
  });
  const apiKeyInput = new InputView({ type: 'password', placeholder: I`Enter your API Key` });
  const baseUrlInput = new InputView();
  const modelInput = new InputView();
  const customPromptInput = new InputView({ multiline: true, placeholder: I`Add custom instructions for the AI (optional)` });
  let previousProvider: ApiProvider = "gemini";

  const getSelectedProvider = (): ApiProvider =>
    providerSelect.dom.value === "openai" ? "openai" : "gemini";

  const updateProviderFields = (provider: ApiProvider, replacePreviousDefaults: boolean) => {
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

  dialog.addContent(I`API Provider:`);
  dialog.addContent(providerSelect);
  dialog.addContent(I`API Key:`);
  dialog.addContent(apiKeyInput);
  dialog.addContent(I`API Base URL or Endpoint (optional):`);
  dialog.addContent(baseUrlInput);
  dialog.addContent(I`Model:`);
  dialog.addContent(modelInput);
  dialog.addContent(I`Custom Prompt Addition:`);
  dialog.addContent(customPromptInput);

  dialog.addBtn(new TextBtn({
    text: I`Save`,
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
      configStore.revision = null!;
      await configStore.put();
      Toast.show(I`Settings saved.`, 2000);
      dialog.close();
    }
  }));

  dialog.show(ev);
}
