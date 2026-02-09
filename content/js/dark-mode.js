// Dark Mode Toggle Functionality
(function() {
    'use strict';
    
    // Get the current theme from localStorage or default to 'light'
    function getTheme() {
        return localStorage.getItem('theme') || 'light';
    }
    
    // Set the theme immediately
    function setTheme(theme) {
        // Use requestAnimationFrame for smooth, immediate visual update
        requestAnimationFrame(() => {
            document.documentElement.setAttribute('data-theme', theme);
        });
        localStorage.setItem('theme', theme);
    }
    
    // Toggle between light and dark themes
    function toggleTheme() {
        const currentTheme = getTheme();
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        setTheme(newTheme);
    }
    
    // Initialize theme on page load (before DOM renders to prevent flash)
    function initTheme() {
        const theme = getTheme();
        // Set immediately, before any rendering
        document.documentElement.setAttribute('data-theme', theme);
    }
    
    // Set up the toggle button
    function setupToggleButton() {
        const toggleButton = document.getElementById('dark-mode-toggle');
        if (toggleButton) {
            toggleButton.addEventListener('click', toggleTheme);
        }
    }
    
    // Initialize immediately to prevent flash
    initTheme();
    
    // Set up button when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupToggleButton);
    } else {
        setupToggleButton();
    }
})();
