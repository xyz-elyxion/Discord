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
    const footer = document.querySelector(".footer p");
    if (footer) {
        footer.innerHTML = footer.innerHTML.replace("GPL-3.0", `GPL-3.0 &copy; ${new Date().getFullYear()}`);
    }
})();
