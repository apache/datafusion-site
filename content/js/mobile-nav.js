(function () {
    function initMobileNav() {
        const toggler = document.querySelector('.navbar-toggler[data-bs-target]');
        if (!toggler) {
            return;
        }

        const targetSelector = toggler.getAttribute('data-bs-target');
        if (!targetSelector) {
            return;
        }

        const collapseElement = document.querySelector(targetSelector);
        if (!collapseElement) {
            return;
        }

        toggler.addEventListener('click', function () {
            const isExpanded = toggler.getAttribute('aria-expanded') === 'true';
            const nextExpanded = !isExpanded;

            toggler.setAttribute('aria-expanded', String(nextExpanded));
            toggler.classList.toggle('collapsed', !nextExpanded);
            collapseElement.classList.toggle('show', nextExpanded);
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMobileNav);
    } else {
        initMobileNav();
    }
})();
