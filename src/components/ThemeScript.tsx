import Script from "next/script";

// Corre antes de que React hidrate: aplica la clase "dark" a <html> según lo
// guardado en localStorage (o la preferencia del sistema la primera vez) para
// que nunca haya un parpadeo del tema equivocado al cargar la página.
const THEME_INIT = `
(function () {
  try {
    var stored = localStorage.getItem("theme");
    var isDark = stored ? stored === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", isDark);
  } catch (e) {}
})();
`;

export default function ThemeScript() {
  return (
    // The lint rule assumes the Pages Router (`pages/_document.js`); for the
    // App Router, Next's own docs place `beforeInteractive` in the root
    // layout instead — this usage is correct, not a Pages/App mismatch.
    // eslint-disable-next-line @next/next/no-before-interactive-script-outside-document
    <Script id="theme-init" strategy="beforeInteractive">
      {THEME_INIT}
    </Script>
  );
}
