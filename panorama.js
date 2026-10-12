/* Equirectangular video viewer. All public orientation values are degrees.
 * yaw > 0 looks left; pitch > 0 looks up. Video center is the forward view.
 * No libraries, network requests, or audio processing are used here.
 */
const MAX_CONTEXTS = 4;
const activeViewers = new Set();
const RAD = Math.PI / 180;
const VERTICAL_FOV = 72;

const vertexSource = `
attribute vec2 a_position;
varying vec2 v_position;
void main() {
  v_position = a_position;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const fragmentSource = `
precision highp float;
varying vec2 v_position;
uniform sampler2D u_video;
uniform float u_aspect;
uniform float u_tan_half_fov;
uniform float u_yaw;
uniform float u_pitch;
const float PI = 3.141592653589793;
void main() {
  vec3 ray = normalize(vec3(v_position.x * u_aspect * u_tan_half_fov,
                            v_position.y * u_tan_half_fov, -1.0));
  float cp = cos(u_pitch);
  float sp = sin(u_pitch);
  ray = vec3(ray.x, cp * ray.y - sp * ray.z, sp * ray.y + cp * ray.z);
  float cy = cos(u_yaw);
  float sy = sin(u_yaw);
  ray = vec3(cy * ray.x + sy * ray.z, ray.y, -sy * ray.x + cy * ray.z);
  vec2 uv = vec2(fract(0.5 + atan(ray.x, -ray.z) / (2.0 * PI)),
                 0.5 - asin(clamp(ray.y, -1.0, 1.0)) / PI);
  gl_FragColor = texture2D(u_video, uv);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || "Panorama shader could not be compiled.");
  }
  return shader;
}

function getSlot(viewer) {
  if (activeViewers.has(viewer)) return;
  if (activeViewers.size >= MAX_CONTEXTS) {
    const choices = [...activeViewers].sort((a, b) => {
      // Prefer to keep the viewer currently playing or being manipulated.
      const aBusy = Number(!a.video.paused) + Number(a.drag !== null);
      const bBusy = Number(!b.video.paused) + Number(b.drag !== null);
      return aBusy - bBusy || a.lastUsed - b.lastUsed;
    });
    choices[0]._releaseGL(true);
  }
  activeViewers.add(viewer);
}

