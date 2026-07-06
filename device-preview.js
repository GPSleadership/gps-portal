/* GPS Portal — device preview toggle (coach-only dev aid).
 *
 * Renders the current page inside a real phone-width iframe so mobile layout can
 * be eyeballed from a desktop. Media queries key off the iframe width, so what
 * you see is the TRUE mobile rendering, not a fake CSS shrink.
 *
 * Enable once with ?dev=1 on any portal URL (remembered per-browser); disable
 * with ?dev=0. End users never see it — they don't set the flag. The inner
 * iframe instance is marked ?__mp=1 so it never shows its own toggle (no nesting).
 */
(function () {
  var params = new URLSearchParams(location.search);
  if (params.get('__mp') === '1') return;                 // inner iframe: no toggle
  try {
    if (params.get('dev') === '1') localStorage.setItem('gps_dev_preview', '1');
    if (params.get('dev') === '0') localStorage.removeItem('gps_dev_preview');
  } catch (e) { /* private mode */ }
  var enabled = false;
  try { enabled = localStorage.getItem('gps_dev_preview') === '1'; } catch (e) {}
  if (!enabled) return;

  var DEVICES = [
    { name: 'iPhone SE', w: 375, h: 667 },
    { name: 'iPhone 15', w: 390, h: 844 },
    { name: 'Pro Max',   w: 430, h: 932 },
    { name: 'iPad mini', w: 768, h: 1024 }
  ];
  var idx = 1, landscape = false, overlay = null;

  function iframeSrc() {
    var u = new URL(location.href);
    u.searchParams.delete('dev');
    u.searchParams.set('__mp', '1');
    return u.toString();
  }

  var FONT = "600 13px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif";
  var btn = document.createElement('button');
  btn.textContent = 'Mobile preview';
  btn.setAttribute('aria-label', 'Open mobile preview');
  btn.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483000;background:#004369;color:#fff;border:none;border-radius:22px;padding:10px 16px;font:' + FONT + ';box-shadow:0 4px 14px rgba(0,0,0,.28);cursor:pointer;';

  function mount() { if (document.body && !btn.parentNode) document.body.appendChild(btn); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  btn.onclick = open;

  function render() {
    var d = DEVICES[idx];
    var w = landscape ? d.h : d.w, h = landscape ? d.w : d.h;
    var wrap = overlay.querySelector('#gmpWrap');
    wrap.style.width = w + 'px';
    wrap.style.height = Math.min(h, window.innerHeight - 96) + 'px';
    overlay.querySelector('#gmpSize').textContent = d.name + ' · ' + w + ' x ' + h;
    Array.prototype.forEach.call(overlay.querySelectorAll('.gmp-dev'), function (b, i) {
      b.style.background = (i === idx) ? '#01949A' : 'transparent';
      b.style.color = (i === idx) ? '#fff' : '#cfe0ea';
    });
  }

  function open() {
    if (overlay) { overlay.style.display = 'flex'; return; }
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483001;background:rgba(8,18,28,.85);display:flex;flex-direction:column;align-items:center;';
    var bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center;padding:12px;color:#fff;font:' + FONT + ';';
    bar.innerHTML =
      DEVICES.map(function (d, i) { return '<button class="gmp-dev" data-i="' + i + '" style="border:1px solid #2a4a63;border-radius:16px;padding:6px 12px;cursor:pointer;font:inherit;background:transparent;color:#cfe0ea;">' + d.name + '</button>'; }).join('') +
      '<button id="gmpRot" style="border:1px solid #2a4a63;border-radius:16px;padding:6px 12px;cursor:pointer;font:inherit;background:transparent;color:#cfe0ea;">Rotate</button>' +
      '<span id="gmpSize" style="margin:0 6px;color:#9fc0d6;"></span>' +
      '<button id="gmpClose" style="border:none;border-radius:16px;padding:6px 14px;cursor:pointer;font:inherit;background:#DB1F48;color:#fff;">Close</button>';
    var wrap = document.createElement('div');
    wrap.id = 'gmpWrap';
    wrap.style.cssText = 'background:#000;border-radius:26px;padding:10px;box-shadow:0 20px 60px rgba(0,0,0,.5);transition:width .15s,height .15s;';
    var frame = document.createElement('iframe');
    frame.src = iframeSrc();
    frame.style.cssText = 'width:100%;height:100%;border:none;border-radius:18px;background:#fff;';
    wrap.appendChild(frame);
    overlay.appendChild(bar); overlay.appendChild(wrap);
    document.body.appendChild(overlay);

    overlay.querySelector('#gmpClose').onclick = function () { overlay.style.display = 'none'; };
    overlay.querySelector('#gmpRot').onclick = function () { landscape = !landscape; render(); };
    Array.prototype.forEach.call(overlay.querySelectorAll('.gmp-dev'), function (b) {
      b.onclick = function () { idx = +b.getAttribute('data-i'); render(); };
    });
    overlay.addEventListener('click', function (e) { if (e.target === overlay) overlay.style.display = 'none'; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && overlay && overlay.style.display !== 'none') overlay.style.display = 'none'; });
    render();
  }
})();
