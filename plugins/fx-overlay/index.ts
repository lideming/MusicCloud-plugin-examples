import { playerCore, playerFX, plugins, Toast, ui } from "@yuuza/mcloud";
import { mountView, Ref, View } from "@yuuza/webfx";

plugins.registerPlugin({
  name: "FX Overlay",
  description: "",
  version: "1.0.0",
  website: "https://github.com/lideming/MusicCloud-example-plugins",
});

playerFX.initWebAudio().then(() => {
  const canvas = new View({
    tag: "canvas.fx-overlay",
    style: `position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1;`,
  });
  const splitter = playerFX.ctx.createChannelSplitter(2);
  const analyserL = playerFX.ctx.createAnalyser();
  analyserL.fftSize = 2048;
  const analyserR = playerFX.ctx.createAnalyser();
  analyserR.fftSize = 2048;

  playerFX.source.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  const isVisible = new Ref(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", () => {
    isVisible.value = document.visibilityState === "visible";
  });
  const isActive = Ref.computed(() => {
    console.info("[fx-overlay] isActive", playerCore.state, isVisible.value);
    return playerCore.state === "playing" && isVisible.value!;
  });

  mountView(ui.mainContainer.dom, canvas);
  initOverlay(canvas.dom as HTMLCanvasElement, analyserL, analyserR, isActive);
});

function initOverlay(
  canvas: HTMLCanvasElement,
  analyserL: AnalyserNode,
  analyserR: AnalyserNode,
  isActive: Ref<boolean>,
) {
  const vertexShaderSource = `
    attribute vec2 a_position;
    varying vec2 v_texCoord;
    void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_position * 0.5 + 0.5;
    }
  `;

  const fragmentShaderSource = `
    precision mediump float;
    uniform sampler2D u_frequencyTexL;
    uniform sampler2D u_frequencyTexR;
    varying vec2 v_texCoord;

    void main() {
        float freqCoordX = pow(v_texCoord.y, 2.0);

        float loudness = 0.0;
        float glowWidth = 0.1;

        if (v_texCoord.x < glowWidth) {
            loudness = texture2D(u_frequencyTexL, vec2(freqCoordX, 0.5)).r;
        } else if (v_texCoord.x > 1.0 - glowWidth) {
            loudness = texture2D(u_frequencyTexR, vec2(freqCoordX, 0.5)).r;
        }

        if (loudness < 0.01) {
            discard;
        }

        float glowFactor = 0.0;
        if (v_texCoord.x < glowWidth) {
            glowFactor = smoothstep(glowWidth, 0.0, v_texCoord.x);
        } else if (v_texCoord.x > 1.0 - glowWidth) {
            glowFactor = smoothstep(1.0 - glowWidth, 1.0, v_texCoord.x);
        }
        glowFactor = pow(glowFactor, 1.5);
        
        vec3 lowFreqColor = vec3(0.9, 0.4, 0.1);
        vec3 highFreqColor = vec3(0.0, 0.4, 0.8);
        vec3 color = mix(lowFreqColor, highFreqColor, v_texCoord.y);

        float intensity = min(pow(loudness, 1.3), 0.8);

        gl_FragColor = vec4(color, intensity * glowFactor);
    }
  `;

  const gl = canvas.getContext("webgl", { alpha: true });
  if (!gl) {
    console.error("Failed to initialize WebGL");
    return;
  }

  function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("compileShader error:", gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("linkProgram error:", gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    return program;
  }

  function createFrequencyTexture(gl, data) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.LUMINANCE,
      data.length,
      1,
      0,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      data,
    );
    return texture;
  }

  function updateFrequencyTexture(gl, texture, data) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      data.length,
      1,
      gl.LUMINANCE,
      gl.UNSIGNED_BYTE,
      data,
    );
  }

  function resizeCanvasToDisplaySize(canvas) {
    const displayWidth = canvas.clientWidth;
    const displayHeight = canvas.clientHeight;
    if (canvas.width !== displayWidth || canvas.height !== displayHeight) {
      canvas.width = displayWidth;
      canvas.height = displayHeight;
      return true;
    }
    return false;
  }

  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createShader(
    gl,
    gl.FRAGMENT_SHADER,
    fragmentShaderSource,
  );
  const program = createProgram(gl, vertexShader, fragmentShader);

  if (!program) {
    return;
  }

  const positionAttributeLocation = gl.getAttribLocation(program, "a_position");
  const texLUniformLocation = gl.getUniformLocation(program, "u_frequencyTexL");
  const texRUniformLocation = gl.getUniformLocation(program, "u_frequencyTexR");

  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );

  const binsToIgnore = 3;
  const bufferLength = analyserL.frequencyBinCount;
  const displayDataL = new Uint8Array(bufferLength - binsToIgnore);
  const displayDataR = new Uint8Array(bufferLength - binsToIgnore);
  const frequencyDataL = new Uint8Array(bufferLength);
  const frequencyDataR = new Uint8Array(bufferLength);

  const textureL = createFrequencyTexture(gl, displayDataL);
  const textureR = createFrequencyTexture(gl, displayDataR);

  const render = () => {
    resizeCanvasToDisplaySize(gl.canvas);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);

    analyserL.getByteFrequencyData(frequencyDataL);
    analyserR.getByteFrequencyData(frequencyDataR);

    for (let i = binsToIgnore; i < bufferLength; i++) {
      const decayFactor = 0.3;
      displayDataL[i - binsToIgnore] *= decayFactor;
      displayDataR[i - binsToIgnore] *= decayFactor;
      if (displayDataL[i - binsToIgnore] < frequencyDataL[i]) {
        displayDataL[i - binsToIgnore] = frequencyDataL[i];
      }
      if (displayDataR[i - binsToIgnore] < frequencyDataR[i]) {
        displayDataR[i - binsToIgnore] = frequencyDataR[i];
      }
    }

    updateFrequencyTexture(gl, textureL, displayDataL);
    updateFrequencyTexture(gl, textureR, displayDataR);

    gl.enableVertexAttribArray(positionAttributeLocation);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.vertexAttribPointer(positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, textureL);
    gl.uniform1i(texLUniformLocation, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, textureR);
    gl.uniform1i(texRUniformLocation, 1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const clear = () => {
    resizeCanvasToDisplaySize(gl.canvas);
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    for (let i = 0; i < bufferLength - binsToIgnore; i++) {
      displayDataL[i] = 0;
      displayDataR[i] = 0;
    }
  };

  let timer = 0;
  Ref.effect(() => {
    if (isActive.value) {
      render();
      timer = setInterval(render, 1000 / 60) as unknown as number;
    } else {
      clearInterval(timer);
      timer = 0;
      clear();
    }
  });
}