export class PanoramaViewer {
  constructor(container, video, onOrientation = () => {}) {
    this.container = container;
    this.video = video;
    this.onOrientation = onOrientation;
    this.yaw = 0;
    this.pitch = 0;
    this.visible = false;
    this.disposed = false;
    this.fallback = false;
    this.drag = null;
    this.gl = null;
    this.canvas = null;
    this.frameRequest = null;
    this.videoFrameRequest = null;
    this.drawRequest = null;
    this.lastUsed = 0;
    this.listeners = [];
    this.hasPoster = false;
    this.originalVideo = {
      parent: video.parentNode,
      next: video.nextSibling,
      hidden: video.hidden,
      controls: video.controls,
      style: video.getAttribute("style"),
      className: video.className,
    };

    container.classList.add("panorama-viewer");
    this.poster = document.createElement("canvas");
    this.poster.className = "panorama-poster";
    this.poster.hidden = true;
    this.poster.setAttribute("aria-hidden", "true");
    this.hint = document.createElement("span");
    this.hint.className = "panorama-hint";
    this.hint.textContent = "Drag to look around";
    this.status = document.createElement("span");
    this.status.className = "panorama-loading";
    this.status.setAttribute("role", "status");
    this.status.textContent = "Loading panoramic video…";
    container.append(this.poster, this.hint, this.status);
    this._makeCanvas();

    this._listen(container, "pointerdown", (event) => this._pointerDown(event));
    this._listen(container, "pointermove", (event) => this._pointerMove(event));
    this._listen(container, "pointerup", (event) => this._pointerUp(event));
    this._listen(container, "pointercancel", (event) => this._pointerUp(event));
    this._listen(container, "lostpointercapture", () => {
      this.drag = null;
      this.container.classList.remove("is-dragging");
    });
    this._listen(container, "keydown", (event) => this._keyDown(event));
    for (const name of ["loadeddata", "seeked", "loadedmetadata", "canplay"]) {
      this._listen(video, name, () => {
        if (this.visible) this._activate();
        this._requestDraw();
      });
    }
    this._listen(video, "play", () => {
      if (this.visible) this._activate();
      this._startFrames();
    });
    for (const name of ["pause", "ended"]) {
      this._listen(video, name, () => {
        this._stopFrames();
        this._requestDraw();
      });
    }
    this._listen(video, "error", () => {
      this._showStatus("Video could not be loaded. Check the media file or browser format support.", true);
    });
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this._requestDraw());
      this.resizeObserver.observe(container);
    } else {
      this._listen(window, "resize", () => this._requestDraw());
    }
    if (typeof IntersectionObserver !== "undefined") {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        this.visible = entry.isIntersecting && entry.intersectionRatio > 0;
        if (this.visible) this._activate();
        else this._releaseGL(true);
      }, { threshold: [0, 0.01] });
      this.intersectionObserver.observe(container);
    } else {
      this.visible = true;
      this._activate();
    }
  }

  _listen(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    this.listeners.push(() => target.removeEventListener(type, handler, options));
  }

  _makeCanvas() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "panorama-canvas";
    this.canvas.tabIndex = 0;
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Interactive 360 degree video. Drag or use arrow keys to change viewing direction.");
    this.canvas.style.touchAction = "none";
    this.canvas.width = 640;
    this.canvas.height = 360;
    this.container.insertBefore(this.canvas, this.poster);
    this.canvas.addEventListener("webglcontextlost", (event) => {
      if (this.disposed || event.currentTarget !== this.canvas || !this.gl) return;
      event.preventDefault();
      this._releaseGL(false);
      this._showStatus("Panorama graphics context was interrupted. Click to restore the view.");
    });
  }

  _activate() {
    if (this.disposed || this.fallback || !this.visible) return;
    this.lastUsed = performance.now();
    if (this.gl) {
      this._requestDraw();
      this._startFrames();
      return;
    }
    getSlot(this);
    try {
      const gl = this.canvas.getContext("webgl", {
        alpha: false, depth: false, stencil: false, antialias: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) throw new Error("WebGL is unavailable.");
      this.gl = gl;
      const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
      const highPrecision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      const fragment = compile(gl, gl.FRAGMENT_SHADER,
        highPrecision && highPrecision.precision > 0
          ? fragmentSource : fragmentSource.replace("precision highp", "precision mediump"));
      this.program = gl.createProgram();
      gl.attachShader(this.program, vertex);
      gl.attachShader(this.program, fragment);
      gl.linkProgram(this.program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(this.program) || "Panorama shader could not be linked.");
      }
      gl.useProgram(this.program);
      this.buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(this.program, "a_position");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      this.texture = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      // CLAMP_TO_EDGE also supports non-power-of-two video dimensions in WebGL 1.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      // HTML video row 0 maps to texture v=0. The shader handles the latitude flip.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.uniform1i(gl.getUniformLocation(this.program, "u_video"), 0);
      this.uniforms = Object.fromEntries(["u_aspect", "u_tan_half_fov", "u_yaw", "u_pitch"]
        .map((name) => [name, gl.getUniformLocation(this.program, name)]));
      // Draw an available first frame immediately, so rapid context handoffs
      // can always retain a projected poster instead of a blank surface.
      this._draw();
      this._requestDraw();
      this._startFrames();
    } catch (error) {
      this._useFallback(error.message);
    }
  }

  _showStatus(message, error = false) {
    this.status.hidden = !message;
    this.status.textContent = message;
    this.status.className = error ? "panorama-error" : "panorama-loading";
  }

  _requestDraw() {
    if (!this.gl || !this.visible || this.disposed || this.drawRequest !== null) return;
    this.drawRequest = requestAnimationFrame(() => {
      this.drawRequest = null;
      this._draw();
    });
  }

  _draw() {
    const gl = this.gl;
    if (!gl || this.disposed || !this.visible) return;
    if (this.video.readyState < 2 || !this.video.videoWidth) return;
    const bounds = this.container.getBoundingClientRect();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(bounds.width * pixelRatio));
    const height = Math.max(1, Math.round(bounds.height * pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    try {
      gl.viewport(0, 0, width, height);
      gl.useProgram(this.program);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, this.video);
      gl.uniform1f(this.uniforms.u_aspect, width / height);
      gl.uniform1f(this.uniforms.u_tan_half_fov, Math.tan(VERTICAL_FOV * RAD / 2));
      gl.uniform1f(this.uniforms.u_yaw, this.yaw * RAD);
      gl.uniform1f(this.uniforms.u_pitch, this.pitch * RAD);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.poster.hidden = true;
      this._showStatus("");
      this.hasFrame = true;
    } catch (error) {
      this._useFallback(`Panoramic rendering failed: ${error.message}`);
    }
  }

  _startFrames() {
    if (!this.gl || !this.visible || this.video.paused || this.video.ended || this.disposed) return;
    if (typeof this.video.requestVideoFrameCallback === "function") {
      if (this.videoFrameRequest !== null) return;
      this.videoFrameRequest = this.video.requestVideoFrameCallback(() => {
        this.videoFrameRequest = null;
        this._draw();
        this._startFrames();
      });
    } else {
      if (this.frameRequest !== null) return;
      this.frameRequest = requestAnimationFrame(() => {
        this.frameRequest = null;
        this._draw();
        this._startFrames();
      });
    }
  }

  _stopFrames() {
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    if (this.videoFrameRequest !== null && typeof this.video.cancelVideoFrameCallback === "function") {
      this.video.cancelVideoFrameCallback(this.videoFrameRequest);
    }
    this.frameRequest = null;
    this.videoFrameRequest = null;
  }

  _releaseGL(savePoster) {
    this._stopFrames();
    if (this.drawRequest !== null) cancelAnimationFrame(this.drawRequest);
    this.drawRequest = null;
    activeViewers.delete(this);
    const gl = this.gl;
    if (!gl) return;
    if (savePoster && this.hasFrame) {
      try {
        this.poster.width = this.canvas.width;
        this.poster.height = this.canvas.height;
        const context = this.poster.getContext("2d");
        context.drawImage(this.canvas, 0, 0);
        this.poster.hidden = false;
        this.hasPoster = true;
      } catch (_) { /* A poster is optional when the media is cross-origin. */ }
    }
    this.gl = null;
    this.hasFrame = false;
    if (this.texture) gl.deleteTexture(this.texture);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
    const loseContext = gl.getExtension("WEBGL_lose_context");
    if (loseContext) loseContext.loseContext();
    this.canvas.remove();
    if (!this.disposed && !this.fallback) {
      this._makeCanvas();
      if (!this.hasPoster) this._showStatus("Click or drag to explore the panorama");
    }
  }

  _useFallback(reason) {
    if (this.fallback || this.disposed) return;
    this.fallback = true;
    this._releaseGL(false);
    if (this.canvas) this.canvas.remove();
    this.poster.hidden = true;
    this.hint.hidden = true;
    this.container.classList.add("panorama-fallback");
    this.video.hidden = false;
    this.video.controls = true;
    this.video.classList.add("panorama-fallback-video");
    this.video.style.display = "block";
    this.video.style.width = "100%";
    this.video.style.height = "100%";
    this.video.style.objectFit = "contain";
    this.container.insertBefore(this.video, this.status);
    this._showStatus("Panorama view is unsupported in this browser. Showing the original 360° video.", true);
    this.status.title = reason;
  }

  _pointerDown(event) {
    if (this.fallback || (event.pointerType === "mouse" && event.button !== 0)) return;
    if (event.target !== this.canvas && event.target !== this.poster && event.target !== this.container) return;
    this._activate();
    if (!this.gl) return;
    this.canvas.focus({ preventScroll: true });
    this.drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    this.container.setPointerCapture(event.pointerId);
    this.container.classList.add("is-dragging");
    event.preventDefault();
  }

  _pointerMove(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const scale = VERTICAL_FOV / Math.max(this.container.clientHeight, 1);
    const dx = event.clientX - this.drag.x;
    const dy = event.clientY - this.drag.y;
    this.drag.x = event.clientX;
    this.drag.y = event.clientY;
    this.setOrientation(this.yaw + dx * scale, this.pitch + dy * scale);
    event.preventDefault();
  }

  _pointerUp(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    this.container.classList.remove("is-dragging");
    if (this.container.hasPointerCapture(event.pointerId)) this.container.releasePointerCapture(event.pointerId);
  }

  _keyDown(event) {
    if (this.fallback || event.target !== this.canvas) return;
    const step = event.shiftKey ? 15 : 5;
    const changes = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (!changes[event.key]) return;
    this._activate();
    const [yaw, pitch] = changes[event.key];
    this.setOrientation(this.yaw + yaw, this.pitch + pitch);
    event.preventDefault();
  }

  setOrientation(yaw, pitch) {
    if (this.disposed || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
    this.yaw = ((yaw + 180) % 360 + 360) % 360 - 180;
    this.pitch = Math.max(-85, Math.min(85, pitch));
    this.lastUsed = performance.now();
    if (this.visible) this._activate();
    this._requestDraw();
    this.onOrientation({ yaw: this.yaw, pitch: this.pitch });
  }

  reset() {
    this.setOrientation(0, 0);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.intersectionObserver?.disconnect();
    this.resizeObserver?.disconnect();
    this.listeners.forEach((remove) => remove());
    this.listeners = [];
    this._releaseGL(false);
    this.canvas?.remove();
    this.poster.remove();
    this.hint.remove();
    this.status.remove();
    this.container.classList.remove("panorama-viewer", "panorama-fallback", "is-dragging");
    if (this.fallback) {
      const original = this.originalVideo;
      this.video.hidden = original.hidden;
      this.video.controls = original.controls;
      this.video.className = original.className;
      if (original.style === null) this.video.removeAttribute("style");
      else this.video.setAttribute("style", original.style);
      if (original.parent) {
        const next = original.next?.parentNode === original.parent ? original.next : null;
        original.parent.insertBefore(this.video, next);
      } else this.video.remove();
    }
  }
}
