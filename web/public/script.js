/*
 * Limey V1 landing page script
 * Small progressive enhancements — everything works without JS too.
 */

(function () {
    "use strict";

    // Reflect the actual availability of the userscript on the install button
    const installBtn = document.getElementById("install-btn");

    if (installBtn) {
        fetch("/dist/LimeyV1.user.js", { method: "HEAD" })
            .then(res => {
                if (!res.ok) {
                    installBtn.textContent = "Build coming soon";
                    installBtn.removeAttribute("href");
                    installBtn.style.pointerEvents = "none";
                    installBtn.style.opacity = "0.6";
                }
            })
            .catch(() => {
                /* server unreachable — leave the link as-is */
            });
    }

    // Current year in the footer
    const footerYear = document.querySelector(".footer-year");
    if (footerYear) {
        footerYear.textContent = new Date().getFullYear();
    }

    // Status banner — filled by limebot when Discord rate limits are ongoing
    const banner = document.getElementById("status-banner");
    if (banner) {
        fetch("/v1/status")
            .then(res => res.json())
            .then(status => {
                if (status && status.active && status.message) {
                    banner.textContent = "⚠️ " + status.message;
                    banner.classList.remove("hidden");
                }
            })
            .catch(() => { /* status endpoint unreachable — no banner */ });
    }

    // "Plugin packed" feature — spotlight a random built-in plugin on every visit
    const featuredName = document.getElementById("featured-plugin-name");
    const featuredDesc = document.getElementById("featured-plugin-desc");
    if (featuredName && featuredDesc) {
        fetch("/plugins.json")
            .then(res => (res.ok ? res.json() : Promise.reject(new Error(res.status))))
            .then(plugins => {
                // Real, user-facing plugins only: named, not required internals
                const valid = plugins.filter(p =>
                    p && p.name && p.description && !p.required && !p.filePath.startsWith("_")
                );
                if (!valid.length) throw new Error("no plugins");
                const featured = valid[Math.floor(Math.random() * valid.length)];
                featuredName.textContent = featured.name;
                featuredDesc.textContent = featured.description;
            })
            .catch(() => { /* keep the static default tile */ });
    }
})();
