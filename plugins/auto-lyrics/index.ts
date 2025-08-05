import {
  api,
  Lyrics,
  playerCore,
  plugins,
  Toast,
  Track,
  trackContextMenuHooks,
  userStore,
} from "@yuuza/mcloud";
import { hookFunction, MenuItem, Semaphore } from "@yuuza/webfx";

plugins.registerPlugin({
  name: "Auto Lyrics",
  description: "",
  version: "1.0.0",
  website: "https://github.com/lideming/MusicCloud-example-plugins",
});

const lock = new Semaphore({ maxCount: 1 });

let skipHook = false;

hookFunction(
  Track.prototype,
  "getLyrics",
  (next) =>
    async function (this: Track) {
      let lyrics = await next();
      const shouldSkip = () =>
        skipHook ||
        (lyrics && !lyrics.startsWith("[note: Auto Lyrics]")) ||
        playerCore.track?.id !== this.id;
      if (shouldSkip()) {
        return lyrics;
      }

      await lock.enter();
      lyrics = this.infoObj!.lyrics || "";
      if (shouldSkip()) {
        lock.exit();
        return lyrics;
      }
      const toast = Toast.show(`Auto Lyrics running: ${this.name}`);
      try {
        lyrics = await transcribeTrack(this, (state) => {
          toast.updateWith({ text: `Auto Lyrics ${state}: ${this.name}` });
        });
        return lyrics;
      } finally {
        lock.exit();
        toast.close();
      }
    },
);

async function transcribeTrack(
  track: Track,
  onProgress: (state: string) => void,
  origLyrics?: string,
) {
  const fileInfo = [...track.files!]
    .sort((a, b) => a.size - b.size)
    .find((x) => x.size > 0);
  if (!fileInfo) {
    return "";
  }
  onProgress("fetching");
  const realUrl = api.processUrl(
    `${track.url}${fileInfo.profile ? `.${fileInfo.profile}` : ""}`,
  );
  const trackFileResp = await fetch(realUrl);
  const blob = await trackFileResp.blob();
  onProgress("transcribing");

  const parsedOrig = origLyrics ? Lyrics.parse(origLyrics) : null;
  const text = parsedOrig?.lines
    .map((line) => line.spans?.map((span) => span.text).join(""))
    .join("\n");
  const lang = parsedOrig?.lang || null;

  const formData = new FormData();
  formData.append("file", blob, `${track.name}.${fileInfo.format}`);
  if (text) formData.append("text", text);
  if (lang) formData.append("lang", lang);
  console.info("transcribe request", formData);
  const response = await fetch(api.processUrl('/transcribe'), {
    method: "POST",
    body: formData,
  });
  let result = await response.text();
  if (!response.ok) {
    throw new Error(`Transcription failed: ${result}`);
  }
  if (parsedOrig && text) {
    const parsedNew = Lyrics.parse(result);
    let origIdx = 0;
    let newIdx = 1; // skip [auto-lyrics] line
    parsedNew.translationLang = parsedOrig.translationLang;
    while (
      origIdx < parsedOrig.lines.length &&
      newIdx < parsedNew.lines.length
    ) {
      const origLine = parsedOrig.lines[origIdx];
      const origText = origLine.spans?.map((span) => span.text).join("");
      if (!origText) {
        if (
          origLine.startTime || // preserving empty lines with timestamps
          (origLine.rawLine && origLine.rawLine !== "[auto-lyrics]\n") // preserving unrecognized lines
        ) {
          parsedNew.lines.splice(newIdx, 0, origLine);
          newIdx++;
        }
        origIdx++;
        continue;
      }
      const newLine = parsedNew.lines[newIdx];
      if (!newLine.spans?.map((span) => span.text).join("")) {
        newIdx++;
        continue;
      }
      if (origLine.spans![0].timeStamp) {
        newLine.spans![0].timeStamp = origLine.spans![0].timeStamp;
      }
      newLine.translation = origLine.translation;
      origIdx++;
      newIdx++;
    }
    result = Lyrics.serialize(parsedNew, true);
  }
  if (track.infoObj!.lyrics && track.infoObj!.lyrics !== result) {
    userStore.set(
      "auto-lyrics-backup-" + track.id + "-" + Date.now(),
      { value: track.infoObj!.lyrics },
      "text",
    );
  }
  track.infoObj!.lyrics = result;
  track.put(track.infoObj!);
  return result;
}

hookFunction(trackContextMenuHooks, "onCreated", (next) => (context) => {
  next(context);
  const { menu, selected } = context;
  menu.add(
    new MenuItem({
      text: selected.length > 1 ? `Run Auto Lyrics (${selected.length} tracks)` : "Run Auto Lyrics",
      onActive: async () => {
        for (const track of selected) {
          if (!(track instanceof Track)) {
            continue;
          }
          await lock.run(async () => {
            let origLyrics;
            skipHook = true;
            try {
              origLyrics = await track.getLyrics();
            } finally {
              skipHook = false;
            }
            const toast = Toast.show(`Auto Lyrics: ${track.name}`);
            try {
              await transcribeTrack(
                track,
                (state) => {
                  toast.updateWith({
                    text: `Auto Lyrics ${state}: ${track.name}`,
                  });
                },
                origLyrics,
              );
            } finally {
              toast.close();
            }
          });
        }
      },
    }),
    0,
  );
});
