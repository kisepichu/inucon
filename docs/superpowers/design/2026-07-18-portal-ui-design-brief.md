# INUCON Portal — UI Design Brief

This is a **restyle brief**, not a feature spec. INUCON's portal frontend is fully built and functionally complete; every screen, state, and interaction below already exists in production React code. We need a cohesive visual design system applied on top — colors, type, spacing, component styling — with **zero changes to layout structure, copy, or functionality**. Please read this whole document before designing; it describes the exact data and states you need to mock up.

---

## 1. Product & tone

**INUCON** is a private, invitation-only ISUCON-style performance-tuning competition portal. Teams of developers each get one or more Linux VM "instances" (their competition server), run a benchmark tool against an instance to get a score, and compete on a live scoreboard. There's also an admin console for contest organizers to create teams, assign members, provision instances, and send invites.

- **Target users**: developers/engineers participating in or organizing a technical competition. Not a consumer audience — comfortable with tables, monospace IDs, IP addresses, status codes, logs.
- **Desired tone**: clean, technical, trustworthy developer-tool aesthetic — think GitHub, Vercel, or Linear dashboards. Confident and understated, not playful or marketing-flavored. Information density matters more than whitespace-heavy marketing layouts, but it should still feel calm and legible, not cramped.
- **Fixed brand facts** (do not change):
  - Dark header bar, background `#20232a`, white text — this already exists and should be preserved/refined, not replaced with a light header.
  - Light content area background `#fafafa`.
  - All UI copy is in **Japanese**. Typography must render Japanese text cleanly (appropriate line-height, no awkward font fallback). Some content is intentionally technical/monospace: IPs, instance names like `inucon-team3-1`, job IDs, log output.
  - Desktop-first (this is used at a desk during a competition) but must not visually break on a narrower viewport — tables should scroll horizontally rather than overflow the page.

---

## 2. Global shell

Present on every authenticated screen (`App.tsx`):

- **Header** (dark, `#20232a` background, full-width, flex row, wraps on narrow screens):
  - Left: contest name in bold, e.g. **INUCON 2026**, followed by its status in parentheses, e.g. `(running)`. If no contest exists yet, only "INUCON" shows (no status suffix).
  - Center/left-of-center: nav links — **Scoreboard** (path `/`), **Team** (path `/team`), and **Admin** (path `/admin`, only visible to admin users). Plain text links, currently unstyled for "active" state — you may add an active/current-page indicator since that's a pure styling addition, not a structural change.
  - Right: current user's display name (e.g. `犬山太郎`) plus a **logout** button.
- **Main content container**: centered, `max-width: 960px`, comfortable padding (currently `1.5rem`). All page content (h1/h2 headings, sections, tables, forms) lives inside this column.
- **Top-level states** (rendered in place of the whole app, no header):
  - **Loading** (initial auth check): plain "Loading..." text, centered feel is fine, should not flash unstyled.
  - **Auth error**: after a failed non-401 fetch of the current user — an error message: "読み込みに失敗しました。再読み込みしてください。" (uses the shared `.error` red-text style).
  - **Logged out**: renders the dedicated Login screen (see §3.1) instead of the header/nav.

---

## 3. Per-screen sections

### 3.1 Login

**Purpose**: entry point for unauthenticated visitors; the only way in is GitHub OAuth.

- Full-viewport-height centered column (class `login-page`): logo/title, one line of copy, one button.
- Content:
  - Heading: **INUCON**
  - Body text: "参加するには GitHub でログインしてください。" ("Please log in with GitHub to participate.")
  - Button: **GitHub でログイン** — on click does a full-page redirect to the GitHub OAuth start URL (not an SPA transition, so no in-page loading state to design beyond the button itself, maybe a hover/active state).
- States to design: default (only state — there's no error/loading variant on this screen today, but consider a subtle hover/focus state for the button since it's the single most important click target on the page).

### 3.2 Scoreboard

**Purpose**: public-to-participants live leaderboard, auto-refreshes every 10 seconds.

- Heading: **Scoreboard**
- One table, columns: **チーム** (team name), **最新スコア** (latest score), **最高スコア** (best score), **最終実行** (last-run timestamp, localized date/time or `-` if never run). Rows sorted by best score descending.
- Sample realistic data (keep consistent with other screens):

