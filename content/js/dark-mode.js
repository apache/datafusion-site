(function() {
    'use strict';

    const root = document.documentElement;

    function getTheme() {
        try {
            return localStorage.getItem('theme') || 'light';
        } catch (e) {
            return 'light';
        }
    }

    function setButtonState(theme) {
        const toggleButton = document.getElementById('dark-mode-toggle');
        if (toggleButton) {
            toggleButton.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        }
    }

    function applyTheme(theme) {
        root.setAttribute('data-theme', theme);
        try {
            localStorage.setItem('theme', theme);
        } catch (e) {
            // Ignore storage errors; theme will not be persisted.
        }
        setButtonState(theme);
    }

    function toggleTheme() {
        applyTheme(getTheme() === 'dark' ? 'light' : 'dark');
    }

    function setupToggleButton() {
        const toggleButton = document.getElementById('dark-mode-toggle');
        if (toggleButton) {
            setButtonState(getTheme());
            toggleButton.addEventListener('click', toggleTheme);
        }
    }

    root.setAttribute('data-theme', getTheme());

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupToggleButton);
    } else {
        setupToggleButton();
    }
})();
