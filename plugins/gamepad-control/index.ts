import { plugins, Toast } from "@yuuza/mcloud";
import { checkGamepad } from "./handler";

plugins.registerPlugin({
  name: "GamePad Control",
  description: "Control the app using Gamepad.",
  version: "0.1.0",
  website: "https://github.com/lideming/MusicCloud-example-plugins",
});

window.addEventListener("gamepadconnected", (ev) => {
  Toast.show("Gamepad connected", 3000);
  const { gamepad } = ev;
  const timer = setInterval(() => {
    if (gamepad.connected) {
      checkGamepad(gamepad);
    } else {
      clearInterval(timer);
    }
  }, 10);
});

window.addEventListener("gamepaddisconnected", (ev) => {
  Toast.show("Gamepad disconnected", 3000);
  console.info(ev.gamepad);
});
