---
title: Open Design 0.24.0 — Runs You Can Trust
description: "A round of correctness fixes that make sure a run's status matches what actually happened — blocked, refused, or cleanly finished — plus the next step for the new Home, safer app updates, a broader model catalog, and finished French coverage."
---

### 🌟 Codename: *Runs You Can Trust*

🧭 **29 PRs · 12 contributors** — **0.24.0 makes sure what you see is what actually happened.** A run that finished cleanly used to get marked blocked by an unrelated flag; a turn the agent declined to run could show up as a red "failed" card instead of its real answer; a preview could render blank even though the page worked. None of that lies to you anymore. 🚀

## 🔥 Highlights

- 🧭 **A run's status finally matches what happened.** A cleanly finished task no longer gets marked blocked because of an unrelated flag, a turn the agent declined to run now shows up as its actual reply instead of a red "failed" card, and long runs stop dropping or truncating events under load. (#8350, #8322, #8170) Thanks @itscheems, @lefarcen.

- 🖼️ **Previews stop lying.** A snapshot-bridge bug made some real, working pages render as a blank preview. Now the preview shows what the page actually looks like. (#7125) Thanks @huynextlevel.

- 🔁 **Recovery keeps its receipts.** Reopen a chat after a crash, a fork, or a stale read, and the agent doesn't lose the plot: recovered outputs stop getting misattributed as manual edits, blocked verdicts survive a reload, planning-only turns keep their intent after a clarification, and a live strategy stays in the task that started it. (#8007, #8008, #8172, #8195, #8067, #8029) Thanks @app/open-design-crew, @lefarcen.

- 🏠 **Home keeps getting better.** Building on the 0.23.0 redesign, Home now defaults new work to Prototype (with a type switch right in the composer), keeps your project split steady across the hand-off, and answers an empty wallet before it gets in your way. (#8208, #8278, #8229, #8240) Thanks @Siri-Ray, @app/open-design-crew.

- 💬 **Chat gets more honest.** Unanswered questions collapse once the conversation moves on, run-failure copy matches the approved product language, and a card with malformed JSON hides instead of rendering garbage. (#8158, #8140, #8258, #8264) Thanks @app/open-design-crew, @lefarcen.

- 🚀 **Updates can't get stuck mid-swap.** The updater now hands the new payload to the running app atomically, so an interrupted update can't strand you on a half-installed build. (#8348) Thanks @PerishCode.

- 🤖 **More models, steadier agents.** The Novita AI model catalog grows, Copilot CLI detection now prefers the direct binary, and the automation CLI no longer throws before it even reads your subcommand. (#6327, #7974, #7612, #8066) Thanks @jax-novita, @tony-box, @johnkattenhorn, @app/open-design-crew.

- 🌐 **French coverage catches up.** Library, Memory, and the design-system flow are now fully translated. (#7756, #7906) Thanks @davezfr.

> 📥 **Download:** Release assets will be available from [Open Design 0.24.0](https://github.com/nexu-io/open-design/releases/tag/open-design-v0.24.0).

## 🔁 Changed

- Workspace subscriptions reset correctly when you switch profiles, and run snapshots now count manifest-backed artifacts instead of missing them. (#8020, #7586) Thanks @AmyShang-alt, @arccat-114.
- A daemon payload with an invalid shape now waits for the launcher to be ready instead of failing early, and cover-render deadlines are classified so late output gets cleaned up instead of lingering. (#7520, #8061) Thanks @lorenzozanee, @app/open-design-crew.

## 🙏 Thanks to everyone who shipped 0.24.0

@AmyShang-alt · @arccat-114 · @davezfr · @huynextlevel · @itscheems · @jax-novita · @johnkattenhorn · @lefarcen · @lorenzozanee · @PerishCode · @Siri-Ray · @tony-box
