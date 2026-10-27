/* Alphadome QR poster helper — camera-safe codes drawn from the module matrix.
 *
 * qrcodejs 1.0.0 draws its own canvas with a fractional tile size: for a payment
 * link (33 modules) asked for at 190px it uses 190/33 = 5.7576px per module and
 * fills rects at fractional coordinates. Browsers anti-alias every one of those
 * edges into grey, and the canvas is exactly as wide as the code, so there is not
 * a single pixel of quiet zone on a panel that is dark. A phone camera needs both
 * whole-pixel modules and four modules of light margin, which is why a code that
 * "renders" can still be impossible to scan.
 *
 * This redraws from the same module matrix at an integer scale on a white ground,
 * so the on-screen copy, the downloaded PNG and a printed poster all decode.
 *
 * Loaded after vendor/qrcode.min.js. Exposes window.AlphaQR.
 */
(function (global) {
  'use strict';

  var QUIET = 4;        // QR spec: 4 modules of light margin on every side
  var MIN_MODULE = 6;   // 6px per module stays readable on a low-end phone camera
  var MAX_SIDE = 1024;

  // qrcodejs owns the encoding (mode, version, error correction, masking); we only
  // ask it for the finished matrix. `_oQRCode` is set by makeCode() before any
  // renderer runs, so this works whether or not the canvas path is available.
  function matrixFor(text, correctLevel) {
    if (typeof global.QRCode !== 'function') throw new Error('QRCode is not loaded');
    var holder = document.createElement('div');
    holder.style.display = 'none';
    document.body.appendChild(holder);
    var qr = null;
    try {
      qr = new global.QRCode(holder, {
        text: String(text),
        width: 256,
        height: 256,
        correctLevel: correctLevel == null ? global.QRCode.CorrectLevel.M : correctLevel,
      });
    } finally {
      if (holder.parentNode && holder.parentNode.removeChild) holder.parentNode.removeChild(holder);
    }
    var model = qr && qr._oQRCode;
    if (!model || typeof model.getModuleCount !== 'function' || typeof model.isDark !== 'function') {
      throw new Error('QRCode returned no module matrix');
    }
    return model;
  }

  function canvas(text, side, correctLevel) {
    var model = matrixFor(text, correctLevel);
    var count = model.getModuleCount();
    var total = count + QUIET * 2;
    var want = Math.min(MAX_SIDE, Math.max(side || 720, total * MIN_MODULE));
    var scale = Math.max(1, Math.floor(want / total));
    var px = total * scale;

    var cv = document.createElement('canvas');
    cv.width = px;
    cv.height = px;
    var ctx = cv.getContext('2d');

    // The white ground is the quiet zone: modules start 4 cells in from the edge.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < count; r++) {
      for (var c = 0; c < count; c++) {
        if (!model.isDark(r, c)) continue;
        ctx.fillRect((c + QUIET) * scale, (r + QUIET) * scale, scale, scale);
      }
    }
    return cv;
  }

  function dataUrl(text, side, correctLevel) {
    return canvas(text, side, correctLevel).toDataURL('image/png');
  }

  global.AlphaQR = {
    dataUrl: dataUrl,
    canvas: canvas,
    matrixFor: matrixFor,
    quietModules: QUIET,
  };
})(typeof window !== 'undefined' ? window : this);
