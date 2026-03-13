(function() {
    'use strict';

    const root = document.documentElement;

    function getTheme() {
        return localStorage.getItem('theme') || 'light';
    }

    function setButtonState(theme) {
        const toggleButton = document.getElementById('dark-mode-toggle');
        if (toggleButton) {
            toggleButton.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
        }
    }

    function applyTheme(theme) {
        root.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);
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
