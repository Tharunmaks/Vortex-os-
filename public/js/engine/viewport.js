// Vortex Engine — Viewport: paints layout commands to a <canvas>, handles scrolling and hit-testing.

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class Viewport {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.layout = null;
    this.bg = '#ffffff';
    this.scrollY = 0;
    this.zoom = 1;
    this.cssW = 0;
    this.cssH = 0;
    this.dpr = 1;
    this.raf = 0;
    this.onScroll = null;
  }

  /** Width available to the page, in CSS px at zoom 1. */
  get pageWidth() {
    return this.cssW / this.zoom;
  }

  get pageHeight() {
    return this.cssH / this.zoom;
  }

  get maxScroll() {
    return Math.max(0, (this.layout ? this.layout.height : 0) - this.pageHeight);
  }

  resize(w, h) {
    this.dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    this.cssW = Math.max(1, Math.floor(w));
    this.cssH = Math.max(1, Math.floor(h));
    this.canvas.width = Math.floor(this.cssW * this.dpr);
    this.canvas.height = Math.floor(this.cssH * this.dpr);
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.scrollTo(this.scrollY);
  }

  setLayout(layout) {
    this.layout = layout;
    this.bg = layout ? layout.bg : '#ffffff';
    this.scrollTo(this.scrollY);
  }

  scrollTo(y) {
    const next = Math.max(0, Math.min(this.maxScroll, y));
    const changed = next !== this.scrollY;
    this.scrollY = next;
    this.draw();
    if (changed && this.onScroll) this.onScroll(next);
  }

  scrollBy(dy) {
    this.scrollTo(this.scrollY + dy);
  }

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  paint() {
    const { ctx, dpr, zoom } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const L = this.layout;
    if (!L) return;
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, 0, -this.scrollY * dpr * zoom);
    ctx.textBaseline = 'alphabetic';
    const y0 = this.scrollY - 4;
    const y1 = this.scrollY + this.pageHeight + 4;
    let font = '';
    for (const c of L.cmds) {
      if (c.t === 'text') {
        if (c.y + 6 < y0 || c.y - (c.fs || 20) > y1) continue;
        if (c.font !== font) { ctx.font = c.font; font = c.font; }
        ctx.globalAlpha = 1;
        ctx.fillStyle = c.c;
        ctx.fillText(c.text, c.x, c.y);
        if (c.deco) {
          const fs = c.fs || 14;
          ctx.fillRect(c.x, c.deco === 'line-through' ? c.y - fs * 0.3 : c.deco === 'overline' ? c.y - fs * 0.85 : c.y + Math.max(1, fs * 0.1), c.w, Math.max(1, fs / 14));
        }
      } else if (c.t === 'box') {
        if (c.y > y1 || c.y + c.h < y0) continue;
        ctx.globalAlpha = c.alpha ?? 1;
        if (c.bg) {
          ctx.fillStyle = c.bg;
          if (c.r > 0) { roundRect(ctx, c.x, c.y, c.w, c.h, c.r); ctx.fill(); } else ctx.fillRect(c.x, c.y, c.w, c.h);
        }
        const [bt, br, bb, bl] = c.b;
        if (bt) { ctx.fillStyle = c.bc[0]; ctx.fillRect(c.x, c.y, c.w, bt); }
        if (bb) { ctx.fillStyle = c.bc[2]; ctx.fillRect(c.x, c.y + c.h - bb, c.w, bb); }
        if (bl) { ctx.fillStyle = c.bc[3]; ctx.fillRect(c.x, c.y + bt, bl, Math.max(0, c.h - bt - bb)); }
        if (br) { ctx.fillStyle = c.bc[1]; ctx.fillRect(c.x + c.w - br, c.y + bt, br, Math.max(0, c.h - bt - bb)); }
      } else if (c.t === 'img') {
        if (c.y > y1 || c.y + c.h < y0 || !c.img) continue;
        ctx.globalAlpha = c.alpha ?? 1;
        try { ctx.drawImage(c.img, c.x, c.y, c.w, c.h); } catch { /* broken image */ }
      }
    }
    ctx.globalAlpha = 1;
    // Scrollbar thumb.
    if (this.maxScroll > 0) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const total = L.height * zoom;
      const th = Math.max(28, (this.cssH * this.cssH) / total);
      const ty = (this.scrollY * zoom * (this.cssH - th)) / (this.maxScroll * zoom);
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      roundRect(ctx, this.cssW - 7, ty + 2, 5, th - 4, 3);
      ctx.fill();
    }
  }

  toPage(px, py) {
    return { x: px / this.zoom, y: py / this.zoom + this.scrollY };
  }

  linkAt(px, py) {
    if (!this.layout) return null;
    const { x, y } = this.toPage(px, py);
    for (let i = this.layout.links.length - 1; i >= 0; i--) {
      const l = this.layout.links[i];
      if (x >= l.x && x <= l.x + l.w && y >= l.y && y <= l.y + l.h) return l;
    }
    return null;
  }

  buttonAt(px, py) {
    if (!this.layout) return null;
    const { x, y } = this.toPage(px, py);
    for (const c of this.layout.controls) {
      if (c.ctl === 'button' && x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h) return c;
    }
    return null;
  }
}
