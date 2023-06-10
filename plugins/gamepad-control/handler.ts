export function checkGamepad(gamepad: Gamepad) {
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

const startPress: Record<string, number> = {};
const lastPress: Record<string, number> = {};

function checkKey(key: string, canRepeat: boolean, pressed: boolean) {
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

function handleEvent(key: string) {
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
function moveFocus(delta: number, leftRight = false) {
  const activeElement = document.activeElement as HTMLElement;
  var selector =
    'a:not([disabled]), button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([disabled]):not([tabindex="-1"])';
  var focusable = Array.prototype.filter.call(
    document.querySelectorAll(selector),
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === activeElement,
  ) as HTMLElement[];
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
      let element: HTMLElement | null = null;
      let score: number | null = null; // lower is better
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
  (document.activeElement as HTMLElement)?.click?.();
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
