(function (mcloud, webfx) {
  'use strict';

  // --- Plugin Registration ---
  mcloud.plugins.registerPlugin({
    name: "Lyrics Explains",
    description: "Generates line-by-line explanations for lyrics using Gemini API.",
    version: "0.1.0",
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
    ["Gemini API Key:", "Gemini API 密钥：", "Gemini API キー："],
    ["Enter your Gemini API Key", "输入您的 Gemini API 密钥", "Gemini API キーを入力してください"],
    ["API Base URL (optional):", "API Base URL（可选）：", "API ベース URL（オプション）："],
    ["Custom Prompt Addition:", "自定义提示词补充：", "カスタムプロンプト追加："],
    ["Add custom instructions for the AI (optional)", "为 AI 添加自定义指令（可选）", "AI へのカスタム指示を追加（オプション）"],
    ["Settings saved.", "设置已保存。", "設定が保存されました。"],
    ["Failed to parse explanations from the API response.", "未能从 API 响应中解析解释。", "API 応答から解説を解析できませんでした。"],
    ["Gemini API Key is not configured for Lyrics Explains plugin.", "尚未配置歌词解释插件的 Gemini API 密钥。", "歌詞解説プラグインの Gemini API キーが設定されていません。"]
  ]);

  // Define the structure for storing configuration












  // --- Configuration Store ---
  const configStore = new mcloud.UserStoreItem({
    key: "plugin-lyrics-explains-config",
    value: {
      apiKey: "",
      baseUrl: "https://generativelanguage.googleapis.com", // Default Gemini API URL
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

  // --- Gemini API Call ---
  async function callGemini(prompt) {
    const config = await configStore.get(); // Ensure config is loaded
    if (!config.apiKey) {
      mcloud.Toast.show(webfx.I`Gemini API Key is not configured for Lyrics Explains plugin.`, 3000);
      throw new Error("API Key not configured.");
    }

    const model = "gemini-2.5-flash"; // Use the specified model
    const url = `${config.baseUrl || 'https://generativelanguage.googleapis.com'}/v1beta/models/${model}:generateContent?key=${config.apiKey}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          // Optional: Add safetySettings, generationConfig if needed
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error("Gemini API Error:", errorData);
        throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();
      // Navigate the Gemini response structure
      if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts) {
        return data.candidates[0].content.parts[0].text;
      } else {
        console.error("Unexpected Gemini API response structure:", data);
        throw new Error("Unexpected response structure from Gemini API.");
      }
    } catch (error) {
      console.error("Failed to call Gemini API:", error);
      throw error; // Re-throw the error to be caught by the caller
    }
  }

  // --- Prompt Construction ---
  function buildPrompt(lyrics, track, customPrompt) {
    // Split lyrics into lines and add line numbers for the input format
    const lines = [...new Set(lyrics.lines.map(line => line.spans?.map(x => x.text).join('').trim()).filter(line => line))] ; // Unique, non-empty lines
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
Now analyze these lyrics based *only* on the provided input lines. Ensure the output is a single, valid JSON object starting with { and ending with }:
---
${numberedLines}
---
`;
    return { prompt, lines };
  }

  // --- Response Parsing ---










  function parseGeminiResponse(responseText, lines) {
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
      console.error("Failed to parse Gemini JSON response:", error);
      console.error("Raw response text:", responseText); // Log raw response for debugging
      throw new Error(`Failed to parse JSON response from AI. ${error}`);
    }

    for (const item of parsedJson.data) {
      if (item.line !== undefined) {
        // Use the original line text as the key for robustness
        const original = lines[item.line];
        explanations[original] = {
          translation: item.translation,
          explanation: item.explains.join('\n')
        };
      } else {
        console.warn("Skipping invalid item in parsed JSON data:", item);
      }
    }

    console.info({ explanations });

    return explanations;
  }

  // Ensure LineExplanation matches the new structure if needed, or adapt parsing
  // For now, adapting the parsing to fit the existing LineExplanation (string explanation)






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
              const parsed = mcloud.Lyrics.parse(lyricsText);
              if (!lyricsText) {
                toast.updateWith({ text: webfx.I`No lyrics found for this track.` });
                toast.show(3000);
                return;
              }

              const config = await configStore.get();
              const { prompt, lines } = buildPrompt(parsed, track, config.customPrompt);
              const geminiResponse = await callGemini(prompt);
              const parsedExplanations = parseGeminiResponse(geminiResponse, lines);

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

    const apiKeyInput = new webfx.InputView({ type: 'password', placeholder: webfx.I`Enter your Gemini API Key` });
    const baseUrlInput = new webfx.InputView({ placeholder: `Default: ${configStore.value.baseUrl}` });
    const customPromptInput = new webfx.InputView({ multiline: true, placeholder: webfx.I`Add custom instructions for the AI (optional)` });

    // Load current values
    configStore.get().then(config => {
      apiKeyInput.value = config.apiKey || "";
      baseUrlInput.value = config.baseUrl || "";
      customPromptInput.value = config.customPrompt || "";
    });


    dialog.addContent(webfx.I`Gemini API Key:`);
    dialog.addContent(apiKeyInput);
    dialog.addContent(webfx.I`API Base URL (optional):`);
    dialog.addContent(baseUrlInput);
    dialog.addContent(webfx.I`Custom Prompt Addition:`);
    dialog.addContent(customPromptInput);

    dialog.addBtn(new webfx.TextBtn({
      text: webfx.I`Save`,
      right: true,
      onActive: async () => {
        configStore.value = {
          ...configStore.value,
          apiKey: apiKeyInput.value.trim(),
          baseUrl: baseUrlInput.value.trim() || "https://generativelanguage.googleapis.com", // Reset to default if empty
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
