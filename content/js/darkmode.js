/**
 * Dark Mode Toggle Functionality for Apache DataFusion Blog
 */

(function() {
    'use strict';

    // Constants
    const THEME_KEY = 'datafusion-theme';
    const THEME_DARK = 'dark';
    const THEME_LIGHT = 'light';

    /**
     * Get the current theme from localStorage or system preference
     */
    function getStoredTheme() {
        return localStorage.getItem(THEME_KEY);
    }

    /**
     * Get the preferred theme based on system settings
     */
    function getPreferredTheme() {
        const storedTheme = getStoredTheme();
        if (storedTheme) {
            return storedTheme;
        }
        // Check system preference
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? THEME_DARK : THEME_LIGHT;
    }

    /**
     * Set the theme on the document
     */
    function setTheme(theme) {
        if (theme === THEME_DARK) {
            document.documentElement.setAttribute('data-theme', THEME_DARK);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
        localStorage.setItem(THEME_KEY, theme);
    }

    /**
     * Toggle between light and dark themes
     */
    function toggleTheme() {
        const currentTheme = getStoredTheme() || THEME_LIGHT;
        const newTheme = currentTheme === THEME_DARK ? THEME_LIGHT : THEME_DARK;
        setTheme(newTheme);
    }

    /**
     * Initialize theme on page load
     */
    function initTheme() {
        // Apply theme immediately to prevent flash
        setTheme(getPreferredTheme());

        // Add event listener to toggle button when DOM is ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', attachToggleListener);
        } else {
            attachToggleListener();
        }
    }

    /**
     * Attach click event listener to theme toggle button
     */
    function attachToggleListener() {
        const toggleButton = document.getElementById('theme-toggle');
        if (toggleButton) {
            toggleButton.addEventListener('click', function(e) {
                e.preventDefault();
                toggleTheme();
            });
        }
    }

    /**
     * Listen for system theme changes
     */
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
        if (!getStoredTheme()) {
            setTheme(e.matches ? THEME_DARK : THEME_LIGHT);
        }
    });

    // Initialize theme immediately
    initTheme();

})();
