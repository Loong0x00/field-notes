(() => {
  "use strict";

  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;

  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
        updateViaCache: "none",
      });
      await navigator.serviceWorker.ready;
      const paths = [window.location.pathname, "/style.css", "/site.js"];
      if (document.querySelector('script[src="/discussion.js"]')) paths.push("/discussion.js");
      registration.active?.postMessage({ type: "warm", paths });
    } catch {
      // The site remains fully functional when service workers are unavailable.
    }
  });
})();
