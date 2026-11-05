# TODO List

This file tracks pending tasks for the gaggimate-mcp project.

---

## Pending

- [ ] **Test MCP resources on real device** - Verify `gaggimate://knowledge`, `gaggimate://coffees`, `gaggimate://user/setup`, and `gaggimate://user/grind-map` resources work correctly in Claude Desktop
- [ ] **Test new write tools on real device** - Verify `manage_coffee`, `manage_user_setup`, and `manage_grind_map` tools create/update files correctly during actual dialing sessions
- [x] **Re-zip agent skills** - Skills were updated to reference MCP resources; regenerated ZIP files for Claude Desktop upload _(Completed: 2026-02-23)_
- [ ] **Fix pre-existing test_diagnostics failures** - 2 mDNS-related tests fail when device is not on network; consider mocking or skipping
- [ ] **Knowledge deduplication — Final testing** - Phase 2-3 complete. GAGGIMATE_PROFILE_CREATION_GUIDE.md slimmed from 1113 → 130 lines (88% reduction). Agent-facing words: 29,828 → 27,869 (~1,960 word reduction). **Remaining: test agent quality with real conversations before PR to main.**

---

## Completed

- [x] **Local-first brewing workspace** - Added multi-machine cached history, recorded-target analysis and comparisons, filtered statistics, quick notes and historical setting suggestions, rich coffee/grinder catalogs with safe merges and native JSON exchange, manual brews/recipes, and profile browsing/import. Verified 100 real device shots, idempotent catch-up, browser workflows, 293 backend tests, 24 frontend tests, and macOS app/DMG builds; physical-device verification was read-only. _(Completed: 2026-10-25)_
- [x] **Gaggimate Studio native app** - Added Tauri/React/shadcn/AI Elements UI, real shot telemetry, complete MCP tool access, and verified the macOS app launch/shutdown _(Completed: 2026-10-25)_
- [x] **Subscription-backed visual barista** - Integrated PydanticAI with app-owned ChatGPT OAuth, AG-UI streaming, mutation approvals, and A2UI v1.0 candidate visuals; verified a real subscription-backed shot analysis with a chart and phase diagram _(Completed: 2026-10-25)_
- [x] **Bean and grind recorder** - Added persistent coffee catalog and per-shot snapshots, metadata-preserving automatic device sync with read-back verification; verified shot 99 with user-supplied Kenya/Kaffa and grind 10 _(Completed: 2026-10-25)_
- [x] **Set up project and MCP for OMP** - Installed locked dependencies, configured the project-local stdio server, and verified OMP knowledge resources plus a real-device shot read _(Completed: 2026-10-25)_
- [x] **MCP Resources implementation** - 6 read-only resources for knowledge files, coffee tracking, user setup, and grind map _(Completed: 2026-02-19)_
- [x] **Local data write tools** - `manage_coffee`, `manage_user_setup`, `manage_grind_map` MCP tools with markdown storage _(Completed: 2026-02-19)_
- [x] **Directory restructure** - `agent-knowledge/` → `knowledge/`, new `coffees/` and `user/` directories _(Completed: 2026-02-19)_
- [x] **Update instructions & skills** - All agent instructions and 5 skills updated to reference MCP resources and tools _(Completed: 2026-02-19)_
- [x] **Update README.md** - Documented new tools, resources, directory structure, and changelog _(Completed: 2026-02-19)_
- [x] **Test `select` action in `manage_profile`** - The new profile selection feature was implemented and tested with real device. _(Completed: 2026-02-06)_

