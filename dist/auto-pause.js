(function (mcloud, webfx) {
  'use strict';

  mcloud.plugins.registerPlugin({
    name: "Auto Pause",
    description: "Auto pause after 2 hours of inactivity",
    version: "1.0.0",
    website: "https://github.com/lideming/MusicCloud-example-plugins",
    settings: () => {
      openSettings();
    },
  });

  const settingStore = new mcloud.UserStoreItem({
    key: "plugin-auto-pause-settings",
    value: { timeout: 120 },
  });

  document.body.addEventListener("pointermove", resetTimer, true);
  document.body.addEventListener("keydown", resetTimer, true);

  settingStore.fetch().then(() => {
    console.info("[auto-pause] settings", settingStore.value);
    resetTimer();
  });

  let timer = null;
  function resetTimer() {
    if (timer) {
      clearTimeout(timer);
    }
    const timeout = settingStore.value?.timeout ?? 0;
    if (timeout <= 0) return;
    timer = setTimeout(() => {
      if (mcloud.playerCore.state === "playing" || mcloud.playerCore.state === "stalled") {
        mcloud.playerCore.pause();
        new webfx.MessageBox()
          .setTitle("Auto Paused")
          .addResultBtns(["yes", "no"])
          .addText("Continue playing?")
          .showAndWaitResult()
          .then((result) => {
            if (result === "yes") {
              mcloud.playerCore.play();
            }
          });
      }
    }, timeout * 60 * 1000) ;
  }

  function openSettings() {
    const dialog = new webfx.Dialog();
    const input = new webfx.InputView({ placeholder: "7200" });
    dialog.title = "Auto Pause - Settings";
    dialog.addContent("Timeout (minutes):");
    dialog.addContent(input);
    input.value = String(settingStore.value.timeout);
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
      })
    );
    dialog.show();
  }

})(mcloud, mcloud.webfx);