| チーム | 最新スコア | 最高スコア | 最終実行 |
|---|---|---|---|
| 隣の犬 | 8423 | 8423 | 2026/7/18 14:32:10 |
| パンダ本舗 | 6900 | 7650 | 2026/7/18 14:20:03 |
| たぬき道場 | - | - | - |

- States:
  - **Loading** (first fetch, before any data): plain "Loading..." text where the table will be.
  - **Error**: red alert text "スコアボードの取得に失敗しました。" (role="alert") replacing the whole page body — no partial/stale table shown on error.
  - **Success / steady state**: the table above; keep in mind it silently re-fetches every 10s (no visible spinner on refresh — design should tolerate a value quietly updating without a jarring flash).
  - **Empty**: a team can have `-` for score/date cells (never played) — style this as calm/neutral, not an error.

### 3.3 Team

**Purpose**: the primary "my team" workspace — manage this team's VM instances and run/review benchmark jobs. Visible to any logged-in member of a team (not admins-only).

Page heading: the team's own name, e.g. **隣の犬**.

If the logged-in user has no team, the entire page is replaced by one line: "チームに所属していません。管理者に問い合わせてください。" ("You don't belong to a team. Please contact an administrator.") — design this as a calm empty/blocked state, not an error.

**Section A — インスタンス (Instances)**

A table of this team's VM instances plus an "add instance" action underneath.

- Columns: **名前** (name — a composed label `inucon-team{teamNumber}-{index}` plus the private IP in parentheses, e.g. `inucon-team3-1 (10.100.3.11)`), **状態** (status badge + optional inline error line), and an action column with a **削除** (delete) button per row.
- Status badge values and their existing color mapping (already implemented, keep these semantics, restyle only the visual treatment):
  - `creating` — amber/yellow ("in progress")
  - `running` — green ("healthy")
  - `deleting` — amber/yellow ("in progress")
  - `deleted` — neutral gray
  - `failed` — red
