/* global matchMedia, document */
// Penmoss (T28, A251): the remembered theme for the first paint. A classic script in
// <head>, so it runs before the app's bundle has loaded: it applies the variables
// ThemeController remembered (src/theme/controller.ts, `penmoss.theme`) for the mode,
// or for the system's scheme in System mode. With nothing remembered the stylesheet's
// Penmoss defaults apply. Tested in test/unit/theme-boot.test.ts.
(function () {
  try {
    // Any script's letters, as a custom font's family may have (T51 review): built here, in the
    // try, so a browser without Unicode property escapes keeps the stylesheet's defaults.
    var plain = new RegExp('^[\\p{L}\\p{N}\\s#,\'"._-]{1,200}$', 'u');
    var cached = JSON.parse(localStorage.getItem('penmoss.theme') || 'null');
    if (!cached || typeof cached.vars !== 'object' || cached.vars === null) return;
    var dark =
      cached.mode === 'dark' ||
      (cached.mode !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    var variant = dark ? 'dark' : 'light';
    var vars = cached.vars[variant];
    if (typeof vars !== 'object' || vars === null) return;
    var root = document.documentElement;
    for (var name in vars) {
      var value = vars[name];
      // Theme variables only, and plain values: colours, font stacks, a width.
      if (!/^--pm-[a-z0-9-]+$/.test(name) || typeof value !== 'string') continue;
      if (!plain.test(value)) continue;
      root.style.setProperty(name, value);
    }
    if (typeof cached.id === 'string' && /^[a-z0-9-]{1,48}$/.test(cached.id)) {
      root.setAttribute('data-theme', cached.id);
    }
    root.setAttribute('data-mode', variant);
    root.style.colorScheme = variant;
    var background = vars['--pm-bg'];
    if (typeof background === 'string' && /^#[0-9a-f]{6}$/i.test(background)) {
      var metas = document.querySelectorAll('meta[name="theme-color"]');
      for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', background);
    }
  } catch {
    // Blocked storage or a broken entry: the stylesheet's defaults apply.
  }
})();
