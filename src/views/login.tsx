import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { V2_TOKENS, V2_GLASS, V2_BTN, V2_FONT_FAMILY_SANS } from "./v2/tokens.js";

interface LoginProps {
  error?: boolean;
  csrfToken: string;
}

// Self-contained Soft Pastel login. No v1 CSS, no dark-theme toggle —
// light-only, matching the dashboard's `color-scheme: light`.
const STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: ${V2_FONT_FAMILY_SANS};
    color: ${V2_TOKENS.text};
    background:
      radial-gradient(900px 600px at 12% 8%, rgba(255,143,179,0.18), transparent 60%),
      radial-gradient(760px 520px at 88% 90%, rgba(94,200,192,0.16), transparent 60%),
      radial-gradient(640px 460px at 50% 50%, rgba(167,139,250,0.12), transparent 70%),
      ${V2_TOKENS.bg};
    -webkit-font-smoothing: antialiased;
  }
  .login-page {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .login-box {
    position: relative; width: 360px; max-width: 100%;
    padding: 34px 32px 30px; text-align: center;
    background: ${V2_GLASS.bg2};
    -webkit-backdrop-filter: ${V2_GLASS.blur}; backdrop-filter: ${V2_GLASS.blur};
    border: ${V2_GLASS.border};
    border-radius: ${V2_TOKENS.radiusXL}px;
    box-shadow: ${V2_GLASS.shadow};
  }
  .login-mark {
    width: 52px; height: 52px; margin: 0 auto 14px; border-radius: 50%;
    background: ${V2_BTN.primaryBg}; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 26px; font-weight: 800; letter-spacing: -0.04em;
    box-shadow: ${V2_BTN.primaryShadow};
    text-shadow: 0 1px 0 rgba(255,120,160,0.45);
  }
  .login-box h1 { margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.01em; }
  .login-sub { margin: 4px 0 22px; font-size: 13px; color: ${V2_TOKENS.textMute}; }
  .login-box form { display: flex; flex-direction: column; gap: 12px; }
  .login-box input[type=password] {
    width: 100%; padding: 11px 16px; font-size: 14px;
    font-family: ${V2_FONT_FAMILY_SANS};
    color: ${V2_TOKENS.text};
    background: ${V2_BTN.secondaryBg};
    border: ${V2_GLASS.border}; border-radius: 999px; outline: none;
    box-shadow: inset 0 2px 5px rgba(217,130,175,0.07), inset 0 1px 0 rgba(255,255,255,0.7);
  }
  .login-box input[type=password]:focus { border-color: rgba(255,143,179,0.55); }
  .login-box button {
    width: 100%; padding: 11px 18px; font-size: 14px; font-weight: 800;
    font-family: ${V2_FONT_FAMILY_SANS};
    color: #fff; cursor: pointer;
    background: ${V2_BTN.primaryBg};
    border: 1px solid rgba(255,138,179,0.45); border-radius: 999px;
    box-shadow: ${V2_BTN.primaryShadow};
    text-shadow: 0 1px 0 rgba(255,120,160,0.40);
    transition: transform 0.12s ease;
  }
  .login-box button:hover { transform: translateY(-1px); }
  .login-error {
    margin: 0 0 14px; font-size: 13px; font-weight: 700;
    color: ${V2_TOKENS.danger};
  }
`;

export const LoginPage: FC<LoginProps> = ({ error, csrfToken }) => {
  return (
    <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>もしもし — moshi.moshi</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@400;700;800&display=swap"
          rel="stylesheet"
        />
        {raw(`<style>${STYLE}</style>`)}
      </head>
      <body>
        <div class="login-page">
          <div class="login-box">
            <div class="login-mark">m</div>
            <h1>moshi.moshi</h1>
            <p class="login-sub">もしもし — wer ist da?</p>
            {error && <p class="login-error">Ungültiger Token</p>}
            <form method="post" action="/login">
              <input type="hidden" name="csrf" value={csrfToken} />
              <input
                name="token"
                type="password"
                placeholder="Token eingeben…"
                autofocus
                autocomplete="current-password"
              />
              <button type="submit">Anmelden</button>
            </form>
          </div>
        </div>
      </body>
    </html>
  );
};