- When an instance has a non-null `errorMessage` (e.g. `VM 起動に失敗しました(insufficient memory)`), show it as a small red line directly under the status badge, inside the same cell.
- Sample rows for team 隣の犬 (teamNumber 3):
  - `inucon-team3-1 (10.100.3.11)` — status `running`, delete button enabled
  - `inucon-team3-2 (10.100.3.12)` — status `creating`, delete button disabled (can't delete mid-provision)
  - `inucon-team3-3 (10.100.3.13)` — status `failed`, error line "VM 起動に失敗しました(メモリ不足)", delete button enabled
- Delete button is only enabled when instance status is `running` or `failed` (disabled for `creating`/`deleting`/`deleted`). Clicking delete shows a native confirm dialog ("inucon-team3-1 (10.100.3.11) を削除しますか?") before calling the API — you don't need to design a custom confirm modal, just the button's enabled/disabled visual states.
- Below the table: an **インスタンス追加** (add instance) button. It is disabled with an inline reason text shown beneath it when any of these apply (mutually exclusive, first match wins) — design a "disabled button + small reason caption" pattern:
  - "コンテストが開催されていません" (contest not running)
  - "インスタンス数が上限に達しています" (at quota — quota is a per-contest number, e.g. 2)
  - "処理中のインスタンスがあります" (an instance is already creating/deleting)
- Errors from the add/delete actions surface as red alert text below the button (e.g. "インスタンス数が上限に達しています", "ベンチ対象中は削除できません", "同じ index のインスタンスが既に存在します" — these are mapped from API error codes to Japanese messages).
- A separate red alert can also appear above the table if the instance list itself fails to load ("インスタンス一覧の読み込みに失敗しました").

**Section B — ベンチ実行 (Run benchmark)**

A form to enqueue a new benchmark job against one of this team's instances.

- A checkbox: "IP:port を直接入力する" (manually enter IP:port instead of picking an instance).
  - Unchecked (default): a `<select>` dropdown listing the team's instances by the same label format (`inucon-team3-1 (10.100.3.11)`).
  - Checked: two plain text inputs, placeholders **IP** and **port** (port defaults to `80`).
- Submit button: **実行** (Run). Disabled (with a visible reason line beneath, same pattern as instance-add) when:
  - "コンテストは開催されていません" (contest not running)
  - "既に実行中のジョブがあります" (a job for this team is already `queued` or `running` — only one at a time)
  - "インスタンスを選択してください" (no instance selected, dropdown mode only)
- On submit, button shows a busy/submitting state briefly; on failure a red alert line appears below the form with the raw error tag or a fallback "実行に失敗しました".

**Section C — ジョブ履歴 (Job history)**

A table of this team's past/current benchmark jobs.

- Columns: **状態** (status: `queued` | `running` | `finished` | `canceled` | `failed`), **スコア** (score, integer or `-`), **時刻** (enqueued timestamp).
- Every row is clickable (whole `<tr>`, cursor pointer, hover highlight, keyboard-operable with visible focus — it's `role="link"` with an aria-label like "ジョブ詳細: {id}") and navigates to the Job Detail screen.
- Sample rows:
  - `running` / `-` / 2026/7/18 15:02:11
  - `finished` / 8423 / 2026/7/18 14:32:10
  - `failed` / 0 / 2026/7/18 14:10:44
  - `queued` / `-` / 2026/7/18 15:05:00
- Status here should ideally reuse the same badge component/coloring language as instance status badges even though the literal values differ (queued/running/finished/canceled/failed vs creating/running/deleting/deleted/failed) — e.g. queued=neutral/amber, running=amber/blue "in progress", finished=green "success", canceled=neutral gray, failed=red.

### 3.4 Admin

**Purpose**: contest-organizer console — visible only to admin users, for setting up the contest, teams, members, invites, and instances. It's a single long page of stacked sections, each a self-contained form + list.

Page heading: **Admin**. A shared message area at the top: on any successful action a plain "OK" text appears; on failure a red alert with the API's error tag or a fallback "操作に失敗しました".

**Section — コンテスト (Contest)**
- Shows current status: "状態: running" (or `preparing`, `finished`, or "未作成" if no contest exists yet).
- Two buttons: **開始** (Start) — enabled only when a contest exists and its status is `preparing`; **終了** (Finish) — enabled only when status is `running`. Both disabled otherwise (no separate reason text here, just disabled state).

**Section — チーム作成 (Create team)**
- Form: text input **チーム名** (team name, e.g. "隣の犬"), text input **チーム番号(1-254)** (team number, e.g. `3`), submit button **作成** (Create).

**Section — メンバー割当 (Assign members)**
- Form: `<select>` **チームを選択** (choose team, listing all teams by name), text input placeholder "githubLogin をカンマ区切りで入力" (comma-separated GitHub logins, e.g. `inu-taro, nekoyama`), submit button **割当** (Assign). This *replaces* the full member list for that team (not additive) — worth a subtle "this overwrites the list" affordance if you want, but not required.

**Section — 招待 (Invite)**
- A `<select>` **チームを選択** (separate from the one above, drives which team's invite list shows below).
- A form (class `invite-form`): text input **githubLogin**, email input **email(Access ログイン用)** ("email, for Access login" — Cloudflare Access), submit button **招待** (Invite). Submit disabled while in-flight or when no team is selected.
- On error: red alert with the error tag or fallback "招待に失敗しました".
- On success, an **招待結果カード** (invite result card, class `invite-result` — bordered box, currently `max-width: 420px`) appears showing:
  - "ポータル: 即時割当(既にログイン済み)" or "ポータル: 招待作成(未ログイン)" (portal outcome: assigned immediately because the user already logged in once, vs. a pending invite created for a user who hasn't logged in yet)
  - "Access: OK" or "Access: 失敗(<error code>)" (whether the Cloudflare Access policy update succeeded)
  - A bullet list of per-instance SSH key injection results, one line each: `{instanceId}: OK` or `{instanceId}: 失敗(<error code>)`
  - If there are warnings (e.g. a teammate has no email on file so couldn't be added to Access), a separate amber/warning-colored bullet list below, e.g. "githubLogin: nekoyama の email が未登録のため Access に追加できませんでした"
- Below that: **招待中一覧** (pending invites) heading + table, columns **githubLogin**, **email**, **招待日時** (invited-at timestamp). Sample row: `nekoyama` / `nekoyama@example.com` / 2026/7/18 13:00:00.

**Section — インスタンス登録 (Register instance)** — this is the *admin* raw ledger-entry form (distinct from the self-service add button on the Team page).
- Form: `<select>` **チームを選択**, text input **index** (e.g. `1`), text input **privateIp** (e.g. `10.100.3.11`), submit button **登録** (Register).

**Section — チーム一覧 (Team list)**
- One block per team, each showing:
  - Sub-heading: team name + team number, e.g. **隣の犬 (#3)**
  - A line: "メンバー: inu-taro, nekoyama" (comma-joined GitHub logins, or `-` if empty)
  - A bullet list of that team's instances, each line formatted `inucon-team3-1 (10.100.3.11)` plus an inline **削除** (delete) button (no disabled-state gating shown here — any instance can be targeted for deletion from this admin view).
- Sample teams to mock up (reuse across the page for consistency):
  1. **隣の犬 (#3)** — members: inu-taro, nekoyama — instances: `inucon-team3-1 (10.100.3.11)`, `inucon-team3-2 (10.100.3.12)`
  2. **パンダ本舗 (#1)** — members: panda_taro — instances: `inucon-team1-1 (10.100.1.11)`
  3. **たぬき道場 (#7)** — members: tanuki_dev1, tanuki_dev2 — instances: (empty list)

### 3.5 Job Detail

**Purpose**: drill-down view for a single benchmark job, reached by clicking a row in the Team page's job history table. Route `/jobs/:id`.

- Heading: **ジョブ詳細** (Job Detail).
- A definition list (`<dl>`) of three fields:
  - **状態** (status) — one of `queued`/`running`/`finished`/`canceled`/`failed`, same badge styling family as elsewhere.
  - **スコア** (score) — integer or `-`.
  - **エラー** (error message) — free text or `-`.
- A **ログ** (log) heading followed by a `<pre>` block containing the full raw benchmark log — currently styled dark (`#111` background, light `#eee` text, monospace, wraps long lines, horizontally scrollable as a fallback). This should stay a dark "terminal" block even inside your otherwise light-content design — that dark/light contrast is intentional and expected in dev tools.
  - Sample log content (multi-line, keep it realistic):
    ```
    [14:32:05] start bench: target=10.100.3.11:80
    [14:32:06] GET / 200 12ms
    [14:32:06] POST /login 200 45ms
    [14:32:09] warmup complete, starting load
    [14:32:10] score=8423 passed=true
    [14:32:10] finished
    ```
- States:
  - **Loading**: plain "Loading..." before first fetch.
  - **Error**: red alert full-page replacing content, e.g. "ジョブの取得に失敗しました。"
  - **Polling / in-progress**: while status is `queued` or `running`, the page silently re-fetches every 5 seconds (faster than the Team page's job list) — the log block should be able to visually accommodate a log that's still growing/updating without layout jank; consider a subtle "live" affordance (not required, but welcome) since this is effectively a tailing log.
  - **Finished / terminal states** (`finished`/`canceled`/`failed`): static, no more polling — log and score are final.

---

## 4. Component inventory

Design these as a small reusable set, applied consistently across all five screens:

1. **Status badge** — small pill/chip, colored by semantic state. Two families of values share the same visual language but are textually distinct:
   - Instance statuses: `creating`, `running`, `deleting`, `deleted`, `failed`
   - Bench job statuses: `queued`, `running`, `finished`, `canceled`, `failed`
   - Shared semantics: amber = in-progress/transitional, green = healthy/success, red = failed/error, neutral gray = terminal/inactive (deleted, canceled).
2. **Data table** — used on Scoreboard, Team (instances, jobs), Admin (invites); needs a clean header row, readable borders/zebra or hover states, and at least one variant with clickable rows (hover + focus-visible affordance, since job history rows navigate on click/Enter/Space).
3. **Form** — label + input/select + submit button, currently narrow (`max-width: 420px`) single-column stacked layout. Used repeatedly on Team (bench run) and Admin (create team, assign members, invite, register instance).
4. **Buttons** — need at least three intents:
   - **Primary/action** (実行, 作成, 割当, 登録, 招待, インスタンス追加, 開始, 終了, GitHub でログイン)
   - **Secondary** (logout)
   - **Danger** (削除 / delete — instance delete buttons on Team and Admin)
   - All buttons need a clear disabled visual state, since disabled-with-reason is a recurring pattern (see Team page).
5. **Alert/error banner** — inline red text with `role="alert"`, used for form-level errors, page-level load errors, and per-field validation-style reasons. Needs a variant for a full-page-replacing error (Scoreboard/JobDetail fetch failure) and a smaller inline one (form errors).
6. **Disabled-reason caption** — small helper text shown under a disabled button explaining why (e.g. "コンテストは開催されていません"). Not an error — should read as neutral/informational, not alarming.
7. **Result card** (invite result) — bordered box (~420px) summarizing a multi-step operation's outcome across 3 sub-results (portal assignment, Access policy, per-instance SSH key injection) plus an optional warnings list in amber.
8. **Code/log block** — dark `<pre>` panel for raw benchmark logs; monospace, wraps, scrolls horizontally as fallback.
9. **Nav link** — header navigation item (Scoreboard/Team/Admin), on a dark background; needs a legible default + hover + current-page state.

---

## 5. What we want back

Please produce:

**(a) A small design system**
- Color palette: header dark (keep `#20232a` or a refined near-neighbor), light content background (keep `#fafafa` or a refined near-neighbor), text colors, link colors, and the badge color set for each status (amber/green/red/gray as above) — must have adequate contrast in both header and content-area contexts.
- Typography scale: a system-ui/sans-serif stack that renders Japanese well (no obvious tofu/fallback issues), a small heading scale (h1/h2/h3), body size, and a monospace choice for IDs/IPs/log content.
- Spacing scale and border-radius scale (small, consistent set — this app currently uses ad hoc rem values like `0.25rem`/`0.5rem`/`1rem`/`1.5rem`; pick a coherent scale).
- Badge color mapping table (explicit hex values per status, for both instance and job status vocabularies).

**(b) Styled mockups of each screen**, covering the states enumerated above:
- Login (default state)
- Scoreboard: loading, error, and populated/success states
- Team: with populated instances (mixed statuses including one `failed` with an error line), the add-instance disabled state with reason text, the bench-run form disabled state with reason text, and a populated job history table
- Admin: populated team list, the invite result card (with a warning present), and the pending-invites table
- JobDetail: populated with log content, and the error state

**(c) Delivery format**: self-contained HTML + CSS (a single stylesheet we can adapt directly into `index.css`) — no build step, no external asset dependencies. We will hand-port your CSS into the existing React components ourselves; you do not need to produce React code.

**This is a restyle only.** Do not change what data is shown, add new fields, invent new screens/sections, alter copy/wording, or add features (e.g. don't add a settings screen or user avatars that don't exist today). Keep every existing interaction and disabled-state condition intact — only reskin them. The result must remain responsive: it targets desktop primarily, but tables must scroll horizontally inside their own container on narrow viewports rather than breaking page layout, and the header must wrap gracefully.

---

## 6. Constraints for the designer

- **Single global stylesheet**: everything ships as one `index.css`-equivalent file (plain CSS, no preprocessor-only features that plain CSS can't express, e.g. no unresolved SCSS variables).
- **Plain React + className**: the target codebase uses plain React functional components with `className` string attributes — no CSS-in-JS, no CSS Modules, no Tailwind or other utility framework, no new npm dependencies. Design with plain class selectors in mind.
- **Japanese text**: must render correctly and legibly at all sizes used (headings, table cells, buttons, small caption text).
- **Preserve existing class-name semantics where practical** — these class names already exist in the codebase and carry meaning; reuse/restyle them rather than inventing a parallel naming scheme wherever it's a natural fit:
  - `app-header` — the dark top header bar
  - `status-badge` plus `status-creating` / `status-running` / `status-deleting` / `status-deleted` / `status-failed` — badge base + per-status color modifiers
  - `error` — inline red error/alert text
  - `invite-result` — the bordered invite-outcome card (and its nested `.warnings` list)
  - `login-page` — the full-height centered login layout
  - `clickable` — applied to table rows that navigate on click (job history)
- New class names are welcome for anything not already named (e.g. buttons, forms, generic table wrapper) — just keep naming consistent and CSS-only (no ids required for styling, no inline styles as the delivery mechanism — actual CSS rules only).
