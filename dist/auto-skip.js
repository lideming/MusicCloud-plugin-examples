(function (mcloud, webfx) {
  'use strict';

  mcloud.plugins.registerPlugin({
    name: "Auto Skip",
    description: "Auto skip songs",
    version: "1.0.0",
    website: "https://github.com/lideming/MusicCloud-example-plugins",
    settings: () => {
      openSettings();
    },
  });

  const settingStore = new mcloud.UserStoreItem({
    key: "plugin-auto-skip-settings",
    value: { title: "instrumental|off vocal|オリジナル・カラオケ|インスト" },
  });

  settingStore.fetch().then(() => {
    console.info("[auto-skip] settings", settingStore.value);
  });

  webfx.hookFunction(mcloud.playerCore, "getNextTrack", (next) => (offset = 1) => {
    const titleRegex = settingStore.value?.title;
    if (!titleRegex) {
      return next(offset);
    }
    let firstTry = null;
    while (true) {
      const track = next(offset);
      if (track && firstTry === track) {
        // no more tracks available
        return track;
      }
      firstTry ??= track; // remember the first track
      if (track && new RegExp(titleRegex, "i").test(track.name)) {
        offset += offset > 0 ? 1 : -1; // skip instrumental tracks
        continue;
      }
      return track;
    }
  });

  function openSettings() {
    const dialog = new webfx.Dialog();
    const input = new webfx.InputView({ placeholder: "7200" });
    dialog.title = "Auto Skip - Settings";
    dialog.addContent("Skip for title (regex):");
    dialog.addContent(input);
    input.value = String(settingStore.value.title);
    dialog.addBtn(
      new webfx.TextBtn({
        text: "Save",
        right: true,
        onActive: async () => {
          const parsed = parseFloat(input.value);
          if (Number.isNaN(parsed)) return;
          await settingStore.concurrencyAwareUpdate((obj) => {
            return { ...obj, timeout: parsed };
          });
          dialog.close();
        },
      }),
    );
    dialog.show();
  }

})(mcloud, mcloud.webfx);
