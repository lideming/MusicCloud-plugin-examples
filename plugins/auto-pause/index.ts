import { playerCore, plugins, UserStoreItem } from "@yuuza/mcloud";
import { Dialog, InputView, MessageBox, TextBtn } from "@yuuza/webfx";

plugins.registerPlugin({
  name: "Auto Pause",
  description: "Auto pause after 2 hours of inactivity",
  version: "1.0.0",
  website: "https://github.com/lideming/MusicCloud-example-plugins",
  settings: () => {
    openSettings();
  },
});

const settingStore = new UserStoreItem({
  key: "plugin-auto-pause-settings",
  value: { timeout: 120 },
});

document.body.addEventListener("pointermove", resetTimer, true);
document.body.addEventListener("keydown", resetTimer, true);

settingStore.fetch().then(() => {
  console.info("[auto-pause] settings", settingStore.value);
  resetTimer();
});

let timer: number | null = null;
function resetTimer() {
  if (timer) {
    clearTimeout(timer);
  }
  const timeout = settingStore.value?.timeout ?? 0;
  if (timeout <= 0) return;
  timer = setTimeout(() => {
    if (playerCore.state === "playing" || playerCore.state === "stalled") {
      playerCore.pause();
      new MessageBox()
        .setTitle("Auto Paused")
        .addResultBtns(["yes", "no"])
        .addText("Continue playing?")
        .showAndWaitResult()
        .then((result) => {
          if (result === "yes") {
            playerCore.play();
          }
        });
    }
  }, timeout * 60 * 1000) as unknown as number;
}

function openSettings() {
  const dialog = new Dialog();
  const input = new InputView({ placeholder: "7200" });
  dialog.title = "Auto Pause - Settings";
  dialog.addContent("Timeout (minutes):");
  dialog.addContent(input);
  input.value = String(settingStore.value!.timeout);
  dialog.addBtn(
    new TextBtn({
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
