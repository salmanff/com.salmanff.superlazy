# marketing

Pages and snippets for freezr.info (the Orbit project `freezr2026`).

| file | what it is |
|---|---|
| `superlazy-story.html` | the three-step story (email → Slack hand-off → resolved). Inline styles only; copy the block between the COPY markers. |
| `appprofile-superlazy.html` | the `/appprofile/superlazy` page body. Embeds the story block verbatim; re-splice it if the story changes. |
| `appprofile.css` | styles for `/appprofile/*` pages (header, buttons, steps, story frame). Reusable for other apps. |
| `discover-snippet.html` | sidebar link + app card to add to `/discover`, linking to `/appprofile/superlazy`. |

## Publishing the profile page in Orbit

- Page `appprofile/superlazy.html`, with css_files `shared/common.css`, `shared/subpage.css`,
  `discover.css`, `appprofile.css` and js_files `shared/sidebar.js`.
- Upload `static/logo.png` as `images/superlazylogo.png`.
- Links on the page are absolute (`/discover`, `/home`, …) because it sits one folder down.
- Install links use `https://github.com/salmanff/com.salmanff.superlazy`. Change them if the public
  repo ends up elsewhere: the repo (and so its zip) must be named after the app id for install-from-URL.
