# 自动重置损坏启动 Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 启动发现根级或当前 Profile 的 `cordis.patch.yml` 无法解析或根节点不是列表时，自动将其重置为 `[]\n` 并重试启动。

**Architecture:** 在现有 `recoverStartupConfiguration` 循环中优先处理 `yaml-format` patch 问题；通过已有的 `repairStartupConfig`/`replaceRecoveryFile` 安全路径和原子替换机制写入空列表。`settings.yaml` 和其他非 YAML 格式问题继续走现有人工恢复流程。

**Tech Stack:** TypeScript、Node.js `fs/promises`、`yaml`、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-27-auto-reset-corrupt-patch-design.md`

## Global Constraints

- 仅自动处理 `.patch.yml` 文件的 `yaml-format` 问题。
- 自动写入精确内容 `[]\n`，然后重新扫描配置并返回 `retry`。
- 不自动修改 `settings.yaml`、模型地址、旧工作流或环境变量问题。
- 继续使用现有恢复路径校验、文件锁和原子替换，不扩大可写文件范围。
- 不尝试从备份、临时文件或损坏内容推断并恢复原配置。

## Review Focus

- 根级 `cordis.patch.yml` 损坏时应被重置，而不是误跳过或继续弹窗；测试归入 Task 1。
- `profiles/<profile>/cordis.patch.yml` 损坏时应被重置；测试归入 Task 1。
- `.patch.yml` 是合法 YAML 但根节点为 map 时应被重置；测试归入 Task 1。
- `settings.yaml` 的 YAML 根节点错误仍不应自动清空；测试归入 Task 1。
- 正常列表 patch 不应被改写；测试归入 Task 1。

---

### Task 1: 自动重置损坏的 Patch

**Files:**
- Modify: `src/main/recovery/startup-config-recovery.ts:40-83,232-240`
- Modify: `src/main/startup-config-recovery.ts:27-40`
- Test: `test/startup-config-recovery.test.ts`

**Interfaces:**
- Consumes: Existing `StartupConfigProblem`, `inspectStartupConfiguration`, `repairStartupConfig`, and `replaceRecoveryFile` APIs.
- Produces: `repairStartupConfig` accepts `yaml-format` problems for `.patch.yml` and writes `[]\n`; `recoverStartupConfiguration` automatically invokes that repair for patch YAML problems and retries without showing the manual dialog.

- [ ] **Step 1: Write the failing tests**

  Add tests to `test/startup-config-recovery.test.ts`:
  - `it('resets a corrupt root patch and retries without manual recovery')`: write `cordis.patch.yml` as `[broken`, call `recoverStartupConfiguration` with a `show` spy that fails if called, assert result is `retry`, file is `[]\n`, and a `.bak` backup contains `[broken`.
  - `it('resets a non-list Profile patch and retries without manual recovery')`: write `profiles/web/cordis.patch.yml` as `config: value`, assert the same behavior and backup preservation.
  - `it('does not auto-reset malformed settings.yaml')`: write malformed `settings.yaml`, call recovery with `show` returning Back, assert `show` was called and `settings.yaml` is unchanged.
  - `it('leaves a valid root patch unchanged')`: write `- id: valid\n`, inspect/recover, assert no problem and exact bytes unchanged.

- [ ] **Step 2: Run the focused tests to verify they fail**

  Run from `/Users/zstep/Documents/Codes/Pengtai/dsh-desktop`:
  `pnpm exec vitest run test/startup-config-recovery.test.ts --reporter=dot`

  Expected: the new root/Profile auto-reset tests fail because the current recovery flow opens the manual dialog and `repairStartupConfig` has no `yaml-format` repair.

- [ ] **Step 3: Implement the minimal repair contract**

  In `src/main/recovery/startup-config-recovery.ts`, make `analyzeYaml` attach a repair marker for patch-only YAML format problems, while leaving `settings.yaml` without a repair. Add a repair branch in `analyzeYaml` for `action === 'reset-patch'` that returns the exact `[]\n` text and marks the document changed; preserve the existing error analysis for all other formats.

  In `src/main/startup-config-recovery.ts`, before constructing/showing the dialog, detect `problem.kind === 'yaml-format'`, `problem.repair === 'reset-patch'`, and `problem.path.endsWith('.patch.yml')`. Stop the Host, call `repairStartupConfig`, record the backup through `ops.note`, mark the recovery as changed, and continue the loop. If the automatic repair fails, record the failure and fall through to the existing dialog so the original behavior remains safe.

- [ ] **Step 4: Run the focused tests to verify they pass**

  Run:
  `pnpm exec vitest run test/startup-config-recovery.test.ts --reporter=dot`

  Expected: all startup configuration recovery tests pass, including the new automatic reset cases.

- [ ] **Step 5: Run related desktop tests and type checks**

  Run:
  - `pnpm exec vitest run test/profile-boot-preflight.test.ts test/pengbao-provider-overlay.test.ts --reporter=dot`
  - `pnpm exec tsc --noEmit`

  Expected: all related tests pass and TypeScript reports no new errors. Report any pre-existing failures verbatim rather than hiding them.

- [ ] **Step 6: Review the diff and working tree**

  Run:
  - `git diff -- src/main/recovery/startup-config-recovery.ts src/main/startup-config-recovery.ts test/startup-config-recovery.test.ts docs/superpowers/specs/2026-11-27-auto-reset-corrupt-patch-design.md docs/superpowers/plans/2026-11-27-auto-reset-corrupt-patch.md`
  - `git status --short`

  Confirm only the intended recovery/test/design/plan files changed; do not commit unrelated existing changes.
