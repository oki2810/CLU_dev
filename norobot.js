// norobot.js: Disable search engine indexing and enforce nofollow on all links
(function() {
  if (!document.querySelector('meta[name="robots"]')) {
    var meta = document.createElement('meta');
    meta.name    = 'robots';
    meta.content = 'noindex, nofollow, noarchive, nosnippet, noimageindex, nocache';
    document.head.appendChild(meta);
  }

  // DOMContentLoaded 後、全リンクに rel="nofollow" を付与
  document.addEventListener('DOMContentLoaded', function() {
    var links = document.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) {
      links[i].setAttribute('rel', 'nofollow');
    }
  });
})();
