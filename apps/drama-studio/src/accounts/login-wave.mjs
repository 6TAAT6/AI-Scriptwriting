// 复用 Toonflow/outputs/xingyan-preview-20260924/before/data/web/script-library-preview/login-wave.mjs 的绿色登录动效；仅适配本项目主题与恢复尺寸。
/** 登录方点背景：缓存网格和波纹距离，跟随显示刷新；隐藏与销毁停止绘制。 */
export function mountLoginWave(canvas, host = canvas.parentElement) {
  const doc = canvas.ownerDocument, win = doc.defaultView, ctx = canvas.getContext('2d');
  if (!ctx) return () => {};
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)');
  const waves = [], levels = 24, heads = new Int32Array(levels);
  // 高斯包络只建立一次，逐帧波纹不再计算指数与距离。
  const envelope = Float32Array.from({ length: 256 }, (_, i) => Math.exp(-i * i / 4096));
  let width = 0, height = 0, frame = 0, disposed = false, previousTime = 0;
  let points = [], next = new Int32Array(), sizes = new Float32Array(), offsetsX = new Float32Array(), offsetsY = new Float32Array();
  let columns = [], rows = [], lastWave = -Infinity, lastX = -Infinity, lastY = -Infinity;
  let pointerX = 0, pointerY = 0, haloX = 0, haloY = 0, haloOpacity = 0, pointerInside = false;
  let halo = null, haloDark = null;

  function makeHalo(dark) {
    const image = doc.createElement('canvas'); image.width = image.height = 256;
    const brush = image.getContext('2d');
    if (!brush) return null;
    const color = dark ? '103,238,204' : '32,172,145';
    const glow = brush.createRadialGradient(128, 128, 0, 128, 128, 128);
    glow.addColorStop(0, `rgba(${color},0)`);
    glow.addColorStop(.35, `rgba(${color},.008)`);
    glow.addColorStop(.66, `rgba(${color},.045)`);
    glow.addColorStop(.79, `rgba(${color},.13)`);
    glow.addColorStop(.84, `rgba(${color},.045)`);
    glow.addColorStop(1, `rgba(${color},0)`);
    brush.fillStyle = glow; brush.fillRect(0, 0, 256, 256);
    brush.beginPath(); brush.arc(128, 128, 102, 0, Math.PI * 2);
    brush.strokeStyle = `rgba(${color},.22)`; brush.lineWidth = .8; brush.stroke();
    return image;
  }

  function draw(time) {
    frame = 0;
    if (disposed) return;
    if (!canvas.isConnected) { destroy(); return; }
    if (doc.hidden) return;
    const elapsed = Math.min(64, Math.max(0, time - previousTime)); previousTime = time;
    const now = time / 1000, dark = doc.documentElement.dataset.theme === 'dark';
    ctx.clearRect(0, 0, width, height);
    if (pointerInside && !motion.matches && time - lastWave >= 850) addWave(time);
    while (waves.length && time - waves[0].time >= 1800) waves.shift();
    for (const column of columns) column.drift = motion.matches ? 0 : Math.sin(column.phase - now * .65) * .08;
    for (const row of rows) row.drift = motion.matches ? 0 : Math.cos(row.phase + now * .35);
    heads.fill(-1);
    for (let i = 0; i < points.length; i++) {
      const p = points[i]; let ripple = 0, shiftX = 0, shiftY = 0;
      for (const wave of waves) {
        const age = (time - wave.time) / 1000;
        const distance = wave.distances[i], edge = distance - (18 + age * 110);
        const index = Math.round(Math.abs(edge) * 64 / 26);
        if (index < envelope.length) {
          const ring = envelope[index] * (1 - age / 1.8);
          const shift = Math.sin(edge * .09) * ring * 7 / Math.max(1, distance);
          ripple += ring; shiftX += (p.x - wave.x) * shift; shiftY += (p.y - wave.y) * shift;
        }
      }
      const strength = Math.max(0, Math.min(1, p.base + columns[p.col].drift * rows[p.row].drift * p.band + ripple * .48));
      sizes[i] = .65 + strength * 4.7; offsetsX[i] = shiftX; offsetsY[i] = shiftY;
      const bucket = Math.min(levels - 1, Math.round(strength * (levels - 1)));
      next[i] = heads[bucket]; heads[bucket] = i;
    }
    ctx.fillStyle = dark ? '#34cca9' : '#08a589';
    for (let bucket = 0; bucket < levels; bucket++) {
      if (heads[bucket] < 0) continue;
      ctx.globalAlpha = (dark ? .06 : .035) + bucket / (levels - 1) * (dark ? .46 : .7);
      ctx.beginPath();
      for (let i = heads[bucket]; i >= 0; i = next[i]) {
        const p = points[i], size = sizes[i]; ctx.rect(p.x - size / 2 + offsetsX[i], p.y - size / 2 + offsetsY[i], size, size);
      }
      ctx.fill();
    }
    if (!motion.matches) {
      ctx.strokeStyle = dark ? '#67eecc' : '#20ac91'; ctx.lineWidth = 1.1;
      for (const wave of waves) {
        const age = Math.max(0, (time - wave.time) / 1000), radius = 18 + age * 110;
        const alpha = Math.min(1, age / .12) * Math.pow(Math.max(0, 1 - age / 1.8), 1.3) * .25;
        ctx.globalAlpha = alpha; ctx.beginPath(); ctx.arc(wave.x, wave.y, radius, 0, Math.PI * 2); ctx.stroke();
        if (radius > 36) { ctx.globalAlpha = alpha * .4; ctx.beginPath(); ctx.arc(wave.x, wave.y, radius - 18, 0, Math.PI * 2); ctx.stroke(); }
      }
      const follow = 1 - Math.exp(-elapsed / 38), fade = 1 - Math.exp(-elapsed / 115);
      haloX += (pointerX - haloX) * follow; haloY += (pointerY - haloY) * follow;
      haloOpacity += ((pointerInside ? 1 : 0) - haloOpacity) * fade;
      if (haloOpacity > .002) {
        if (haloDark !== dark) { halo = makeHalo(dark); haloDark = dark; }
        ctx.globalAlpha = haloOpacity;
        if (halo) ctx.drawImage(halo, haloX - 72, haloY - 72, 144, 144);
      }
      frame = win.requestAnimationFrame(draw);
    }
    ctx.globalAlpha = 1;
  }

  function resize() {
    if (disposed) return;
    const rect = canvas.getBoundingClientRect();
    // 样式表可能晚于模块到达，不能将canvas默认300×150误当作视口尺寸。
    width = Math.max(1, win.innerWidth || rect.width); height = Math.max(1, win.innerHeight || rect.height);
    const ratio = Math.min(win.devicePixelRatio || 1, 1.5, Math.sqrt(8000000 / (width * height)));
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const step = Math.max(width < 600 ? 14 : 17, Math.sqrt(width * height / 8000));
    columns = []; rows = []; points = []; waves.length = 0;
    for (let x = 10; x < width; x += step) columns.push({ x, phase: x * .006, center: Math.pow(Math.max(0, Math.sin(Math.PI * x / width)), .7), drift: 0 });
    for (let y = 10; y < height; y += step) rows.push({ y, phase: y * .007, band: Math.exp(-Math.pow((y - height * .53) / Math.max(140, height * .2), 2) * 2), drift: 0 });
    for (let row = 0; row < rows.length; row++) for (let col = 0; col < columns.length; col++) {
      points.push({ x: columns[col].x, y: rows[row].y, col, row, band: rows[row].band, base: columns[col].center * rows[row].band });
    }
    next = new Int32Array(points.length); sizes = new Float32Array(points.length); offsetsX = new Float32Array(points.length); offsetsY = new Float32Array(points.length);
    if (frame) win.cancelAnimationFrame(frame);
    previousTime = win.performance.now(); draw(previousTime);
  }

  function move(event) {
    if (disposed || motion.matches || doc.hidden || event.pointerType === 'touch') return;
    const rect = canvas.getBoundingClientRect();
    pointerX = event.clientX - rect.x; pointerY = event.clientY - rect.y;
    if (!pointerInside) { haloX = pointerX; haloY = pointerY; }
    pointerInside = true;
    const time = win.performance.now();
    if (time - lastWave < 100 || Math.hypot(pointerX - lastX, pointerY - lastY) < 10) return;
    addWave(time);
  }
  function addWave(time) {
    lastWave = time; lastX = pointerX; lastY = pointerY;
    waves.push({ time, x: pointerX, y: pointerY, distances: Float32Array.from(points, p => Math.hypot(p.x - pointerX, p.y - pointerY)) });
    if (waves.length > 4) waves.shift();
  }
  function leave() { pointerInside = false; }
  function visibility() {
    win.cancelAnimationFrame(frame); frame = 0; waves.length = 0; haloOpacity = 0; pointerInside = false;
    if (!doc.hidden) resize();
  }
  function destroy() {
    if (disposed) return;
    disposed = true; win.cancelAnimationFrame(frame); frame = 0; waves.length = 0; halo = null; points = [];
    win.removeEventListener('resize', resize); win.removeEventListener('blur', leave);
    host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave);
    doc.removeEventListener('visibilitychange', visibility); motion.removeEventListener('change', visibility);
  }
  host.addEventListener('pointermove', move, { passive: true }); host.addEventListener('pointerleave', leave);
  win.addEventListener('resize', resize); win.addEventListener('blur', leave);
  doc.addEventListener('visibilitychange', visibility); motion.addEventListener('change', visibility);
  resize(); return destroy;
}
