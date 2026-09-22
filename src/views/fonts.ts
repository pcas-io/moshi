// The two typefaces, served from this origin.
//
// Every page, the sign-in page included, used to fetch its fonts from Google:
// a request to a third party before anybody had signed in, and the reason a
// strict Content-Security-Policy was out of reach. They are files in
// public/fonts now (never base64 in the stylesheet), both under the SIL Open
// Font License, whose text lies next to them.
//
// Both are variable fonts: one file per subset carries every weight the
// pages use (Sora 400/600/700, JetBrains Mono 400/500/600). The ten hex
// characters in a name are the start of the file's SHA-256, so a file can be
// cached for a year: a new file is a new name (a test compares name and bytes).
//
// Subsets: latin and latin-ext, for both families. Sora has no others. Google
// also serves JetBrains Mono in cyrillic, cyrillic-ext, greek and vietnamese;
// those are left out on purpose. The interface is English, names are ASCII,
// and a payload in one of those scripts falls back to the system monospace
// for the letters concerned, which is readable. Adding a subset later is one
// file, one @font-face with Google's unicode-range, and its name in this list.

/** woff2 files in public/fonts, as the stylesheet names them. */
export const FONT_FILES = [
  "sora-latin-ext.8d9b4a4136.woff2",
  "sora-latin.3902474d3e.woff2",
  "jetbrains-mono-latin-ext.9c38cb2d0d.woff2",
  "jetbrains-mono-latin.2c32b9b3ee.woff2"
] as const;

export const FONT_FACE_CSS = `
@font-face {
  font-family: 'Sora';
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
  src: url(/fonts/sora-latin-ext.8d9b4a4136.woff2) format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'Sora';
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
  src: url(/fonts/sora-latin.3902474d3e.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
  src: url(/fonts/jetbrains-mono-latin-ext.9c38cb2d0d.woff2) format('woff2');
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: 'JetBrains Mono';
  font-style: normal;
  font-weight: 100 800;
  font-display: swap;
  src: url(/fonts/jetbrains-mono-latin.2c32b9b3ee.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
`;
