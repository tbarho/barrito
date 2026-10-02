(function () {
  var KEY = 'barrito:stars', TTL = 3600000, URL = 'https://api.github.com/repos/tbarho/barrito';
  var root = document.documentElement;
  function fmt(n) { return n >= 1000 ? (Math.round(n / 100) / 10).toString().replace(/\.0$/, '') + 'k' : String(n); }
  // social proof only once it helps: counts from 1 star, the hero pill from 10
  function render(n) {
    if (n < 1) return fail();
    root.classList.add('has-stars');
    root.classList.toggle('few-stars', n < 10);
    document.querySelectorAll('[data-stars]').forEach(function (el) {
      var c = el.querySelector('[data-count]');
      if (c) c.textContent = fmt(n);
      el.setAttribute('aria-label', n + ' stars on GitHub');
      el.setAttribute('role', 'img');
    });
  }
  function fail() { root.classList.remove('has-stars'); root.classList.add('no-stars'); }
  var cached = null;
  try { cached = JSON.parse(localStorage.getItem(KEY)); } catch (e) {}
  if (cached && typeof cached.n === 'number') render(cached.n);
  if (cached && Date.now() - cached.t < TTL) return;
  fetch(URL, { headers: { Accept: 'application/vnd.github+json' } })
    .then(function (r) { if (!r.ok) throw 0; return r.json(); })
    .then(function (d) {
      if (typeof d.stargazers_count !== 'number') throw 0;
      render(d.stargazers_count);
      try { localStorage.setItem(KEY, JSON.stringify({ n: d.stargazers_count, t: Date.now() })); } catch (e) {}
    })
    .catch(fail);
})();
