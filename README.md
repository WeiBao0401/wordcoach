# Word Coach (web)

Personal English vocabulary web app for iPhone (Home Screen web app). Look up words with Qwen on Alibaba Cloud Bailian, favorite them, and review with spaced repetition (FSRS-5).

- `index.html` + `js/`: the app (plain ES modules, no build step, no external CDN)
- `sw.js`: offline shell cache; bump `VERSION` here and in `js/config.js` on every release
- `check/`: device diagnostic page
- `data/`: offline base dictionary trimmed from [ECDICT](https://github.com/skywind3000/ECDICT) (MIT, see `data/ECDICT-LICENSE.txt`). Public word list only, no personal data.
- The API key is entered on the device and never stored in this repo. Word data lives only on the phone.
- FSRS formulas ported from [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs) (MIT).
