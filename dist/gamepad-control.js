(function (mcloud) {
  'use strict';

  function checkGamepad(gamepad) {
    const { buttons, axes } = gamepad;
    const [leftX, leftY, rightX, rightY] = axes;
    checkKey("left-up", true, leftY < -0.5);
    checkKey("left-down", true, leftY > 0.5);
    checkKey("left-left", true, leftX < -0.5);
    checkKey("left-right", true, leftX > 0.5);
    checkKey("A", false, buttons[0].pressed);
    checkKey("B", false, buttons[1].pressed);
    checkKey("X", false, buttons[2].pressed);
  }

  const startPress = {};
  const lastPress = {};

  function checkKey(key, canRepeat, pressed) {
    if (pressed) {
      if (!startPress[key]) {
        startPress[key] = Date.now();
      } else {
        if (canRepeat && Date.now() - startPress[key] < 300) {
          return;
        } else if (!canRepeat) {
          return;
        }
      }
      if (lastPress[key] && Date.now() - lastPress[key] < 50) {
        return;
      }
      lastPress[key] = Date.now();
      handleEvent(key);
    } else {
      startPress[key] = lastPress[key] = 0;
    }
  }

  function handleEvent(key) {
    console.info(key);
    document.body.classList.add("keyboard-input");
    if (key === "left-down") {
      moveFocus(1);
    } else if (key === "left-up") {
      moveFocus(-1);
    } else if (key === "left-right") {
      moveFocus(1, true);
    } else if (key === "left-left") {
      moveFocus(-1, true);
    } else if (key === "A") {
      clickFocus();
    } else if (key === "B") {
      back();
    } else if (key === "X") {
      contextMenu();
    }
  }

  // TODO: maybe make this accepts (x, y) and consider all directions
  function moveFocus(delta, leftRight = false) {
    const activeElement = document.activeElement ;
    var selector =
      'a:not([disabled]), button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([disabled]):not([tabindex="-1"])';
    var focusable = Array.prototype.filter.call(
      document.querySelectorAll(selector),
      (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === activeElement,
    ) ;
    if (activeElement) {
      if (!leftRight) {
        var index = focusable.indexOf(activeElement);
        if (index > -1) {
          var nextElement = focusable[index + delta];
          nextElement?.focus();
        } else {
          focusable[0].focus();
        }
      } else {
        const rect = activeElement.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        let element = null;
        let score = null; // lower is better
        for (const el of focusable) {
          const curRect = el.getBoundingClientRect();
          const curX = curRect.x + curRect.width / 2;
          const curY = curRect.y + curRect.height / 2;
          if (curX === x || Math.sign(curX - x) !== delta) continue;
          const curScore = Math.abs(curX - x) + Math.abs(curY - y) * 10;
          if (score === null || curScore < score) {
            score = curScore;
            element = el;
          }
        }
        element?.focus();
      }
    } else {
      focusable[0].focus();
    }
  }

  function clickFocus() {
    (document.activeElement )?.click?.();
  }

  function back() {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "Escape",
        key: "Escape",
        keyCode: 27,
        bubbles: true,
      }),
    );
  }

  function contextMenu() {
    document.activeElement?.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
      }),
    );
  }

  mcloud.plugins.registerPlugin({
    name: "GamePad Control",
    description: "Control the app using Gamepad.",
    version: "0.1.0",
    website: "https://github.com/lideming/MusicCloud-example-plugins",
  });

  window.addEventListener("gamepadconnected", (ev) => {
    mcloud.Toast.show("Gamepad connected", 3000);
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
    mcloud.Toast.show("Gamepad disconnected", 3000);
    console.info(ev.gamepad);
  });

})(mcloud);
