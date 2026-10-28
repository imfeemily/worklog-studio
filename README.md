# Worklog Studio

แอปบน macOS สำหรับตรวจสอบและบันทึกเวลาทำงานลง Jira Cloud ผ่านหน้าเว็บที่เปิดเฉพาะในเครื่อง (`127.0.0.1:8765`) รองรับหลายบอร์ด, สรุปเวลารายสัปดาห์, วันหยุดสถาบันการเงินตาม BOT และการจับคู่ประชุมจาก Mac Calendar กับ Jira task โดยผู้ใช้ตรวจสอบรายการก่อนกดบันทึกเสมอ

## ติดตั้งด้วย Homebrew

```bash
brew install imfeemily/tap/worklog-studio
worklog-studio
```

เปิด [http://127.0.0.1:8765/#settings](http://127.0.0.1:8765/#settings) เพื่อตั้งค่า Jira ของคุณเอง หยุดแอปด้วย `Ctrl+C` ใน Terminal ที่รันอยู่ หากพอร์ต `8765` ถูกใช้งาน ให้หยุด Worklog Studio ตัวเดิมก่อนเปิดอีกตัว ดูคำสั่งอัปเดตและถอนการติดตั้งใน [README ของ Homebrew tap](packaging/homebrew-tap-README.md)

## เริ่มใช้งาน

1. ใน **ตั้งค่า Jira** กรอก URL เว็บไซต์ Jira เช่น `https://example.atlassian.net`, อีเมล, API token, เขตเวลา และ Board ID เช่น `9146` จาก URL ที่ลงท้ายด้วย `/boards/9146` (อย่าใส่ URL ของบอร์ดทั้งเส้นในช่อง Board ID) แล้วกดทดสอบการเชื่อมต่อ
2. เปิดหน้าบอร์ด กด **โหลดงานจากบอร์ด** เลือกการ์ด ระบุวันที่และเวลาที่ทำงานจริง ตรวจสอบรายการ แล้วกด **บันทึกลง Jira**
3. เปิด **สรุปรายสัปดาห์** เพื่อตรวจวันจันทร์–ศุกร์เทียบกับเป้าหมาย 8 ชั่วโมงต่อวัน โดยไม่นับวันหยุด BOT
4. หากต้องการลงเวลาจากประชุม ให้เปิด **Mac Calendar**, อนุญาตสิทธิ์ Calendar, เลือกปฏิทินของงาน และตรวจการจับคู่ Jira ก่อนส่ง; ปรับกฎการจับคู่ได้ในหน้าตั้งค่า

ข้อมูลตั้งค่าและประวัติการส่งเก็บไว้ที่ `~/Library/Application Support/Worklog Studio/` บนเครื่องของแต่ละคน การอัปเดตหรือถอนแอปผ่าน Homebrew ไม่ลบข้อมูลส่วนนี้ แต่ API token ถูกเก็บเป็นข้อความปกติในไฟล์ที่จำกัดสิทธิ์เฉพาะเจ้าของเครื่อง อย่าอัปโหลดไฟล์ตั้งค่าหรือประวัติขึ้น GitHub

ด้านล่างเป็นรายละเอียดการติดตั้งจาก source, ขั้นตอนออก release, วิธีใช้งาน และข้อจำกัดด้านความปลอดภัย

Local Web UI for Jira Cloud. **No CSV, no third-party packages, no extra server.** Requires Python 3.9+ with `zoneinfo` and Jira Cloud credentials. Only binds to `127.0.0.1:8765`.

## Setup on Mac

```bash
cd jira-bulk-worklog-mvp
python3 app.py
```

Open **http://127.0.0.1:8765** in a browser, choose **ตั้งค่า Jira**, and save your Jira site URL, email, API token, timezone, and optional Board IDs. Enter multiple IDs separated by commas (up to 10); all boards must belong to the configured Jira site. Use **ทดสอบค่าที่บันทึก** to check the saved credentials. Existing `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `WORKLOG_TIMEZONE` environment variables still work as fallback values; settings saved in the UI take precedence. An existing saved single `boardId` is loaded automatically.

On first launch, the app copies any existing `.jira-config.json`, `.worklog-ledger.jsonl`, and `.bot-holidays.json` into `~/Library/Application Support/Worklog Studio/`. It never deletes or overwrites the original files, and later launches keep the destination data. The local sync history is retained for duplicate protection. New settings and worklog records are written to the per-user location.

## Homebrew distribution (macOS)

The formula lives in a separate Homebrew **tap**. The intended source repository is `https://github.com/imfeemily/worklog-studio`; it needs source code and a release asset before other people can install it. The separate `imfeemily/homebrew-tap` repository also needs to be created. The app uses the Homebrew `python@3.14` dependency, while Mac Calendar also needs Xcode Command Line Tools (`xcode-select --install`) for the first helper build.

1. Build a release archive, source ZIP, Formula, and `dist/UPLOAD.txt`. All bundles use explicit file lists: no local Jira token, config, history, or BOT cache is included.

   ```bash
   python3 scripts/package_homebrew.py --github-repo imfeemily/worklog-studio
   ```

2. Extract `dist/worklog-studio-source-v0.1.0.zip` and upload the **contents** of its `worklog-studio/` folder to the source repository; GitHub does not unpack an uploaded ZIP into repository files. Then upload `dist/worklog-studio-0.1.0.tar.gz` as a release asset with tag `v0.1.0`. The generated formula already contains the exact release URL and SHA-256. For example, with a personal GitHub account that has write access:

   ```bash
   gh release create v0.1.0 dist/worklog-studio-0.1.0.tar.gz \
     --repo imfeemily/worklog-studio --title 'Worklog Studio 0.1.0' \
     --notes 'Initial Homebrew release'
   ```

3. Put `dist/homebrew-tap/Formula/worklog-studio.rb` into the repository-root `Formula/` directory and `dist/homebrew-tap/README.md` at the repository root of `https://github.com/imfeemily/homebrew-tap`. Users can then run:

   ```bash
   brew install imfeemily/tap/worklog-studio
   worklog-studio
   ```

   Open `http://127.0.0.1:8765/#settings` and enter each user's own Jira credentials and mapping rules. Stop the foreground server with Ctrl+C. Do not run two copies on port 8765.

Without `--github-repo` or `--source-url`, the generator uses a local archive URL and placeholder homepage for packaging checks only. Homebrew requires formulae to be installed from a tap, not from a standalone `.rb` path. Bump `VERSION` in `app.py` before each new release and regenerate both files. On upgrade, the application code changes inside Homebrew, but settings, sync history, BOT cache, and the compiled Calendar helper remain in `~/Library/Application Support/Worklog Studio/`. This machine's original project files are not deleted. A fresh Homebrew install on a Mac that has **not** previously migrated its old project-directory history needs to run the old `python3 app.py` once before switching, or copy those three data files into the per-user data directory without overwriting existing files. Mac Calendar may request access for the new helper bundle on first Homebrew use.

## Workflow

1. Find Board IDs in Jira board URLs (`/boards/123` or `rapidView=123`).
2. Enter one or more Board IDs separated by commas and click **โหลดงานจากบอร์ด**. The app reads `/rest/agile/1.0/board/{id}` and paginates `/rest/agile/1.0/board/{id}/issue` for each selected board. An Issue appearing on multiple boards is shown once, with all its board names.
   Reloading with additional boards keeps queued worklogs for issues still present; removing a board asks before dropping queued worklogs that no longer belong to the selected boards.
   If a selected board is missing or inaccessible, the app shows its ID and continues with boards that can be loaded. Submission uses only the successfully loaded Board IDs.
3. Filter and select issues, choose worklog date and default hours, click **เพิ่มงานที่เลือก**. **การส่งในวันที่เลือก** defaults to **ยังไม่ส่ง** using this app's sync history for the selected default date; choose **ทั้งหมด** or **ส่งแล้ว** to review or re-log a card. This does not prove that no worklog exists in Jira. The header checkbox selects or clears only issues currently shown by the filters; hidden selections remain selected. Add the same issue again if you worked on it on another date.
4. Adjust dates, hours and descriptions to match real work. Click **ตรวจสอบรายการ** to see totals by day.
5. Click **บันทึกลง Jira**, then verify results against Jira issue worklog history.

## Weekly worklog view

Open **สรุปรายสัปดาห์** (or `#weekly`) to read your actual Jira worklogs for a selected Monday–Sunday week. The report shows Monday–Friday separately and compares each non-holiday weekday with an 8-hour target. The weekly target adjusts for Bank of Thailand (BOT) financial-institution holidays; a BOT holiday has a zero-hour target and is labeled by name. Future weekdays are marked as upcoming rather than overdue. Weekend worklogs are shown separately and do not count toward the weekday target. Use the arrows or date picker to change weeks; reload after logging new work.

The **สัปดาห์ที่ลงเวลาไม่ครบ** list defaults to the latest 12 weeks of the selected Gregorian year; choose 4 weeks or the whole year when needed. It checks through yesterday (or December 31 for a past year) and groups weekdays with no worklog or fewer than eight hours by Monday–Sunday week. Today, weekends, and BOT holidays are excluded. Select a listed week to inspect its Jira worklogs. The app reads Jira for the chosen range in one date search, rather than making one search per week; a full year can take several minutes or exceed Jira's pagination limits. It never writes worklogs automatically.

Holiday dates are synchronized per year from the JSON model used by the [BOT financial-institution holiday page](https://www.bot.or.th/th/financial-institutions-holiday.html). Thai Buddhist years are converted to Gregorian dates; the per-year cache in `.bot-holidays.json` refreshes after 24 hours or when **ซิงก์วันหยุด BOT ใหม่** is clicked. If BOT is unavailable, a cached year is used with a stale warning. Without a cached year, the alert list fails closed rather than marking possible holidays as missing work; the weekly worklog view remains available but labels its targets provisional. BOT's calendar can include location-specific holidays and may differ from your company's policy. The alert list also assumes your employment covers the whole selected year and does not infer personal leave from Calendar events.

This report searches worklog dates across all Jira projects visible to your account, then reads each issue's worklogs and counts only entries authored by your Jira account in the configured timezone. It does not depend on saved Board IDs and does not create or fill worklogs. Jira permissions and search indexing determine what can be read; pagination or exceptionally busy issues can limit completeness.

## Sync history and duplicate protection

Open **ประวัติ Sync** (`#history`) to see the latest local status of each submitted or recognized worklog across board and Mac Calendar tasks. Board issues show how many entries the app has recorded as synced or found in Jira; Calendar events already sent are marked and cannot be selected again. A missing local record does **not** mean the task has no worklog in Jira. Pending rows remain browser-only until submitted.

Before every new POST, the app reads that issue's Jira worklogs for the selected day and current account. It skips a worklog with the same issue, local date, duration, and description, including one created manually or on another computer. Multiple genuine sessions on the same issue/day are allowed if their descriptions differ. If this Jira check fails, submission stops without writing that row. A successful write or existing Jira match is saved with its Jira worklog ID in `.worklog-ledger.jsonl`.

If a POST has an uncertain outcome, the row is marked **ต้องตรวจสอบ** and retries are blocked. On **ประวัติ Sync**, click **ตรวจรายการไม่แน่ชัดใน Jira**: matching worklogs become **บันทึกแล้ว**; if none is found, the row becomes **ไม่พบรายการตรงกัน** and can be submitted again after review. This check requires Jira read access and compares exact duration/description; edits or restricted worklogs can prevent a match. Inspect Jira manually before retrying if anything looks wrong. The local ledger is not a global transaction log and does not detect semantically identical entries with different descriptions.

## Mac Calendar meeting review

1. Add your company Microsoft 365/Exchange calendar to **Calendar.app** on this Mac and verify meetings are visible there. No Entra application, Microsoft password, or Graph token is required by this app.
2. Open **Mac Calendar** (`#calendar`). Click **อนุญาตให้อ่าน Calendar** and grant **Full Calendar Access** to **Worklog Studio Calendar Reader** in the macOS prompt. Apple offers no read-only permission for EventKit; this app only reads calendar data. If denied, re-enable it in **System Settings → Privacy & Security → Calendars**.
3. Select only your company calendar, choose a week, and click **ดึงประชุมจาก Mac**. The select-all checkbox includes every available calendar, potentially personal ones; review the selection before loading. Recurring instances are read from the selected calendar. Events dated on BOT financial-institution holidays are excluded from the review list, including holiday segments of multi-day events; the app reports how many it omitted. If the BOT source is unavailable and no cached year exists, loading stops rather than offering unverified dates. Canceled, declined, free, and blank/private-placeholder events are not proposed. All-day events without a clear leave title appear unselected and require you to choose a Jira card manually.
4. Review the suggested mapping. In **ตั้งค่า Jira → จับคู่ประชุมกับการ์ด Jira**, add, edit, delete, or reorder up to 30 rules. Each rule has a name, comma-separated title search terms, a Jira Issue Key or `/browse/KEY` URL, and an optional leave flag. The first matching rule wins; a separate editable fallback card handles other meetings. The initial rules retain the previous defaults: IT Delivery Alignment → `KNP-5`, leave → `KNP-46`, Sprint Ceremony → `KNP-49`, fallback → `KNP-50`. Previously saved four-card mappings are loaded into the new rules automatically without modifying local worklog history. Preview a title with the unsaved draft; saving validates Jira read access to every configured card. A busy/unavailable event is not automatically considered leave. Full-day events matching a leave rule propose eight hours per weekday; other full-day events need manual review. Timed events propose actual duration in minutes. Overlaps are flagged, not automatically reduced.
5. Tick only events you actually attended or leave actually taken. **ประวัติการส่ง** defaults to **ยังไม่ส่ง**; choose **ทั้งหมด** or **ส่งแล้ว** to review synced events. Changing this filter deselects events it hides. The review-table select-all checkbox selects only visible events still eligible to submit, not already synced or uncertain events. Adjust the issue, weekday, minutes, and Jira description, click **ตรวจสอบรายการ**, then explicitly confirm **บันทึกลง Jira**. Moving an event to a BOT holiday is rejected in preview and on submission. The app fetches the selected calendar again before submitting and verifies access to each target Jira issue. Calendar events are never modified.

**Today Sync** uses the currently selected calendars, refreshes local sync history, loads today's calendar and Jira totals, and selects up to 20 eligible meetings for one explicit confirmation and submission. It skips events already synced or uncertain, all-day events, meetings that have not ended, events needing manual Jira mapping, and events with warnings such as overlaps; BOT-holiday events never reach the review list. The confirmation shows each meeting's title, Jira issue, duration, the current Jira total, and how many events were skipped. Canceling keeps the selected rows visible without writing to Jira. Use the review table for skipped meetings or for more than 20 eligible events. If Jira history or worklog totals cannot be read, Today Sync does not submit.

The helper is compiled locally from `mac_calendar.swift` on first use (requires Xcode command-line Swift tools). Existing source installs keep using their `.mac-calendar-helper.app` to preserve macOS Calendar permission; new and Homebrew installs store it under `~/Library/Application Support/Worklog Studio/`. macOS grants Calendar access to this app, not Chrome or the Python server. Calendar names are not persisted; nothing is selected by default. Jira worklogs are written with your Jira token as in the manual workflow. The local ledger prevents re-sending the same calendar event from this machine; the Jira preflight check catches exact matching worklogs from elsewhere. Always inspect Jira's existing daily totals and history before submitting, especially after an uncertain network result. The Calendar review UI never auto-fills a day to eight hours.

EventKit does not provide a reliable private-event flag to this reader; only obvious private placeholders are suppressed. Do not select a personal calendar. Calendar sync may also change event identifiers, so the local duplicate guard is best-effort, not a substitute for checking Jira history.

## Safety and permissions

- Uses your Jira account and token, not an unattended shared service identity. Required permissions: Browse projects, Work on issues; time tracking enabled.
- Settings and history are stored under `~/Library/Application Support/Worklog Studio/` with owner-only permissions (directory `0700`, files `0600`). The original project-directory files remain as a migration backup and are ignored by Git. The API token is stored as plain text in the per-user config file; protect backups of this directory. The settings API only returns whether a token is present, never its value.
- Requests only from localhost; POST guarded with a same-session CSRF token. Do not expose this app via reverse proxy or shared network.
- POST to `/rest/api/3/issue/{key}/worklog?adjustEstimate=leave`, using ADF comment, seconds, and a timezone-aware start time at **09:00** of the chosen date (`WORKLOG_TIMEZONE`). Change the implementation if precise start times are needed. This is a start timestamp anchor, **not** calendar event reconstruction.
- Each submit re-fetches allowed issues from every selected board and validates membership against their union. Jira itself decides worklog creation permissions.
- After each successful write or uncertain POST, appends status and fingerprint to `.worklog-ledger.jsonl`. The app checks Jira for exact duplicates before posting, but **this is not globally idempotent**: changed descriptions, inaccessible worklogs, and ambiguous network failures still need review.
- Submits sequentially (200 ms gap); stops on first failed/uncertain result. It is not transactional and will not roll back already-created logs.
- Limit 100 new entries per batch, 10 selected boards, and 4,000 issues per board load. To scale use narrower board filters and more robust paging/rate-limit handling.
- The page holds draft rows only in memory: browser refresh loses unsent data. Contains no authentication layer beyond localhost; don't use on an untrusted machine.
- Designed for user-confirmed **actual** logged time, not fabricated timesheets.

## Quick test checklist

1. Run app without saved settings → the settings page should open; save a token, then use **ทดสอบค่าที่บันทึก** to check the connection.
2. Run with valid credentials, select two real Board IDs → verify issues from both boards appear and overlapping issues appear once; filter by key/status.
3. Select a permitted TEST issue, add one row, preview; check daily total.
4. Submit a **small genuine test worklog** and inspect Jira worklog details, author, date, timezone and estimate effects.
5. Submit unchanged row again → should show `skipped`; verify Jira has only one new entry.
6. Remove a test log via Jira if organizational policy permits (local ledger remains; don't re-use the exact same row without reconciling).
7. Simulate API error (permissions) and verify that remaining entries stop; check Jira before retrying.

## Cloud API references

- https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/
- https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-worklogs/
