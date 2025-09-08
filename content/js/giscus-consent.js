(() => {
  const container  = document.getElementById('comment-thread');
  const btnLoad    = document.getElementById('giscus-load');
  const btnRevoke  = document.getElementById('giscus-revoke');
  const consentKey = 'apache_datafusion_giscus_consent';

  if (!container || !btnLoad || !btnRevoke) return;

  // Giscus configuration 
  // 
  // <script src="https://giscus.app/client.js"
  //     data-repo="apache/datafusion-site"
  //     data-repo-id="R_kgDOL8FTzw"
  //     data-category="Announcements"
  //     data-category-id="DIC_kwDOL8FTz84Csqua"
  //     data-mapping="title"
  //     data-strict="1"
  //     data-reactions-enabled="1"
  //     data-emit-metadata="0"
  //     data-input-position="bottom"
  //     data-theme="light"
  //     data-lang="en"
  //     data-loading="lazy"
  //     crossorigin="anonymous"
  //     async>
  // </script>

  function injectGiscus() {
    // Avoid double-injection if already present
    if (document.querySelector('script[data-giscus]') ||
        container.querySelector('iframe.giscus-frame')) {
      btnLoad.hidden = true;
      btnRevoke.hidden = false;
      return;
    }

    btnLoad.disabled = true;

    const s = document.createElement('script');
    s.setAttribute('data-giscus', ''); // marker attribute to identify the script
    s.src = 'https://giscus.app/client.js';
    s.setAttribute('data-repo', 'apache/datafusion-site');
    s.setAttribute('data-repo-id', 'R_kgDOL8FTzw');
    s.setAttribute('data-category', 'Announcements');
    s.setAttribute('data-category-id', 'DIC_kwDOL8FTz84Csqua');
    s.setAttribute('data-mapping', 'title');
    s.setAttribute('data-strict', '1');
    s.setAttribute('data-reactions-enabled', '1');
    s.setAttribute('data-emit-metadata', '0');
    s.setAttribute('data-input-position', 'bottom');
    s.setAttribute('data-theme', 'light');
    s.setAttribute('data-lang', 'en');
    s.setAttribute('data-loading', 'lazy');
    s.crossOrigin = 'anonymous';
    s.async = true;

    s.addEventListener('error', () => {
      btnLoad.disabled = false;
    });

    const observer = new MutationObserver(() => {
      if (container.querySelector('iframe.giscus-frame')) {
        btnLoad.hidden = true;
        btnRevoke.hidden = false;
        btnLoad.disabled = false;
        observer.disconnect();
      }
    });
    observer.observe(container, { childList: true, subtree: true });

    container.appendChild(s);
  }

  function removeGiscus() {
    container.querySelectorAll('iframe.giscus-frame').forEach((el) => el.remove());
    container.querySelectorAll('.giscus').forEach((el) => el.remove());
    document.querySelectorAll('script[data-giscus], script[src^="https://giscus.app"]').forEach((el) => el.remove());
    container.replaceChildren();

    btnLoad.hidden = false;
    btnLoad.disabled = false;
    btnRevoke.hidden = true;
  }

  btnLoad.addEventListener('click', () => {
    try { localStorage.setItem(consentKey, 'true'); } catch {}
    injectGiscus();
  });

  btnRevoke.addEventListener('click', () => {
    try { localStorage.removeItem(consentKey); } catch {}
    removeGiscus();
  });

  try {
    if (localStorage.getItem(consentKey) === 'true') {
      injectGiscus();
    }
  } catch {
    // Storage unavailable; require click each time.
  }
})();
